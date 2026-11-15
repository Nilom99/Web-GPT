import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  MODEL_CONFIG,
  RUNTIME_CONFIG,
  getBundledModelPaths,
  getBundledRuntimeDirs,
} from '../config';

const execFileAsync = promisify(execFile);

export type InternalLoadState = 'uninitialized' | 'loading' | 'ready' | 'error';

export interface PublicModelStatus {
  status: 'loading' | 'ready' | 'error';
  label: 'Loading...' | 'Ready' | 'Unavailable';
  ready: boolean;
}

export interface ResolvedAssets {
  modelPath: string;
  binaryPath: string;
  libDir: string;
  sha256: string;
  sizeBytes: number;
}

let state: InternalLoadState = 'uninitialized';
let resolvedAssets: ResolvedAssets | null = null;
let initPromise: Promise<ResolvedAssets> | null = null;

export function getPublicModelStatus(): PublicModelStatus {
  if (state === 'ready' && resolvedAssets) {
    return { status: 'ready', label: 'Ready', ready: true };
  }
  if (state === 'error') {
    return { status: 'error', label: 'Unavailable', ready: false };
  }
  return { status: 'loading', label: 'Loading...', ready: false };
}

export function getInternalLoadState(): InternalLoadState {
  return state;
}

export async function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function isValidModelFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile() || stat.size !== MODEL_CONFIG.expectedBytes) {
      return false;
    }
    const sha = await computeFileSha256(filePath);
    return sha === MODEL_CONFIG.sha256;
  } catch {
    return false;
  }
}

async function isValidRuntimeDir(dir: string): Promise<boolean> {
  try {
    const binPath = path.join(dir, RUNTIME_CONFIG.binaryName);
    const binStat = await fsp.stat(binPath);
    if (!binStat.isFile() || binStat.size < 10_000) {
      return false;
    }
    // Verify shared libraries are present and not truncated
    const libLlama = path.join(dir, 'libllama.so.1');
    const libStat = await fsp.stat(libLlama);
    if (libStat.size < 1_000_000) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function downloadFileToPath(url: string, destPath: string): Promise<void> {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.part.${process.pid}`;
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch required asset (${response.status})`);
  }

  const writer = fs.createWriteStream(tmpPath);
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        if (!writer.write(value)) {
          await new Promise<void>((resolve) => writer.once('drain', resolve));
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      writer.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    await fsp.rename(tmpPath, destPath);
  } catch (err) {
    writer.destroy();
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

async function resolveModelPath(): Promise<string> {
  for (const candidate of getBundledModelPaths()) {
    if (await isValidModelFile(candidate)) {
      return candidate;
    }
  }

  // Serverless / ephemeral /tmp hydration when local bundled file is absent or truncated
  const cachePath = path.join('/tmp', 'webgpt', 'models', MODEL_CONFIG.filename);
  const originBase = process.env.URL || process.env.APP_URL;
  const candidateUrls = originBase
    ? [`${originBase.replace(/\/+$/, '')}/models/${MODEL_CONFIG.filename}`, MODEL_CONFIG.url]
    : [MODEL_CONFIG.url];

  let lastError: unknown;
  for (const url of candidateUrls) {
    try {
      await downloadFileToPath(url, cachePath);
      if (await isValidModelFile(cachePath)) {
        return cachePath;
      }
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Unable to verify local inference asset checksum.');
}

async function resolveRuntimeDir(): Promise<string> {
  for (const candidate of getBundledRuntimeDirs()) {
    if (await isValidRuntimeDir(candidate)) {
      await fsp.chmod(path.join(candidate, RUNTIME_CONFIG.binaryName), 0o755).catch(() => {});
      return candidate;
    }
  }

  // Hydrate minimal runtime into /tmp if workspace binaries were absent or truncated
  const targetDir = path.join('/tmp', 'webgpt', 'runtime', 'llama');
  const extractTmp = path.join('/tmp', 'webgpt', 'runtime-extract');
  const archivePath = path.join('/tmp', 'webgpt', 'llama-bin.tar.gz');

  await fsp.mkdir(targetDir, { recursive: true });
  await fsp.mkdir(extractTmp, { recursive: true });
  await downloadFileToPath(RUNTIME_CONFIG.archiveUrl, archivePath);
  await execFileAsync('tar', ['-xzf', archivePath, '-C', extractTmp]);

  const extractedSubdir = path.join(extractTmp, `llama-${RUNTIME_CONFIG.releaseTag}`);
  const needed = [RUNTIME_CONFIG.binaryName, ...RUNTIME_CONFIG.requiredLibs];
  for (const file of needed) {
    const src = path.join(extractedSubdir, file);
    const dst = path.join(targetDir, file);
    await fsp.copyFile(src, dst);
  }
  // Ensure soname symlinks exist
  for (const base of ['libllama', 'libllama-common', 'libggml', 'libggml-base']) {
    const linkPath = path.join(targetDir, `${base}.so`);
    await fsp.rm(linkPath, { force: true }).catch(() => {});
    await fsp.symlink(`${base}.so.1`, linkPath).catch(() => {});
  }
  await fsp.chmod(path.join(targetDir, RUNTIME_CONFIG.binaryName), 0o755);
  await fsp.rm(extractTmp, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(archivePath, { force: true }).catch(() => {});

  if (!(await isValidRuntimeDir(targetDir))) {
    throw new Error('Failed to initialize inference runtime.');
  }
  return targetDir;
}

export async function ensureModelReady(): Promise<ResolvedAssets> {
  if (state === 'ready' && resolvedAssets) {
    // Re-check file presence in case ephemeral storage was wiped
    if (fs.existsSync(resolvedAssets.modelPath) && fs.existsSync(resolvedAssets.binaryPath)) {
      return resolvedAssets;
    }
    state = 'uninitialized';
    resolvedAssets = null;
  }

  if (initPromise) {
    return initPromise;
  }

  state = 'loading';
  initPromise = (async () => {
    try {
      const [modelPath, libDir] = await Promise.all([resolveModelPath(), resolveRuntimeDir()]);
      const binaryPath = path.join(libDir, RUNTIME_CONFIG.binaryName);
      const assets: ResolvedAssets = {
        modelPath,
        binaryPath,
        libDir,
        sha256: MODEL_CONFIG.sha256,
        sizeBytes: MODEL_CONFIG.expectedBytes,
      };
      resolvedAssets = assets;
      state = 'ready';
      return assets;
    } catch (err) {
      state = 'error';
      throw err;
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

export function triggerBackgroundWarmup(): void {
  if (state === 'uninitialized' && !initPromise) {
    ensureModelReady().catch((err) => {
      console.error('[model-loader] warmup error:', err instanceof Error ? err.message : err);
    });
  }
}
