import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MODEL_CONFIG, RUNTIME_CONFIG, getModelCacheDir } from '../backend/config';
import {
  cleanupPartialDownloads,
  computeFileSha256,
  downloadModelToCache,
  ensureModelReady,
  findMissingRuntimeLibraries,
  isValidModelFile,
  isValidRuntimeDir,
  resolveRuntimeDir,
} from '../backend/model/loader';

test('bundled llama.cpp runtime contains every required shared library', async () => {
  const dir = await resolveRuntimeDir();
  assert.ok(await isValidRuntimeDir(dir));

  for (const file of RUNTIME_CONFIG.requiredFiles) {
    const stat = await fsp.stat(path.join(dir, file));
    assert.ok(stat.isFile(), `missing runtime file: ${file}`);
    assert.ok(stat.size > 1024, `runtime file looks truncated: ${file}`);
  }

  const binary = path.join(dir, RUNTIME_CONFIG.binaryName);
  const mode = (await fsp.stat(binary)).mode;
  assert.ok(mode & 0o111, 'runtime binary must be executable');
});

test('runtime shared libraries resolve on this platform', async () => {
  const dir = await resolveRuntimeDir();
  const missing = await findMissingRuntimeLibraries(dir);
  assert.deepEqual(missing, [], `unresolved shared libraries: ${missing.join(', ')}`);
});

test('a corrupt model file never passes checksum verification', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'webgpt-test-'));
  const fake = path.join(dir, MODEL_CONFIG.filename);
  await fsp.writeFile(fake, 'not a real gguf file');
  assert.equal(await isValidModelFile(fake), false);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('model download verifies the SHA-256 checksum and caches the file', async () => {
  const cacheDir = getModelCacheDir();
  const cachePath = path.join(cacheDir, MODEL_CONFIG.filename);

  if (!fs.existsSync(cachePath)) {
    // Downloads the pinned model and verifies it before it is accepted.
    const downloaded = await downloadModelToCache();
    assert.equal(downloaded, cachePath);
  }

  assert.equal(await isValidModelFile(cachePath), true);
  assert.equal(await computeFileSha256(cachePath), MODEL_CONFIG.sha256);

  const stat = await fsp.stat(cachePath);
  assert.equal(stat.size, MODEL_CONFIG.expectedBytes);
});

test('partial downloads are cleaned up', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'webgpt-partial-'));
  await fsp.writeFile(path.join(dir, 'model.gguf.part'), 'partial');
  await cleanupPartialDownloads(dir);
  const entries = await fsp.readdir(dir);
  assert.deepEqual(entries, []);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('ensureModelReady returns a verified model and a usable runtime', async () => {
  const assets = await ensureModelReady();
  assert.equal(assets.sha256, MODEL_CONFIG.sha256);
  assert.equal(assets.sizeBytes, MODEL_CONFIG.expectedBytes);
  assert.ok(fs.existsSync(assets.modelPath));
  assert.ok(fs.existsSync(assets.binaryPath));
  assert.ok(await isValidRuntimeDir(assets.libDir));
});
