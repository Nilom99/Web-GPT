import type { Context } from '@netlify/functions';
import { handleApiRequest } from '../../backend/router';

export default async function handler(request: Request, _context: Context): Promise<Response> {
  return handleApiRequest(request);
}
