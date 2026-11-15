import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'WebGPT';
export const APP_CREATOR = 'Abdus Nilom';

export const SYSTEM_PROMPT =
  'You are WebGPT made by Abdus Nilom. Help users with questions, learning, creativity and everyday tasks. Communicate naturally, clearly and helpfully.';

export const MODEL_CONFIG = {
  filename: 'Falcon-H1-Tiny-Multilingual-100M-Instruct.Q4_K_M.gguf',
  url: 'https://huggingface.co/mradermacher/Falcon-H1-Tiny-Multilingual-100M-Instruct-GGUF/resolve/main/Falcon-H1-Tiny-Multilingual-100M-Instruct.Q4_K_M.gguf',
  sha256: 'f8f5c2f964511caf59abfa02b6b8a6867b9c429ef3366b5a3ac9d5eea79aa0f6',
  expectedBytes: 73_895_104,
  contextTokens: 4096,
  /**
   * Where the model is published as a static asset. The GGUF file is intentionally
   * NOT part of the Netlify Function bundle - it is served from the site CDN and
   * downloaded into the execution environment on demand.
   */
  staticPath: '/models/Falcon-H1-Tiny-Multilingual-100M-Instruct.Q4_K_M.gguf',
  downloadRetries: 3,
} as const;

export const RUNTIME_CONFIG = {
  binaryName: 'llama-completion',
  /**
   * Every shared library required by the bundled llama.cpp runtime. The set is
   * shipped inside the Function bundle so the runtime never depends on the host
   * image's C++ runtime being present.
   */
  requiredFiles: [
    'llama-completion',
    'libllama-completion-impl.so',
    'libllama.so.1',
    'libllama-common.so.1',
    'libggml.so.1',
    'libggml-base.so.1',
    'libggml-cpu-x64.so',
    'libggml-cpu-sse42.so',
    'libggml-cpu-haswell.so',
    'libstdc++.so.6',
    'libgomp.so.1',
  ] as const,
} as const;

export const LIMITS = {
  maxMessages: 40,
  maxMessageChars: 4000,
  maxPromptChars: 8000,
  defaultMaxTokens: 512,
  maxOutputTokens: 1024,
  minOutputTokens: 16,
  maxOutputBytes: 48 * 1024,
  /**
   * Netlify Functions allow 60s of synchronous execution time. The generation
   * budget stays well below that ceiling so the runtime can always return a
   * response (including the timeout payload) instead of being killed.
   */
  generationTimeoutMs: 40_000,
  requestBudgetMs: 52_000,
  maxConcurrentRequests: 2,
  rateLimitWindowMs: 60_000,
  rateLimitMaxRequests: 20,
} as const;

export function getWorkspaceRoot(): string {
  return process.cwd();
}

/**
 * Root of the writable scratch space. Netlify Functions run on ephemeral
 * containers, so nothing outside of this directory may be assumed to survive
 * between invocations.
 */
export function getCacheRoot(): string {
  return process.env.WEBGPT_CACHE_DIR || path.join(os.tmpdir(), 'webgpt');
}

export function getModelCacheDir(): string {
  return path.join(getCacheRoot(), 'models');
}

export function getRuntimeCacheDir(): string {
  return path.join(getCacheRoot(), 'runtime');
}

/**
 * Candidate locations of an already downloaded/verified model file, ordered
 * from cheapest to most expensive to check.
 */
export function getBundledModelPaths(): string[] {
  const root = getWorkspaceRoot();
  const filename = MODEL_CONFIG.filename;
  return [
    process.env.WEBGPT_MODEL_PATH || process.env.SM_MODEL_PATH || '',
    path.join(root, 'models', filename),
    path.join(root, 'dist', 'models', filename),
    path.join(root, '.cache', 'webgpt', 'models', filename),
    path.join(getModelCacheDir(), filename),
  ].filter(Boolean);
}

/**
 * Candidate locations of the bundled llama.cpp runtime. The Function bundle
 * places `runtime/llama/**` relative to the function root, but the exact working
 * directory differs between `netlify dev`, the Netlify build and Lambda, so a
 * short upward search is used to locate it robustly.
 */
export function getBundledRuntimeDirs(): string[] {
  const root = getWorkspaceRoot();
  const candidates: string[] = [
    process.env.WEBGPT_LLAMA_DIR || process.env.SM_LLAMA_DIR || '',
    path.join(root, 'runtime', 'llama'),
    path.join(root, '..', 'runtime', 'llama'),
    path.join(root, '..', '..', 'runtime', 'llama'),
    path.join('/var/task', 'runtime', 'llama'),
    path.join(getRuntimeCacheDir(), 'llama'),
  ];

  // Walk up from the working directory looking for a bundled runtime.
  let current = root;
  for (let depth = 0; depth < 4; depth++) {
    candidates.push(path.join(current, 'runtime', 'llama'));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return Array.from(new Set(candidates.filter(Boolean)));
}

/**
 * Public origin of the deployed site. Used to download the model from the
 * site's own CDN (a static asset) instead of a third party host.
 */
export function getSiteOrigin(): string | null {
  const configured = process.env.WEBGPT_SITE_URL || process.env.URL || process.env.APP_URL || '';
  const trimmed = configured.replace(/\/+$/, '');
  return trimmed || null;
}

export function getAllowedOrigins(): string[] {
  const configured = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const defaults = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ];

  const siteOrigin = getSiteOrigin();
  if (siteOrigin) {
    defaults.push(siteOrigin);
  }

  return Array.from(new Set([...defaults, ...configured]));
}
