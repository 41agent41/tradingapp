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
 * Browser-side request-id generator. Uses `crypto.randomUUID` when present
 * (every browser shipped after early 2022 + Node 18+) and falls back to a
 * lightweight Math.random-based composer so older runtimes don't break.
 *
 * The backend treats this as opaque — it only validates length — so any
 * stable string works. Exporting it lets components hold their own id when
 * they care to correlate multiple calls.
 */
export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // RFC 4122 v4-shaped fallback.
  const tpl = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
  return tpl.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Drop-in replacement for `fetch` that:
 *
 *   - Prefixes relative paths with `NEXT_PUBLIC_API_URL` (so callers can
 *     just pass `/api/market-data/history`).
 *   - Attaches `Authorization: Bearer <NEXT_PUBLIC_API_TOKEN>` when a
 *     token is configured.
 *   - Attaches `X-Request-Id` (mints one if the caller didn't) so the
 *     backend can correlate logs and metrics for this call and propagate
 *     the id into the IB service.
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
  if (!merged.has('X-Request-Id')) {
    merged.set('X-Request-Id', newRequestId());
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
