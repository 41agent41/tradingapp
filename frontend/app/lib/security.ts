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
