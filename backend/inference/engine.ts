import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LIMITS, MODEL_CONFIG, getCacheRoot } from '../config';
import {
  RepetitionLoopDetector,
  buildChatPromptWithPrefix,
  StreamTokenSanitizer,
} from '../chat/context';
import { ensureModelReady } from '../model/loader';
import { OutputLoopError, type ValidatedChatRequest } from '../validation';

export interface GenerationResult {
  requestId: string;
  content: string;
  finishReason: 'stop' | 'length' | 'aborted';
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  signal?: AbortSignal;
  /**
   * Absolute timestamp (ms) after which generation must stop. Used to stay
   * inside the Netlify Function execution limit.
   */
  deadlineAt?: number;
}

const activeControllers = new Map<string, AbortController>();
let activeCount = 0;

export function getActiveGenerationCount(): number {
  return activeCount;
}

export function stopGeneration(requestId: string): boolean {
  const controller = activeControllers.get(requestId);
  if (!controller) {
    return false;
  }
  controller.abort(new Error('Generation stopped by user'));
  return true;
}

export async function streamGeneration(
  req: ValidatedChatRequest,
  callbacks: StreamCallbacks
): Promise<GenerationResult> {
  if (activeCount >= LIMITS.maxConcurrentRequests) {
    throw new Error('Server is busy with concurrent requests.');
  }

  activeCount += 1;
  const controller = new AbortController();
  activeControllers.set(req.requestId, controller);

  const onExternalAbort = () => {
    controller.abort(new Error('Client aborted generation'));
  };
  if (callbacks.signal) {
    if (callbacks.signal.aborted) {
      activeControllers.delete(req.requestId);
      activeCount -= 1;
      throw new Error('Client aborted generation');
    }
    callbacks.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const promptFile = path.join(
    getCacheRoot(),
    'prompts',
    `webgpt-prompt-${req.requestId}-${Date.now()}.txt`
  );

  let timeoutHandle: NodeJS.Timeout | null = null;
  let killHandle: NodeJS.Timeout | null = null;

  try {
    const assets = await ensureModelReady(callbacks.signal);
    if (controller.signal.aborted) {
      return { requestId: req.requestId, content: '', finishReason: 'aborted' };
    }

    const { prompt, assistantPrefix } = buildChatPromptWithPrefix(req.messages);
    await fsp.mkdir(path.dirname(promptFile), { recursive: true });
    await fsp.writeFile(promptFile, prompt, 'utf8');

    const detectedCpus =
      typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    const cpuCount = Math.max(1, Math.min(4, detectedCpus || 2));
    const args = [
      '-m',
      assets.modelPath,
      '-c',
      String(MODEL_CONFIG.contextTokens),
      '-n',
      String(req.maxTokens),
      '-t',
      String(cpuCount),
      '--temp',
      String(req.temperature),
      '--top-p',
      String(req.topP),
      '--repeat-penalty',
      '1.15',
      '--repeat-last-n',
      '128',
      '-no-cnv',
      '--no-display-prompt',
      '-r',
      '<|im_end|>',
      '-f',
      promptFile,
    ];

    const env = {
      ...process.env,
      LD_LIBRARY_PATH: assets.libDir
        ? `${assets.libDir}${process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : ''}`
        : process.env.LD_LIBRARY_PATH,
    };

    const child = spawn(assets.binaryPath, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const sanitizer = new StreamTokenSanitizer();
    const loopDetector = new RepetitionLoopDetector();
    let fullText = '';
    let outputBytes = 0;
    let stderrLogs = '';
    let wasAborted = false;
    let wasTimedOut = false;
    let hitMaxBytes = false;
    let loopError: OutputLoopError | null = null;
    let stripFirstNewline = assistantPrefix.length > 0;

    if (assistantPrefix) {
      fullText = assistantPrefix;
      outputBytes = Buffer.byteLength(assistantPrefix, 'utf8');
      callbacks.onToken(assistantPrefix);
    }

    const terminateChild = () => {
      if (!child.killed) {
        child.kill('SIGTERM');
        killHandle = setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 1500);
      }
    };

    const onAbort = () => {
      wasAborted = true;
      terminateChild();
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });

    const deadlineBudget = callbacks.deadlineAt
      ? callbacks.deadlineAt - Date.now()
      : LIMITS.generationTimeoutMs;
    const timeoutMs = Math.max(
      1_000,
      Math.min(LIMITS.generationTimeoutMs, deadlineBudget)
    );

    timeoutHandle = setTimeout(() => {
      wasTimedOut = true;
      terminateChild();
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stderr.on('data', (chunk: string) => {
      if (stderrLogs.length < 4096) {
        stderrLogs += chunk;
      }
    });

    child.stdout.on('data', (chunk: string) => {
      if (controller.signal.aborted || wasTimedOut || loopError) return;

      let clean = sanitizer.push(chunk);
      if (!clean) return;

      if (stripFirstNewline) {
        clean = clean.replace(/^\r?\n+/, '');
        if (!clean) return;
        stripFirstNewline = false;
      }

      const candidateText = fullText + clean;
      const loopCheck = loopDetector.inspect(candidateText);
      if (loopCheck.isLoop) {
        loopError = new OutputLoopError(loopCheck.reason);
        terminateChild();
        return;
      }

      const chunkBytes = Buffer.byteLength(clean, 'utf8');
      if (outputBytes + chunkBytes > LIMITS.maxOutputBytes) {
        const remainingBudget = Math.max(0, LIMITS.maxOutputBytes - outputBytes);
        const clipped = clean.slice(0, remainingBudget);
        if (clipped) {
          fullText += clipped;
          outputBytes += Buffer.byteLength(clipped, 'utf8');
          callbacks.onToken(clipped);
        }
        hitMaxBytes = true;
        terminateChild();
        return;
      }

      fullText = candidateText;
      outputBytes += chunkBytes;
      callbacks.onToken(clean);
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code));
    });

    if (loopError) {
      throw loopError;
    }

    if (!wasAborted && !wasTimedOut) {
      const trailing = sanitizer.flush();
      if (trailing && outputBytes < LIMITS.maxOutputBytes) {
        const trailingLoop = loopDetector.inspect(fullText + trailing);
        if (trailingLoop.isLoop) {
          throw new OutputLoopError(trailingLoop.reason);
        }
        fullText += trailing;
        callbacks.onToken(trailing);
      }
    }

    if (wasAborted) {
      return {
        requestId: req.requestId,
        content: fullText.trimEnd(),
        finishReason: 'aborted',
      };
    }

    if (exitCode !== 0 && !fullText && !hitMaxBytes && !wasTimedOut) {
      console.error('[inference] llama-completion exited with code', exitCode, stderrLogs);
      throw new Error(`Inference runtime failed with exit code ${exitCode}`);
    }

    return {
      requestId: req.requestId,
      content: fullText.trim(),
      finishReason: hitMaxBytes || wasTimedOut ? 'length' : 'stop',
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (killHandle) clearTimeout(killHandle);
    if (callbacks.signal) {
      callbacks.signal.removeEventListener('abort', onExternalAbort);
    }
    activeControllers.delete(req.requestId);
    activeCount = Math.max(0, activeCount - 1);
    await fsp.rm(promptFile, { force: true }).catch(() => {});
  }
}

export async function runCompletion(
  req: ValidatedChatRequest,
  signal?: AbortSignal,
  deadlineAt?: number
): Promise<GenerationResult> {
  let combined = '';
  const result = await streamGeneration(req, {
    signal,
    deadlineAt,
    onToken: (token) => {
      combined += token;
    },
  });
  return {
    ...result,
    content: result.content || combined.trim(),
  };
}
