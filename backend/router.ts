import { APP_CREATOR, APP_NAME, LIMITS } from './config';
import {
  getActiveGenerationCount,
  runCompletion,
  stopGeneration,
  streamGeneration,
} from './inference/engine';
import {
  ensureModelReady,
  getPublicModelStatus,
  triggerBackgroundWarmup,
} from './model/loader';
import {
  SlidingWindowRateLimiter,
  evaluateCorsOrigin,
  toSafePublicError,
  validateChatRequest,
  validateStopRequest,
} from './validation';

const rateLimiter = new SlidingWindowRateLimiter();

function buildCorsHeaders(originHeader: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  };
  if (originHeader) {
    headers['Access-Control-Allow-Origin'] = originHeader;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Accept';
  }
  return headers;
}

function jsonResponse(
  data: unknown,
  status: number,
  corsHeaders: Record<string, string>,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders,
      ...extraHeaders,
    },
  });
}

function getClientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return request.headers.get('x-nf-client-connection-ip') || 'local-client';
}

/**
 * Netlify Functions are killed after a fixed amount of wall clock time, so
 * every request works against an explicit deadline that is comfortably below
 * the platform limit.
 */
function requestDeadline(): number {
  return Date.now() + LIMITS.requestBudgetMs;
}

export async function handleApiRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // Normalize Netlify function path prefix if present
  const pathname =
    url.pathname
      .replace(/^\/\.netlify\/functions\/api/, '/api')
      .replace(/\/+$/, '') || '/';

  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  const cors = evaluateCorsOrigin(origin, host);
  const corsHeaders = buildCorsHeaders(cors.headerOrigin);

  if (!cors.allowed) {
    return jsonResponse({ error: 'Origin not allowed.' }, 403, corsHeaders);
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method === 'GET' && pathname === '/api/health') {
    const modelStatus = getPublicModelStatus();
    return jsonResponse(
      {
        ok: true,
        name: APP_NAME,
        creator: APP_CREATOR,
        status: modelStatus.label,
        ready: modelStatus.ready,
        activeRequests: getActiveGenerationCount(),
        timestamp: new Date().toISOString(),
      },
      200,
      corsHeaders
    );
  }

  if (request.method === 'GET' && pathname === '/api/model/status') {
    if (url.searchParams.get('init') === '1') {
      triggerBackgroundWarmup();
    }
    const status = getPublicModelStatus();
    return jsonResponse(status, 200, corsHeaders);
  }

  if (request.method === 'POST' && pathname === '/api/chat/stop') {
    try {
      const body = await request.json();
      const { requestId } = validateStopRequest(body);
      const stopped = stopGeneration(requestId);
      return jsonResponse({ stopped, requestId }, 200, corsHeaders);
    } catch (err) {
      const safe = toSafePublicError(err);
      return jsonResponse({ error: safe.message }, safe.statusCode, corsHeaders);
    }
  }

  if (
    request.method === 'POST' &&
    (pathname === '/api/chat' || pathname === '/api/chat/stream')
  ) {
    const clientKey = getClientKey(request);
    const rate = rateLimiter.check(clientKey);
    if (!rate.allowed) {
      return jsonResponse(
        { error: 'Rate limit reached. Please wait a moment before sending more messages.' },
        429,
        corsHeaders,
        { 'Retry-After': String(rate.retryAfterSeconds) }
      );
    }

    let validated;
    try {
      const body = await request.json();
      validated = validateChatRequest(body);
    } catch (err) {
      const safe = toSafePublicError(err);
      return jsonResponse({ error: safe.message }, safe.statusCode, corsHeaders);
    }

    const deadlineAt = requestDeadline();
    // Stop every downstream operation (model download included) before the
    // platform kills the function, so the client always receives a response.
    const budgetSignal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(Math.max(1_000, deadlineAt - Date.now() - 5_000)),
    ]);

    if (pathname === '/api/chat') {
      try {
        await ensureModelReady(budgetSignal);
        const result = await runCompletion(validated, budgetSignal, deadlineAt);
        return jsonResponse(
          {
            id: result.requestId,
            role: 'assistant',
            content: result.content,
            finishReason: result.finishReason,
          },
          200,
          corsHeaders
        );
      } catch (err) {
        const safe = toSafePublicError(err);
        return jsonResponse({ error: safe.message }, safe.statusCode, corsHeaders);
      }
    }

    // SSE Streaming endpoint: POST /api/chat/stream
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        const sendEvent = (event: string, payload: unknown) => {
          if (closed) return;
          const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
          try {
            controller.enqueue(encoder.encode(line));
          } catch {
            closed = true;
          }
        };

        try {
          sendEvent('status', { status: 'loading', label: 'Loading...' });
          await ensureModelReady(budgetSignal);
          sendEvent('start', { requestId: validated.requestId, status: 'ready' });

          const result = await streamGeneration(validated, {
            signal: budgetSignal,
            deadlineAt,
            onToken: (token) => {
              sendEvent('token', { token });
            },
          });

          sendEvent('done', {
            requestId: result.requestId,
            finishReason: result.finishReason,
          });
        } catch (err) {
          const safe = toSafePublicError(err);
          sendEvent('error', { error: safe.message, code: safe.statusCode });
        } finally {
          closed = true;
          try {
            controller.close();
          } catch {
            // The stream may already be closed by the client.
          }
        }
      },
      cancel() {
        // The browser aborted the SSE connection: stop the generation.
        stopGeneration(validated.requestId);
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...corsHeaders,
      },
    });
  }

  return jsonResponse({ error: 'Not found.' }, 404, corsHeaders);
}
