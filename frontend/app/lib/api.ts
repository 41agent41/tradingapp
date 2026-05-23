/**
 * Shared API client for the TradingApp frontend.
 *
 * Two responsibilities:
 *
 *   1. Build URLs against `NEXT_PUBLIC_API_URL` (the backend base URL).
 *   2. Attach the bearer token from `NEXT_PUBLIC_API_TOKEN` to every
 *      request so backend routes can authenticate the caller. If the
 *      env var is unset, no token is attached — this preserves backward
 *      compatibility with deployments that haven't enabled API_TOKEN on
 *      the backend yet.
 *
 * Every component should use `apiFetch` instead of calling the global
 * `fetch` directly. The two exported helpers (`apiUrl`, `apiToken`) are
 * also exposed for the small number of call sites (Socket.IO, the IB
 * service direct calls) that can't go through `apiFetch`.
 */

const RAW_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const TOKEN = process.env.NEXT_PUBLIC_API_TOKEN || '';

function trimTrailing(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

export const apiBaseUrl: string = trimTrailing(RAW_BASE);
export const apiToken: string = TOKEN;

/** Returns the configured backend base URL (no trailing slash). */
export function apiUrl(path: string = ''): string {
  if (!path) return apiBaseUrl;
  return path.startsWith('/') ? `${apiBaseUrl}${path}` : `${apiBaseUrl}/${path}`;
}

export interface ApiFetchInit extends RequestInit {
  /** When true, treat `path` as an absolute URL and skip prefixing. */
  absolute?: boolean;
  /**
   * Skip attaching the Authorization header. Use only for endpoints that
   * are intentionally unauthenticated (e.g. `/api/health`).
   */
  skipAuth?: boolean;
}

/**
 * Drop-in replacement for `fetch` that:
 *
 *   - Prefixes relative paths with `NEXT_PUBLIC_API_URL` (so callers can
 *     just pass `/api/market-data/history`).
 *   - Attaches `Authorization: Bearer <NEXT_PUBLIC_API_TOKEN>` when a
 *     token is configured.
 *   - Preserves any caller-supplied headers (including the existing
 *     `X-Data-Query-Enabled` toggle).
 */
export function apiFetch(pathOrUrl: string, init: ApiFetchInit = {}): Promise<Response> {
  const { absolute, skipAuth, headers: callerHeaders, ...rest } = init;

  const url = absolute || /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : apiUrl(pathOrUrl);

  const merged = new Headers(callerHeaders);
  if (!skipAuth && TOKEN && !merged.has('Authorization')) {
    merged.set('Authorization', `Bearer ${TOKEN}`);
  }

  return fetch(url, { ...rest, headers: merged });
}

/**
 * Convenience helper for the Socket.IO client.
 *
 *   import { io } from 'socket.io-client';
 *   const socket = io(apiBaseUrl, socketAuth());
 */
export function socketAuth(): { auth?: { token: string } } {
  return TOKEN ? { auth: { token: TOKEN } } : {};
}
