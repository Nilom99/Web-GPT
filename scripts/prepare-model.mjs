#!/usr/bin/env node
/**
 * Downloads the pinned GGUF model and verifies its SHA-256 checksum.
 *
 * The model is a static asset of the site (served from the CDN) and is never
 * bundled into the Netlify Function ZIP. The serverless runtime downloads it
 * into its own cache directory when a request needs it.
 *
 * Usage:
 *   node scripts/prepare-model.mjs                 # -> dist/models
 *   node scripts/prepare-model.mjs --out <dir>     # -> <dir>
 *   node scripts/prepare-model.mjs --optional      # never fails the build
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FILENAME = 'Falcon-H1-Tiny-Multilingual-100M-Instruct.Q4_K_M.gguf';
const URL =
  'https://huggingface.co/mradermacher/Falcon-H1-Tiny-Multilingual-100M-Instruct-GGUF/resolve/main/' +
  FILENAME;
const SHA256 = 'f8f5c2f964511caf59abfa02b6b8a6867b9c429ef3366b5a3ac9d5eea79aa0f6';
const EXPECTED_BYTES = 73_895_104;

const args = process.argv.slice(2);
const optional = args.includes('--optional');
const outIndex = args.indexOf('--out');
const outDir = outIndex !== -1 && args[outIndex + 1] ? path.resolve(args[outIndex + 1]) : path.join(ROOT, 'dist', 'models');

async function sha256(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

async function isValid(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile() || stat.size !== EXPECTED_BYTES) return false;
    return (await sha256(filePath)) === SHA256;
  } catch {
    return false;
  }
}

async function download(dest) {
  const tmp = `${dest}.part`;
  await fsp.rm(tmp, { force: true }).catch(() => {});

  const response = await fetch(URL, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed with status ${response.status}`);
  }

  const out = fs.createWriteStream(tmp);
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        if (!out.write(value)) {
          await new Promise((resolve) => out.once('drain', resolve));
        }
      }
    }
    await new Promise((resolve, reject) => {
      out.end((err) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    out.destroy();
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }

  if (!(await isValid(tmp))) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw new Error('Checksum verification failed for the downloaded model');
  }

  await fsp.rename(tmp, dest);
}

async function main() {
  await fsp.mkdir(outDir, { recursive: true });
  const dest = path.join(outDir, FILENAME);

  if (await isValid(dest)) {
    console.log(`[prepare-model] model already present and verified: ${dest}`);
    return;
  }

  // Reuse a previously verified local copy when available.
  const localCandidates = [
    path.join(ROOT, '.cache', 'webgpt', 'models', FILENAME),
    path.join(ROOT, 'models', FILENAME),
  ];
  for (const candidate of localCandidates) {
    if (candidate === dest) continue;
    if (await isValid(candidate)) {
      await fsp.copyFile(candidate, dest);
      console.log(`[prepare-model] copied verified model from ${candidate}`);
      return;
    }
  }

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await download(dest);
      console.log(`[prepare-model] model downloaded and verified: ${dest}`);
      return;
    } catch (err) {
      lastError = err;
      console.warn(`[prepare-model] attempt ${attempt} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (optional) {
    console.warn('[prepare-model] could not prepare the model asset; continuing without it.');
    return;
  }
  throw lastError instanceof Error ? lastError : new Error('Unable to prepare the model asset');
}

main().catch((err) => {
  console.error(`[prepare-model] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
