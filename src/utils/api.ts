import type { ModelStatusResponse } from '../types/chat';

export interface ApiMessagePayload {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamHandlers {
  onStatus?: (status: 'loading' | 'ready') => void;
  onToken: (token: string) => void;
  onDone?: (finishReason: string) => void;
  onError?: (errorMessage: string) => void;
}

export async function fetchModelStatus(init = false): Promise<ModelStatusResponse> {
  const query = init ? '?init=1' : '';
  const response = await fetch(`/api/model/status${query}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error('Unable to check assistant status.');
  }
  return (await response.json()) as ModelStatusResponse;
}

export async function stopGenerationRequest(requestId: string): Promise<void> {
  try {
    await fetch('/api/chat/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId }),
    });
  } catch {
    // Ignore stop network failures when aborting client stream
  }
}

export async function streamChatCompletion(
  params: {
    requestId: string;
    messages: ApiMessagePayload[];
    signal: AbortSignal;
  },
  handlers: StreamHandlers
): Promise<void> {
  const response = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      requestId: params.requestId,
      messages: params.messages,
    }),
    signal: params.signal,
  });

  if (!response.ok) {
    let message = 'Unable to send your message right now.';
    try {
      const json = (await response.json()) as { error?: string };
      if (json.error) message = json.error;
    } catch {
      // ignore non-json errors
    }
    throw new Error(message);
  }

  if (!response.body) {
    throw new Error('Streaming is unavailable.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const processFrame = (frame: string) => {
    const lines = frame.split(/\r?\n/);
    let eventName = 'message';
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (dataLines.length === 0) return;
    const rawData = dataLines.join('\n');

    try {
      const parsed = JSON.parse(rawData) as Record<string, unknown>;
      if (eventName === 'status') {
        if (parsed.status === 'loading' || parsed.status === 'ready') {
          handlers.onStatus?.(parsed.status);
        }
      } else if (eventName === 'start') {
        handlers.onStatus?.('ready');
      } else if (eventName === 'token') {
        if (typeof parsed.token === 'string' && parsed.token.length > 0) {
          handlers.onToken(parsed.token);
        }
      } else if (eventName === 'done') {
        handlers.onDone?.(typeof parsed.finishReason === 'string' ? parsed.finishReason : 'stop');
      } else if (eventName === 'error') {
        const msg =
          typeof parsed.error === 'string'
            ? parsed.error
            : 'Unable to generate a response right now.';
        handlers.onError?.(msg);
      }
    } catch {
      // Ignore malformed SSE frames
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let splitIdx = buffer.indexOf('\n\n');
    while (splitIdx !== -1) {
      const frame = buffer.slice(0, splitIdx);
      buffer = buffer.slice(splitIdx + 2);
      if (frame.trim()) {
        processFrame(frame);
      }
      splitIdx = buffer.indexOf('\n\n');
    }
  }

  if (buffer.trim()) {
    processFrame(buffer);
  }
}
