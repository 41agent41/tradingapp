/**
 * Which browser origins the backend accepts, and which proxies it believes
 * about a caller's address. Both are set on the Settings page (Network) and
 * read on every request, so a save applies without a restart; a value in
 * `.env` still wins, as for every setting.
 *
 *   - `CORS_ORIGINS`: comma-separated origins. Empty (the default) or `*`
 *     accepts any origin. The app's own pages reach the backend through the
 *     frontend server, so this only matters for other sites calling the API
 *     from a browser.
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

/** The allowed origins, or null when any origin is accepted. */
export function allowedOrigins(get = (k: string) => configService.get(k)): string[] | null {
  const origins = list(get('CORS_ORIGINS'));
  return origins.length === 0 || origins.includes('*') ? null : origins;
}

/** Whether a browser request from `origin` is accepted. No Origin header is. */
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
