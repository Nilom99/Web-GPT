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
  contextTokens: 8192,
} as const;

export const RUNTIME_CONFIG = {
  releaseTag: 'b12413',
  archiveUrl:
    'https://github.com/ggml-org/llama.cpp/releases/download/b12413/llama-b12413-bin-ubuntu-x64.tar.gz',
  binaryName: 'llama-completion',
  requiredLibs: [
    'libllama-completion-impl.so',
    'libllama-common.so.1',
    'libllama.so.1',
    'libggml.so.1',
    'libggml-base.so.1',
    'libggml-cpu-x64.so',
    'libggml-cpu-sse42.so',
    'libggml-cpu-haswell.so',
  ],
} as const;

export const LIMITS = {
  maxMessages: 40,
  maxMessageChars: 4000,
  maxPromptChars: 16000,
  defaultMaxTokens: 4096,
  maxOutputTokens: 4096,
  minOutputTokens: 16,
  maxOutputBytes: 64 * 1024,
  generationTimeoutMs: 120_000,
  maxConcurrentRequests: 2,
  rateLimitWindowMs: 60_000,
  rateLimitMaxRequests: 20,
} as const;

export function getWorkspaceRoot(): string {
  return process.cwd();
}

export function getBundledModelPaths(): string[] {
  const root = getWorkspaceRoot();
  return [
    process.env.WEBGPT_MODEL_PATH || process.env.SM_MODEL_PATH || '',
    path.join(root, 'models', MODEL_CONFIG.filename),
    path.join(root, 'dist', 'models', MODEL_CONFIG.filename),
    path.join('/tmp', 'webgpt', 'models', MODEL_CONFIG.filename),
  ].filter(Boolean);
}

export function getBundledRuntimeDirs(): string[] {
  const root = getWorkspaceRoot();
  return [
    process.env.WEBGPT_LLAMA_DIR || process.env.SM_LLAMA_DIR || '',
    path.join(root, 'runtime', 'llama'),
    path.join('/tmp', 'webgpt', 'runtime', 'llama'),
  ].filter(Boolean);
}

export function getAllowedOrigins(): string[] {
  const configured = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const defaults = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://verdant-kangaroo-6053a5.netlify.app',
  ];

  if (process.env.APP_URL) {
    defaults.push(process.env.APP_URL.replace(/\/+$/, ''));
  }
  if (process.env.URL) {
    defaults.push(process.env.URL.replace(/\/+$/, ''));
  }

  return Array.from(new Set([...defaults, ...configured]));
}
