/**
 * Single-user login sessions.
 *
 * The frontend used to authenticate with `NEXT_PUBLIC_API_TOKEN`, which
 * Next.js compiles into the JavaScript bundle: anyone who could load the page
 * could read the token and call every route. The browser now logs in with
 * `APP_PASSWORD` and receives an HttpOnly session cookie that page scripts
 * cannot read. `API_TOKEN` remains for scripts and curl.
 *
 * Sessions are stateless: the cookie value is `v1.<expiresAtMs>.<hmac>`,
 * signed with `SESSION_SECRET`. Rotating `SESSION_SECRET` signs everyone out.
 * There is one user, so there is nothing per-user to store server-side.
 */
import crypto from 'crypto';

export const SESSION_COOKIE = 'tradingapp_session';
const VERSION = 'v1';

function sessionSecret(): string {
  return (process.env.SESSION_SECRET || '').trim();
}

export function appPassword(): string {
  return (process.env.APP_PASSWORD || '').trim();
}

/** True when browser login is possible (a password and a signing key). */
export function isLoginConfigured(): boolean {
  return appPassword().length > 0 && sessionSecret().length > 0;
}

export function sessionTtlMs(): number {
  const hours = Number(process.env.SESSION_TTL_HOURS ?? '12');
  return (Number.isFinite(hours) && hours > 0 ? hours : 12) * 3_600_000;
}

function sign(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Constant-time string comparison that does not leak length via timing. */
export function safeEqual(a: string, b: string): boolean {
  const aHash = crypto.createHash('sha256').update(a, 'utf8').digest();
  const bHash = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(aHash, bHash) && a.length === b.length;
}

export function checkPassword(supplied: unknown): boolean {
  const expected = appPassword();
  if (!expected || typeof supplied !== 'string') return false;
  return safeEqual(supplied, expected);
}

export function issueSession(now: number = Date.now()): { value: string; expiresAt: number } {
  const secret = sessionSecret();
  if (!secret) throw new Error('SESSION_SECRET is not set');
  const expiresAt = now + sessionTtlMs();
  const payload = `${VERSION}.${expiresAt}`;
  return { value: `${payload}.${sign(payload, secret)}`, expiresAt };
}

export function verifySession(value: string | undefined | null, now: number = Date.now()): boolean {
  const secret = sessionSecret();
  if (!secret || !value) return false;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  return safeEqual(parts[2], sign(`${parts[0]}.${parts[1]}`, secret));
}

/** Reads one cookie from a raw `Cookie` header. */
export function readCookie(header: string | string[] | undefined, name: string): string | null {
  const raw = Array.isArray(header) ? header.join('; ') : header;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function sessionCookie(value: string, maxAgeMs: number, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearedSessionCookie(secure: boolean): string {
  return sessionCookie('', 0, secure);
}

/**
 * Failed-login throttle, per client address. Five misses in fifteen minutes
 * locks that address out until the window passes.
 */
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60_000;
const failures = new Map<string, { count: number; firstAt: number }>();

export function loginLocked(key: string, now: number = Date.now()): boolean {
  const entry = failures.get(key);
  if (!entry) return false;
  if (now - entry.firstAt > WINDOW_MS) {
    failures.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

export function recordLoginFailure(key: string, now: number = Date.now()): void {
  const entry = failures.get(key);
  if (!entry || now - entry.firstAt > WINDOW_MS) {
    failures.set(key, { count: 1, firstAt: now });
  } else {
    entry.count += 1;
  }
}

export function clearLoginFailures(key: string): void {
  failures.delete(key);
}
