import { LIMITS, SYSTEM_PROMPT } from '../config';
import type { IncomingChatMessage } from '../validation';

const IM_START = '<|im_start|>';
const IM_END = '<|im_end|>';

export function formatTurn(role: 'system' | 'user' | 'assistant', content: string): string {
  return `${IM_START}${role}\n${content}${IM_END}\n`;
}

const IDENTITY_QUERY_RE =
  /\b(who\s+(?:are|r)\s+(?:you|u)|what\s+(?:are|r)\s+(?:you|u)|who\s+(?:made|created|built|developed|designed|wrote|owns|trained|programmed)\s+(?:you|u)|who(?:'?s|\s+is)?\s+(?:your|ur)\s+(?:creator|maker|developer|author|owner|founder)|what(?:'?s|\s+is)\s+(?:your|ur)\s+(?:model\s+)?name|tell\s+me\s+(?:your|ur)\s+(?:model\s+)?name|may\s+i\s+know\s+(?:your|ur)\s+(?:model\s+)?name|who\s+am\s+i\s+talking\s+to|introduce\s+yourself|tell\s+me\s+about\s+yourself|(?:are\s+you|r\s+u)\s+(?:chatgpt|gpt(?:-\d+)?|openai|claude|gemini|deepseek|falcon|llama|an?\s+ai|an?\s+assistant|a\s+bot|a\s+robot)|(?:which|what)\s+(?:ai|llm|model|company)\s+(?:are\s+you|made\s+you|created\s+you|developed\s+you))\b/i;

export const IDENTITY_RESPONSE_PREFIX = 'I am WebGPT made by Abdus Nilom';

export function isIdentityQuery(text: string): boolean {
  return IDENTITY_QUERY_RE.test(text.trim());
}

/**
 * Formats conversation messages using the Falcon-H1 ChatML template while keeping
 * the prompt safely within the configured context character budget.
 * Preserves the private system prompt and at least the latest user turn.
 */
export function buildChatPromptWithPrefix(
  messages: IncomingChatMessage[],
  systemPrompt: string = SYSTEM_PROMPT,
  maxPromptChars: number = LIMITS.maxPromptChars
): { prompt: string; assistantPrefix: string } {
  const systemBlock = formatTurn('system', systemPrompt);
  const lastUser = messages[messages.length - 1];
  const isIdentity = Boolean(lastUser && lastUser.role === 'user' && isIdentityQuery(lastUser.content));
  const assistantPrefix = isIdentity ? IDENTITY_RESPONSE_PREFIX : '';
  const anchorBlock = isIdentity
    ? formatTurn('user', 'Who are you?') +
      formatTurn('assistant', 'I am WebGPT made by Abdus Nilom. How can I help you?')
    : '';
  const assistantStart = `${IM_START}assistant\n${assistantPrefix}`;

  const formattedTurns = messages.map((m) => formatTurn(m.role, m.content));

  // Always retain the latest user message, then include as many preceding turns as fit
  const selected: string[] = [];
  let currentChars = systemBlock.length + anchorBlock.length + assistantStart.length;

  for (let i = formattedTurns.length - 1; i >= 0; i--) {
    const turn = formattedTurns[i];
    if (i === formattedTurns.length - 1) {
      selected.unshift(turn);
      currentChars += turn.length;
      continue;
    }
    if (currentChars + turn.length <= maxPromptChars) {
      selected.unshift(turn);
      currentChars += turn.length;
    } else {
      break;
    }
  }

  return {
    prompt: systemBlock + anchorBlock + selected.join('') + assistantStart,
    assistantPrefix,
  };
}

export function buildChatPrompt(
  messages: IncomingChatMessage[],
  systemPrompt: string = SYSTEM_PROMPT,
  maxPromptChars: number = LIMITS.maxPromptChars
): string {
  return buildChatPromptWithPrefix(messages, systemPrompt, maxPromptChars).prompt;
}

const TRAILING_MARKERS = ['[end of text]', '<|im_end|>', '<|endoftext|>'];

/**
 * Buffers partial marker prefixes across streaming stdout chunks so raw template
 * or llama.cpp end-of-text markers are never leaked to the client UI.
 */
export class StreamTokenSanitizer {
  private buffer = '';

  push(chunk: string): string {
    this.buffer += chunk;

    // If any complete marker appears, cut cleanly at the earliest marker
    let earliestIdx = -1;
    for (const marker of TRAILING_MARKERS) {
      const idx = this.buffer.indexOf(marker);
      if (idx !== -1 && (earliestIdx === -1 || idx < earliestIdx)) {
        earliestIdx = idx;
      }
    }

    if (earliestIdx !== -1) {
      const safe = this.buffer.slice(0, earliestIdx);
      this.buffer = '';
      return safe;
    }

    // Hold back a potential partial suffix of any stop marker
    let holdBack = 0;
    for (const marker of TRAILING_MARKERS) {
      const maxCheck = Math.min(marker.length - 1, this.buffer.length);
      for (let len = maxCheck; len >= 1; len--) {
        if (this.buffer.endsWith(marker.slice(0, len))) {
          holdBack = Math.max(holdBack, len);
          break;
        }
      }
    }

    if (holdBack > 0) {
      const emit = this.buffer.slice(0, this.buffer.length - holdBack);
      this.buffer = this.buffer.slice(this.buffer.length - holdBack);
      return emit;
    }

    const emit = this.buffer;
    this.buffer = '';
    return emit;
  }

  flush(): string {
    let remaining = this.buffer;
    this.buffer = '';
    for (const marker of TRAILING_MARKERS) {
      remaining = remaining.replaceAll(marker, '');
    }
    return remaining;
  }
}

