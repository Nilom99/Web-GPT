import { LIMITS, getAllowedOrigins } from './config';

export type ChatRole = 'user' | 'assistant';

export interface IncomingChatMessage {
  role: ChatRole;
  content: string;
}

export interface ValidatedChatRequest {
  requestId: string;
  messages: IncomingChatMessage[];
  temperature: number;
  topP: number;
  maxTokens: number;
}

export class ValidationError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = statusCode;
  }
}

export class OutputLoopError extends Error {
  readonly statusCode = 422;
  constructor(message = 'Output failed: repetitive response loop detected.') {
    super(message);
    this.name = 'OutputLoopError';
  }
}

const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function sanitizeUserText(input: string): string {
  return input
    .replace(CONTROL_CHAR_RE, '')
    .replace(/<\|im_start\|>/g, '')
    .replace(/<\|im_end\|>/g, '')
    .replace(/<\|endoftext\|>/g, '')
    .trim();
}

export function validateChatRequest(body: unknown): ValidatedChatRequest {
  if (!body || typeof body !== 'object') {
    throw new ValidationError('Request body must be a JSON object.');
  }

  const raw = body as Record<string, unknown>;
  const rawMessages = raw.messages;

  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new ValidationError('At least one message is required.');
  }

  if (rawMessages.length > LIMITS.maxMessages) {
    throw new ValidationError(
      `Conversation exceeds the maximum limit of ${LIMITS.maxMessages} messages per request.`
    );
  }

  const messages: IncomingChatMessage[] = [];
  for (let i = 0; i < rawMessages.length; i++) {
    const item = rawMessages[i];
    if (!item || typeof item !== 'object') {
      throw new ValidationError(`Invalid message at index ${i}.`);
    }
    const msg = item as Record<string, unknown>;
    if (msg.role !== 'user' && msg.role !== 'assistant') {
      throw new ValidationError(`Invalid message role at index ${i}.`);
    }
    if (typeof msg.content !== 'string') {
      throw new ValidationError(`Message content must be a string at index ${i}.`);
    }

    const cleaned = sanitizeUserText(msg.content);
    if (cleaned.length === 0) {
      throw new ValidationError(`Message at index ${i} cannot be empty.`);
    }
    if (cleaned.length > LIMITS.maxMessageChars) {
      throw new ValidationError(
        `Message at index ${i} exceeds ${LIMITS.maxMessageChars} characters.`
      );
    }
    messages.push({ role: msg.role, content: cleaned });
  }

  const lastMessage = messages[messages.length - 1];
  if (lastMessage.role !== 'user') {
    throw new ValidationError('The last message must come from the user.');
  }

  const rawReqId =
    typeof raw.requestId === 'string' && /^[a-zA-Z0-9_-]{4,64}$/.test(raw.requestId)
      ? raw.requestId
      : `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  const tempNum = typeof raw.temperature === 'number' && Number.isFinite(raw.temperature)
    ? Math.min(1.2, Math.max(0.0, raw.temperature))
    : 0.35;

  const topPNum = typeof raw.topP === 'number' && Number.isFinite(raw.topP)
    ? Math.min(1.0, Math.max(0.1, raw.topP))
    : 0.9;

  const maxTokensNum =
    typeof raw.maxTokens === 'number' && Number.isFinite(raw.maxTokens)
      ? Math.min(
          LIMITS.maxOutputTokens,
          Math.max(LIMITS.minOutputTokens, Math.floor(raw.maxTokens))
        )
      : LIMITS.defaultMaxTokens;

  return {
    requestId: rawReqId,
    messages,
    temperature: tempNum,
    topP: topPNum,
    maxTokens: maxTokensNum,
  };
}

export function validateStopRequest(body: unknown): { requestId: string } {
  if (!body || typeof body !== 'object') {
    throw new ValidationError('Request body must be a JSON object.');
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.requestId !== 'string' || !/^[a-zA-Z0-9_-]{4,64}$/.test(raw.requestId)) {
    throw new ValidationError('A valid requestId is required.');
  }
  return { requestId: raw.requestId };
}

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(
    windowMs: number = LIMITS.rateLimitWindowMs,
    maxRequests: number = LIMITS.rateLimitMaxRequests
  ) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  check(key: string, now: number = Date.now()): {
    allowed: boolean;
    remaining: number;
    retryAfterSeconds: number;
  } {
    const cutoff = now - this.windowMs;
    const prev = (this.hits.get(key) || []).filter((ts) => ts > cutoff);

    if (prev.length >= this.maxRequests) {
      const oldest = prev[0];
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      this.hits.set(key, prev);
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }

    prev.push(now);
    this.hits.set(key, prev);

    // Opportunistic cleanup so map cannot grow unboundedly
    if (this.hits.size > 1000) {
      for (const [k, timestamps] of this.hits.entries()) {
        if (timestamps.every((ts) => ts <= cutoff)) {
          this.hits.delete(k);
        }
      }
    }

    return {
      allowed: true,
      remaining: Math.max(0, this.maxRequests - prev.length),
      retryAfterSeconds: 0,
    };
  }
}

export function evaluateCorsOrigin(
  origin: string | undefined | null,
  requestHost?: string | null
): { allowed: boolean; headerOrigin: string | null } {
  // Same-origin browser requests or non-browser curl/server calls often omit Origin
  if (!origin) {
    return { allowed: true, headerOrigin: null };
  }

  const normalized = origin.replace(/\/+$/, '');
  const allowedOrigins = getAllowedOrigins();

  if (allowedOrigins.includes(normalized)) {
    return { allowed: true, headerOrigin: normalized };
  }

  if (requestHost) {
    try {
      const parsed = new URL(normalized);
      if (parsed.host === requestHost) {
        return { allowed: true, headerOrigin: normalized };
      }
    } catch {
      return { allowed: false, headerOrigin: null };
    }
  }

  return { allowed: false, headerOrigin: null };
}

export function toSafePublicError(err: unknown): { statusCode: number; message: string } {
  if (err instanceof ValidationError) {
    return { statusCode: err.statusCode, message: err.message };
  }

  if (err instanceof OutputLoopError) {
    return {
      statusCode: err.statusCode,
      message: 'Output failed: repetitive response loop detected. Please try again.',
    };
  }

  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('busy') || msg.includes('concurrent')) {
      return {
        statusCode: 429,
        message: 'WebGPT is handling another request right now. Please try again shortly.',
      };
    }
    if (msg.includes('timeout') || msg.includes('timed out')) {
      return {
        statusCode: 504,
        message: 'The response took too long to complete. Please try a shorter prompt.',
      };
    }
    if (msg.includes('aborted') || msg.includes('cancelled') || msg.includes('stopped')) {
      return {
        statusCode: 499,
        message: 'Generation stopped.',
      };
    }
  }

  return {
    statusCode: 500,
    message: 'Unable to generate a response right now. Please try again.',
  };
}
