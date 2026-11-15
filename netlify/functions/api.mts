import type { Context } from '@netlify/functions';
import { handleApiRequest } from '../../backend/router';

/**
 * Single entry point for every `/api/*` route. Routing is configured in
 * `netlify.toml`:
 *
 *   [[redirects]]
 *     from = "/api/*"
 *     to = "/.netlify/functions/api/:splat"
 *
 * The GGUF model is deliberately not part of this bundle. It is published as a
 * static asset of the site and downloaded into the execution environment cache
 * (and checksum-verified) the first time inference is needed.
 */
export default async function handler(request: Request, _context: Context): Promise<Response> {
  try {
    return await handleApiRequest(request);
  } catch (err) {
    console.error('[api] unhandled error:', err instanceof Error ? err.message : err);
    return new Response(
      JSON.stringify({ error: 'Unable to handle the request right now.' }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      }
    );
  }
}
