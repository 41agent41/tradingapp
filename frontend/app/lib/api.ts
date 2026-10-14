/**
 * Shared API client for the TradingApp frontend.
 *
 * Responsibilities:
 *
 *   1. Build URLs on the page's own origin: the frontend server forwards
 *      `/api` and `/socket.io` to the backend (frontend/server.js), so the
 *      backend's address is not built into the bundle. `NEXT_PUBLIC_API_URL`
 *      still overrides this for a frontend run against a backend elsewhere.
 *   2. Send the login session cookie with every request
 *      (`credentials: 'include'`). The cookie is HttpOnly, so no credential
 *      is ever readable by page scripts or compiled into the bundle.
 *   3. Send the browser to `/login` when the backend answers 401.
 *
 * Every component should use `apiFetch` instead of calling the global
 * `fetch` directly. `apiUrl` and `socketAuth` are exported for the Socket.IO
 * clients, which can't go through `apiFetch`.
 */

const RAW_BASE = process.env.NEXT_PUBLIC_API_URL || '';

function trimTrailing(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

export const apiBaseUrl: string = trimTrailing(RAW_BASE);

/** A backend URL: relative (same origin) unless `NEXT_PUBLIC_API_URL` is set. */
export function apiUrl(path: string = ''): string {
  if (!path) return apiBaseUrl;
  return path.startsWith('/') ? `${apiBaseUrl}${path}` : `${apiBaseUrl}/${path}`;
}

export interface ApiFetchInit extends RequestInit {
  /** When true, treat `path` as an absolute URL and skip prefixing. */
  absolute?: boolean;
  /**
   * Don't redirect to the login page on a 401. Used by the login page and
   * the session probe, which handle 401 themselves.
   */
  skipAuthRedirect?: boolean;
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
 *   - Resolves paths like `/api/market-data/history` against the page's
 *     origin (or `NEXT_PUBLIC_API_URL` when set).
 *   - Sends the session cookie (`credentials: 'include'`).
 *   - Attaches `X-Request-Id` (mints one if the caller didn't) so the
 *     backend can correlate logs and metrics for this call and propagate
 *     the id into the broker service.
 *   - Preserves any caller-supplied headers (including the existing
 *     `X-Data-Query-Enabled` toggle).
 *   - Redirects to `/login` on a 401, unless `skipAuthRedirect` is set.
 */
export async function apiFetch(pathOrUrl: string, init: ApiFetchInit = {}): Promise<Response> {
  const { absolute, skipAuthRedirect, headers: callerHeaders, ...rest } = init;

  const url = absolute || /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : apiUrl(pathOrUrl);

  const merged = new Headers(callerHeaders);
  if (!merged.has('X-Request-Id')) {
    merged.set('X-Request-Id', newRequestId());
  }

  const res = await fetch(url, { credentials: 'include', ...rest, headers: merged });
  if (res.status === 401 && !skipAuthRedirect) {
    redirectToLogin();
  }
  return res;
}

/** Sends the browser to the login page, remembering where it was. */
export function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  const { pathname, search } = window.location;
  if (pathname.startsWith('/login')) return;
  const next = encodeURIComponent(`${pathname}${search}`);
  window.location.assign(`/login?next=${next}`);
}

/**
 * Socket.IO client options that authenticate the handshake with the
 * session cookie.
 *
 *   import { io } from 'socket.io-client';
 *   const socket = io(socketUrl(), { ...socketAuth() });
 */
/** Where Socket.IO connects: the page's own origin unless overridden. */
export function socketUrl(): string {
  if (apiBaseUrl) return apiBaseUrl;
  return typeof window === 'undefined' ? '' : window.location.origin;
}

export function socketAuth(): { withCredentials: true } {
  return { withCredentials: true };
}
