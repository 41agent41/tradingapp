import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

/**
 * Bearer-token authentication for the backend.
 *
 * Behaviour:
 *
 *   - If `API_TOKEN` is **not** set in the environment, the middleware is
 *     disabled and every request is allowed through. A loud warning is
 *     printed at startup so this configuration is never silent. This
 *     preserves backward compatibility for existing deployments that
 *     haven't rolled out a token yet — see GAP_ANALYSIS.md §3.7.
 *
 *   - If `API_TOKEN` **is** set, every request must carry one of:
 *
 *         Authorization: Bearer <token>
 *         x-api-token:    <token>
 *
 *     The token is compared with `crypto.timingSafeEqual` so the
 *     comparison is constant-time.
 *
 *   - Paths in `OPEN_PATHS` skip the check so liveness probes and the
 *     unauthenticated health endpoints remain reachable.
 */

const OPEN_PATHS = new Set<string>(['/', '/api/health', '/api/database/health']);

let warned = false;

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    // Still do a constant-time op on something we throw away so we don't
    // leak length information via early-exit timing.
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function extractToken(req: Request): string | null {
  const header = req.headers['authorization'];
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const apiToken = req.headers['x-api-token'];
  if (typeof apiToken === 'string' && apiToken.trim().length > 0) {
    return apiToken.trim();
  }
  return null;
}

export function createAuthMiddleware() {
  const expected = (process.env.API_TOKEN || '').trim();

  if (!expected) {
    if (!warned) {
      console.warn(
        '[auth] API_TOKEN is not set — backend routes are UNAUTHENTICATED. ' +
          'Set API_TOKEN in your .env to require Bearer-token auth.'
      );
      warned = true;
    }
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  console.log('[auth] API_TOKEN enforcement enabled');

  return (req: Request, res: Response, next: NextFunction) => {
    if (OPEN_PATHS.has(req.path)) {
      return next();
    }

    const supplied = extractToken(req);
    if (!supplied || !safeEqual(supplied, expected)) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'A valid Bearer token (Authorization: Bearer <token>) is required.',
        timestamp: new Date().toISOString(),
      });
    }

    return next();
  };
}

/**
 * Socket.IO handshake guard. Reads the token from `auth.token`, the
 * `Authorization` header, or the `token` query parameter. Returns
 * `null` on success, an Error on failure (which Socket.IO surfaces to
 * the client as a `connect_error`).
 */
export function checkSocketAuth(
  authPayload: unknown,
  headers: Record<string, string | string[] | undefined>,
  query: Record<string, unknown>
): Error | null {
  const expected = (process.env.API_TOKEN || '').trim();
  if (!expected) return null; // disabled — see warning above

  const fromAuth =
    typeof authPayload === 'object' &&
    authPayload !== null &&
    'token' in (authPayload as Record<string, unknown>)
      ? String((authPayload as Record<string, unknown>).token)
      : '';

  const authHeader = headers['authorization'];
  const fromHeader =
    typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : '';

  const fromQuery = typeof query['token'] === 'string' ? (query['token'] as string).trim() : '';

  const supplied = fromAuth || fromHeader || fromQuery;
  if (!supplied || !safeEqual(supplied, expected)) {
    return new Error('Unauthorized');
  }
  return null;
}
