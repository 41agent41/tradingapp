/**
 * Encryption for secret settings stored in the database.
 *
 * AES-256-GCM under `SETTINGS_ENCRYPTION_KEY`, which stays in `.env` on
 * purpose: kept in the same database as the ciphertext, a backup would carry
 * both the lock and the key. Lose the key and every stored secret has to be
 * entered again; the rest of the settings are unaffected.
 *
 * Stored form: `v1:<iv b64>:<tag b64>:<ciphertext b64>`. The version prefix
 * leaves room to rotate to a new key without a flag day.
 */
import crypto from 'crypto';

const VERSION = 'v1';

export class SecretBoxError extends Error {}

/**
 * Reads the key: 64 hex characters, or base64 of 32 bytes. Returns null when
 * unset, and throws on a value that is set but unusable, so a typo is loud.
 */
export function encryptionKey(
  env: Record<string, string | undefined> = process.env
): Buffer | null {
  const raw = (env.SETTINGS_ENCRYPTION_KEY || '').trim();
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  const b64 = Buffer.from(raw, 'base64');
  if (b64.length === 32) return b64;
  throw new SecretBoxError(
    'SETTINGS_ENCRYPTION_KEY must be 64 hex characters or base64 of 32 bytes (openssl rand -hex 32).'
  );
}

export function sealSecret(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), body.toString('base64')].join(
    ':'
  );
}

export function openSecret(sealed: string, key: Buffer): string {
  const parts = sealed.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretBoxError('unrecognised secret format');
  }
  const [, ivB64, tagB64, bodyB64] = parts;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(bodyB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new SecretBoxError('secret could not be decrypted (wrong SETTINGS_ENCRYPTION_KEY?)');
  }
}
