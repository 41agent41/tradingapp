import type { Request, Response, NextFunction } from 'express';

import { credentials } from '../services/credentials.js';
import {
  isLoginConfigured,
  readCookie,
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
 *   - an API token, sent as `Authorization: Bearer <token>` or `x-api-token`
 *     (scripts and curl): `API_TOKEN` in `.env`, or one created on the
 *     Security tab. It is never shipped to the browser.
 *
 * Auth is "configured" once there is a login password or an API token. Until
 * then a production backend refuses every request but the first-run setup
 * (`/api/auth/setup`), so whoever installs it sets the password before anyone
 * can use it; only local development runs open, with a loud warning.
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
  '/api/auth/setup',
]);

let warned = false;

export function isAuthConfigured(): boolean {
  return credentials.hasTokens('api') || isLoginConfigured();
}

function production(): boolean {
  return process.env.NODE_ENV === 'production';
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
  if (bearer && credentials.matchToken('api', bearer)) return true;
  return verifySession(readCookie(headers['cookie'], SESSION_COOKIE));
}

/** Decided per request, so setting the first password takes effect at once. */
export function createAuthMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (OPEN_PATHS.has(req.path) || req.method === 'OPTIONS') {
      return next();
    }
    if (!isAuthConfigured()) {
      if (!production()) {
        if (!warned) {
          console.warn(
            '[auth] no login password or API token is set: backend routes are ' +
              'UNAUTHENTICATED. Production refuses them until the first-run setup is done.'
          );
          warned = true;
        }
        return next();
      }
      if (!credentials.isLoaded()) {
        // A stored password may not have been read yet; never guess.
        return res.status(503).json({
          error: 'Starting',
          message: 'The backend is still reading its settings. Try again in a moment.',
          timestamp: new Date().toISOString(),
        });
      }
      return res.status(401).json({
        error: 'Setup required',
        message: 'Choose a login password on the setup screen first.',
        setup_required: true,
        timestamp: new Date().toISOString(),
      });
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
  if (!isAuthConfigured() && !production()) return null; // see the startup warning

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
