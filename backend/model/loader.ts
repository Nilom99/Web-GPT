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
  getModelCacheDir,
  getSiteOrigin,
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

/**
 * A model file is only considered usable when both its size and its SHA-256
 * checksum match the pinned values.
 */
export async function isValidModelFile(filePath: string): Promise<boolean> {
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

/**
 * The bundled runtime is usable when the launcher binary and every shared
 * library it needs are present.
 */
export async function isValidRuntimeDir(dir: string): Promise<boolean> {
  try {
    for (const file of RUNTIME_CONFIG.requiredFiles) {
      const stat = await fsp.stat(path.join(dir, file));
      if (!stat.isFile() || stat.size < 1024) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the shared libraries the launcher binary needs. Missing libraries
 * are reported so a broken bundle fails loudly instead of at inference time.
 */
export async function findMissingRuntimeLibraries(dir: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('ldd', [path.join(dir, RUNTIME_CONFIG.binaryName)], {
      env: { ...process.env, LD_LIBRARY_PATH: dir },
    });
    return stdout
      .split('\n')
      .filter((line) => line.includes('not found'))
      .map((line) => line.trim());
  } catch {
    // `ldd` is optional; a missing ldd must not block start-up.
    return [];
  }
}

async function downloadFileToPath(
  url: string,
  destPath: string,
  signal?: AbortSignal
): Promise<void> {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.part`;
  await fsp.rm(tmpPath, { force: true }).catch(() => {});

  const response = await fetch(url, { redirect: 'follow', signal });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch required asset (status ${response.status})`);
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

/**
 * Removes partial downloads left behind by an interrupted invocation.
 */
export async function cleanupPartialDownloads(dir: string): Promise<void> {
  try {
    const entries = await fsp.readdir(dir);
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.part'))
        .map((entry) => fsp.rm(path.join(dir, entry), { force: true, recursive: true }).catch(() => {}))
    );
  } catch {
    // The cache directory may not exist yet.
  }
}

/**
 * Downloads the model into the execution environment cache and verifies its
 * checksum before it is accepted. Partial files are always removed.
 */
export async function downloadModelToCache(signal?: AbortSignal): Promise<string> {
  const cacheDir = getModelCacheDir();
  const cachePath = path.join(cacheDir, MODEL_CONFIG.filename);

  await fsp.mkdir(cacheDir, { recursive: true });
  await cleanupPartialDownloads(cacheDir);

  if (await isValidModelFile(cachePath)) {
    return cachePath;
  }

  const origin = getSiteOrigin();
  const candidateUrls = origin
    ? [`${origin}${MODEL_CONFIG.staticPath}`, MODEL_CONFIG.url]
    : [MODEL_CONFIG.url];

  const failures: string[] = [];

  for (const url of candidateUrls) {
    for (let attempt = 1; attempt <= MODEL_CONFIG.downloadRetries; attempt++) {
      try {
        await downloadFileToPath(url, cachePath, signal);

        if (await isValidModelFile(cachePath)) {
          return cachePath;
        }

        // Checksum or size mismatch: drop the file and try the next source.
        await fsp.rm(cachePath, { force: true }).catch(() => {});
        failures.push(`source ${new URL(url).origin} failed checksum verification`);
        break;
      } catch (err) {
        await fsp.rm(cachePath, { force: true }).catch(() => {});
        if (signal?.aborted) {
          throw new Error('Model preparation timed out for this request.');
        }
        failures.push(
          `source ${new URL(url).origin} attempt ${attempt}: ${
            err instanceof Error ? err.message : 'download failed'
          }`
        );
      }
    }
  }

  throw new Error(
    `Unable to obtain a verified model file. ${failures.join('; ')}`
  );
}

export async function resolveModelPath(signal?: AbortSignal): Promise<string> {
  for (const candidate of getBundledModelPaths()) {
    if (await isValidModelFile(candidate)) {
      return candidate;
    }
  }

  // Nothing usable on disk: fetch it into the ephemeral cache.
  return downloadModelToCache(signal);
}

export async function resolveRuntimeDir(): Promise<string> {
  for (const candidate of getBundledRuntimeDirs()) {
    if (await isValidRuntimeDir(candidate)) {
      await fsp.chmod(path.join(candidate, RUNTIME_CONFIG.binaryName), 0o755).catch(() => {});
      return candidate;
    }
  }

  throw new Error('Inference runtime is unavailable in this execution environment.');
}

export async function ensureModelReady(signal?: AbortSignal): Promise<ResolvedAssets> {
  if (state === 'ready' && resolvedAssets) {
    // Re-check file presence in case ephemeral storage was wiped.
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
      const [modelPath, libDir] = await Promise.all([
        resolveModelPath(signal),
        resolveRuntimeDir(),
      ]);
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

/**
 * Warms the runtime up. Safe to call on every request: work is only performed
 * once per execution environment.
 */
export function triggerBackgroundWarmup(): void {
  if (state === 'uninitialized' && !initPromise) {
    ensureModelReady().catch((err) => {
      console.error('[model-loader] warmup error:', err instanceof Error ? err.message : err);
    });
  }
}

/** Test helper: reset the in-process state between test cases. */
export function resetModelLoaderState(): void {
  state = 'uninitialized';
  resolvedAssets = null;
  initPromise = null;
}
