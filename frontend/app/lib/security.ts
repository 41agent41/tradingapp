/**
 * Types and pure helpers for Settings > Security (`/api/security`), kept out
 * of the component so they can be unit-tested.
 */

export type CredentialSource = 'environment' | 'database' | 'unset';
export type TokenKind = 'api' | 'trading';

export interface TokenView {
  id: string;
  kind: TokenKind;
  label: string;
  prefix: string;
  created_at: string;
  created_by: string | null;
  last_used_at: string | null;
}

export interface SecurityPayload {
  password: { source: CredentialSource; min_length: number };
  tokens: { api: TokenView[]; trading: TokenView[]; env: { api: number; trading: number } };
  mfa: { source: CredentialSource };
  auth: { trading_auth_required: boolean; mfa_required: boolean };
  status: { loaded: boolean; error: string | null; encryption_key: boolean };
}

export const TOKEN_KINDS: { kind: TokenKind; title: string; help: string }[] = [
  {
    kind: 'trading',
    title: 'Trading tokens',
    help: 'Grant the trader role: needed, with an MFA code, to place orders and make protected changes.',
  },
  {
    kind: 'api',
    title: 'API tokens',
    help: 'For scripts and curl (Authorization: Bearer). They cannot place orders without a trading token.',
  },
];

/** Problems with a new password, or null when it can be saved. */
export function passwordProblem(
  password: string,
  confirm: string,
  minLength: number
): string | null {
  if (password.length < minLength) return `Use at least ${minLength} characters.`;
  if (password !== confirm) return 'The two passwords do not match.';
  return null;
}

/** "never", or a short relative time for a token's last use. */
export function lastUsed(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never used';
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 2) return 'used just now';
  if (minutes < 120) return `used ${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `used ${hours} hours ago`;
  return `used ${Math.round(hours / 24)} days ago`;
}

/** A base32 secret in groups of four, as authenticator apps show them. */
export function groupSecret(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(' ');
}

/** What the MFA row says. */
export function mfaSummary(source: CredentialSource): string {
  if (source === 'environment') return 'On, from ORDER_MFA_SECRET in .env';
  if (source === 'database') return 'On';
  return 'Off';
}

/** A login session, as `GET /api/auth/sessions` lists it. */
export interface SessionView {
  /** The start of the session's id: enough to name it, not to use it. */
  id: string;
  created_at: string;
  expires_at: string;
  ip: string | null;
  user_agent: string | null;
  /** The session this browser is signed in with. */
  current: boolean;
}

/** "Firefox on Windows" from a User-Agent header, as far as it can be told. */
export function describeBrowser(userAgent: string | null): string {
  const ua = userAgent ?? '';
  if (!ua) return 'Unknown browser';
  // Order matters: Edge and Chrome both say "Safari", Edge also says "Chrome".
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\/|CriOS\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : null;
  const system = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  if (!browser) return ua.split(/[\s/]/)[0].slice(0, 40) || 'Unknown browser';
  return system ? `${browser} on ${system}` : browser;
}

/** "signed in 3 hours ago", for the sessions list. */
export function signedIn(iso: string, now: number = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 2) return 'signed in just now';
  if (minutes < 120) return `signed in ${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `signed in ${hours} hours ago`;
  return `signed in ${Math.round(hours / 24)} days ago`;
}
