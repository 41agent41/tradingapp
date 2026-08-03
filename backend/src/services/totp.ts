/**
 * Minimal RFC 6238 TOTP verification (dependency-free).
 *
 * Used to add a second factor to order-mutating endpoints. The shared secret
 * lives in `ORDER_MFA_SECRET` (base32, as emitted by authenticator apps).
 * We intentionally implement this with Node's `crypto` rather than pull in a
 * dependency — the algorithm is small and the codebase pins its deps.
 *
 * SHA-1 / 30-second step / 6 digits are the authenticator-app defaults.
 */
import crypto from 'crypto';

const STEP_SECONDS = 30;
const DIGITS = 6;
// Accept the adjacent windows too, to tolerate clock skew between the server
// and the user's device (±30s).
const DEFAULT_WINDOW = 1;

/** Decode an RFC 4648 base32 string (case-insensitive, padding/space tolerant). */
function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of cleaned) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) throw new Error('invalid base32 character in TOTP secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** HOTP value for a given counter (RFC 4226 dynamic truncation). */
function hotp(key: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  // 53-bit-safe big-endian write of the counter.
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Verify a 6-digit TOTP `code` against a base32 `secret`. Checks the current
 * time window plus `window` steps on each side. Returns false (never throws)
 * on malformed input so callers can treat everything but `true` as a reject.
 */
export function verifyTotp(secret: string, code: string, window = DEFAULT_WINDOW): boolean {
  if (!secret || typeof code !== 'string') return false;
  const trimmed = code.trim();
  if (!/^\d{6}$/.test(trimmed)) return false;

  let key: Buffer;
  try {
    key = base32Decode(secret);
  } catch {
    return false;
  }
  if (key.length === 0) return false;

  const counter = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  for (let w = -window; w <= window; w++) {
    if (timingSafeEqualStr(hotp(key, counter + w), trimmed)) {
      return true;
    }
  }
  return false;
}

/** True when order-endpoint MFA is configured (an `ORDER_MFA_SECRET` is set). */
export function isMfaConfigured(): boolean {
  return (process.env.ORDER_MFA_SECRET || '').trim().length > 0;
}
