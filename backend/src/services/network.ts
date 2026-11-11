/**
 * Which browser origins the backend accepts, and which proxies it believes
 * about a caller's address. Both are set on the Settings page (Network) and
 * read on every request, so a save applies without a restart; a value in
 * `.env` still wins, as for every setting.
 *
 *   - `CORS_ORIGINS`: comma-separated origins of other sites whose pages
 *     may call the API from a browser. Empty (the default) accepts none of
 *     them. The app's own pages need nothing here: they reach the backend
 *     through the frontend server, which drops the Origin of its own pages'
 *     requests (frontend/backendProxy.js), so they arrive with none. `*`
 *     accepts any origin, with the session cookie, and is warned about at
 *     startup (S-04).
 *   - `TRUST_PROXY`: addresses of reverse proxies in front of the app whose
 *     `X-Forwarded-For` is believed. The frontend container, which forwards
 *     every browser call, is always trusted (`FRONTEND_PROXY_ADDRESS`, set by
 *     compose), so this is only for a proxy in front of the frontend.
 */
import { configService } from '../config/configService.js';

function list(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The other sites' origins that are accepted: none when unset, or null when
 * any origin is (`*`).
 */
export function allowedOrigins(get = (k: string) => configService.get(k)): string[] | null {
  const origins = list(get('CORS_ORIGINS'));
  return origins.includes('*') ? null : origins;
}

/** A warning when any origin is accepted, or null. */
export function openOriginsWarning(get = (k: string) => configService.get(k)): string | null {
  return allowedOrigins(get) === null
    ? 'CORS_ORIGINS=* accepts requests from any website with the session cookie. ' +
        "List the origins that need it, or leave it empty for the app's own pages only " +
        '(Settings > Network).'
    : null;
}

/**
 * Whether a browser request from `origin` is accepted. A request with no
 * Origin header is: the app's own pages (through the frontend server), curl
 * and other servers send none.
 */
export function originAllowed(
  origin: string | undefined,
  get = (k: string) => configService.get(k)
): boolean {
  if (!origin) return true;
  const allowed = allowedOrigins(get);
  return allowed === null || allowed.includes(origin);
}

/** The addresses to pass to Express's `trust proxy`, or false for none. */
export function trustedProxies(
  get = (k: string) => configService.get(k),
  env: Record<string, string | undefined> = process.env
): string[] | false {
  const proxies = [...list(env.FRONTEND_PROXY_ADDRESS), ...list(get('TRUST_PROXY'))];
  return proxies.length > 0 ? [...new Set(proxies)] : false;
}