export const MIN_LOOP_SIMILAR_TOKENS = 30;

function tokenizeForLoopCheck(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_]+|[^\s\w]/g) || [];
}

export interface LoopCheckResult {
  isLoop: boolean;
  reason?: string;
}

/**
 * Guard layer that inspects accumulated model output for repetitive generation loops.
 * Operates strictly on word/symbol tokens and enforces a minimum of 30 similar/repeated
 * tokens before stopping so short 5-29 word repetitions never cause premature failures.
 */
export class RepetitionLoopDetector {
  inspect(fullText: string): LoopCheckResult {
    if (fullText.length < 40) {
      return { isLoop: false };
    }

    // 1. Exact consecutive cyclic repetition on token sequence requiring >= 30 repeated tokens
    const tokens = tokenizeForLoopCheck(fullText);
    if (tokens.length >= MIN_LOOP_SIMILAR_TOKENS + 1) {
      const tailTokens = tokens.slice(-400);
      const maxOffset = Math.min(6, Math.max(0, tailTokens.length - 2));

      for (let offset = 0; offset <= maxOffset; offset++) {
        const end = tailTokens.length - offset;
        const maxPatternLen = Math.min(120, Math.floor(end / 2));

        for (let pLen = 1; pLen <= maxPatternLen; pLen++) {
          if (tailTokens[end - 1] !== tailTokens[end - pLen - 1]) {
            continue;
          }

          let matchesUnit = true;
          for (let j = 0; j < pLen; j++) {
            if (tailTokens[end - pLen + j] !== tailTokens[end - 2 * pLen + j]) {
              matchesUnit = false;
              break;
            }
          }
          if (!matchesUnit) continue;

          let repeats = 2;
          while ((repeats + 1) * pLen <= end) {
            let matchesPrev = true;
            const start = end - (repeats + 1) * pLen;
            for (let j = 0; j < pLen; j++) {
              if (tailTokens[start + j] !== tailTokens[end - pLen + j]) {
                matchesPrev = false;
                break;
              }
            }
            if (matchesPrev) {
              repeats++;
            } else {
              break;
            }
          }

          const repeatedTokens = (repeats - 1) * pLen;
          if (repeatedTokens >= MIN_LOOP_SIMILAR_TOKENS) {
            let unitWordCount = 0;
            for (let j = 0; j < pLen; j++) {
              if (/^[a-z0-9_]+$/.test(tailTokens[end - pLen + j])) {
                unitWordCount++;
              }
            }
            const effectiveRepeatedCount =
              unitWordCount > 0 ? (repeats - 1) * unitWordCount : repeatedTokens;

            if (effectiveRepeatedCount >= MIN_LOOP_SIMILAR_TOKENS) {
              return {
                isLoop: true,
                reason: `Consecutive cyclic repetition detected (${effectiveRepeatedCount} repeated tokens)`,
              };
            }
          }
        }
      }
    }

    // 2. Repeated completed sentences or lines accumulating >= 30 repeated word tokens
    const lastBoundary = Math.max(
      fullText.lastIndexOf('.'),
      fullText.lastIndexOf('!'),
      fullText.lastIndexOf('?'),
      fullText.lastIndexOf('\n')
    );
    if (lastBoundary > 0) {
      const completedText = fullText.slice(0, lastBoundary + 1);
      const segments = completedText.split(/(?:[.!?]+(?:\s+|$)|\n+)/);
      const seenSentences = new Set<string>();
      let repeatedSentenceTokens = 0;

      for (const rawSeg of segments) {
        const norm = rawSeg
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (!norm) continue;
        const segTokens = norm.split(' ').length;
        if (segTokens < 8) continue;

        if (seenSentences.has(norm)) {
          repeatedSentenceTokens += segTokens;
          if (repeatedSentenceTokens >= MIN_LOOP_SIMILAR_TOKENS) {
            return {
              isLoop: true,
              reason: `Repeated sentence loop detected (${repeatedSentenceTokens} repeated tokens)`,
            };
          }
        } else {
          seenSentences.add(norm);
        }
      }
    }

    // 3. Trailing 40-word window 8-gram similarity check requiring >= 30 similar words
    const words = fullText.toLowerCase().match(/[a-z0-9_]+/g);
    const shingleLen = 8;
    const windowSize = 40;
    if (words && words.length >= windowSize + 20) {
      const firstSeenShingle = new Map<string, number>();
      const windowStart = words.length - windowSize;
      const matchedInWindow = new Uint8Array(windowSize);

      for (let i = 0; i <= words.length - shingleLen; i++) {
        const shingle = words.slice(i, i + shingleLen).join(' ');
        const prevIdx = firstSeenShingle.get(shingle);
        if (prevIdx === undefined) {
          firstSeenShingle.set(shingle, i);
        } else if (i - prevIdx >= 20 && i + shingleLen - 1 >= windowStart) {
          const markFrom = Math.max(windowStart, i);
          for (let k = markFrom; k < i + shingleLen; k++) {
            matchedInWindow[k - windowStart] = 1;
          }
        }
      }

      let similarTrailingWords = 0;
      for (let i = 0; i < matchedInWindow.length; i++) {
        similarTrailingWords += matchedInWindow[i];
      }

      if (similarTrailingWords >= MIN_LOOP_SIMILAR_TOKENS) {
        return {
          isLoop: true,
          reason: `Repetitive phrase loop detected (${similarTrailingWords} similar tokens)`,
        };
      }
    }

    return { isLoop: false };
  }
}
