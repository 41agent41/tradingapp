import type { Request, Response, NextFunction } from 'express';

import {
  isLoginConfigured,
  readCookie,
  safeEqual,
  SESSION_COOKIE,
  verifySession,
} from '../services/session.js';

/**
 * Backend authentication.
 *
 * A request is authenticated by either credential:
 *
 *   - a session cookie issued by `POST /api/auth/login` (the browser; see
 *     `services/session.ts`), or
 *   - `API_TOKEN`, sent as `Authorization: Bearer <token>` or `x-api-token`
 *     (scripts and curl). It is never shipped to the browser.
 *
 * Auth is "configured" when `API_TOKEN` is set or login is configured
 * (`APP_PASSWORD` + `SESSION_SECRET`). When neither is, the middleware lets
 * everything through with a loud warning; `startupChecks.ts` refuses to
 * start that way in production, so only local development runs open.
 *
 * Paths in `OPEN_PATHS` skip the check: liveness probes, the scrape endpoint
 * and the login routes themselves.
 */

export const OPEN_PATHS = new Set<string>([
  '/',
  '/api/health',
  '/api/database/health',
  '/metrics',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/session',
]);

let warned = false;

function apiToken(): string {
  return (process.env.API_TOKEN || '').trim();
}

export function isAuthConfigured(): boolean {
  return apiToken().length > 0 || isLoginConfigured();
}

function extractToken(req: Request): string | null {
  const header = req.headers['authorization'];
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const token = req.headers['x-api-token'];
  if (typeof token === 'string' && token.trim().length > 0) {
    return token.trim();
  }
  return null;
}

/** True when the supplied headers carry a valid session cookie or API token. */
export function isAuthenticated(
  headers: Record<string, string | string[] | undefined>,
  bearer: string | null
): boolean {
  const expected = apiToken();
  if (expected && bearer && safeEqual(bearer, expected)) return true;
  return verifySession(readCookie(headers['cookie'], SESSION_COOKIE));
}

export function createAuthMiddleware() {
  if (!isAuthConfigured()) {
    if (!warned) {
      console.warn(
        '[auth] neither API_TOKEN nor APP_PASSWORD is set: backend routes are ' +
          'UNAUTHENTICATED. This is refused in production.'
      );
      warned = true;
    }
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  console.log('[auth] authentication enforced (session cookie or API token)');

  return (req: Request, res: Response, next: NextFunction) => {
    if (OPEN_PATHS.has(req.path) || req.method === 'OPTIONS') {
      return next();
    }
    if (isAuthenticated(req.headers, extractToken(req))) {
      return next();
    }
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Log in, or send a valid API token (Authorization: Bearer <token>).',
      timestamp: new Date().toISOString(),
    });
  };
}

/**
 * Socket.IO handshake guard. Accepts the session cookie (browsers connect
 * with `withCredentials`) or the API token from `auth.token`, the
 * `Authorization` header, or the `token` query parameter. Returns `null` on
 * success, an Error on failure (surfaced to the client as `connect_error`).
 */
export function checkSocketAuth(
  authPayload: unknown,
  headers: Record<string, string | string[] | undefined>,
  query: Record<string, unknown>
): Error | null {
  if (!isAuthConfigured()) return null; // disabled; see the startup warning

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

  const bearer = fromAuth || fromHeader || fromQuery || null;
  return isAuthenticated(headers, bearer) ? null : new Error('Unauthorized');
}
