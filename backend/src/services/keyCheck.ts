/**
 * Does SETTINGS_ENCRYPTION_KEY open the secrets this database holds?
 *
 * A rebuilt host pointed at an existing database with a freshly generated key
 * would otherwise start normally and then fail on every stored broker secret,
 * the MFA secret and the session key, one confusing error at a time. So on the
 * first start a known value is sealed under the key into `app_meta`, and every
 * later start must be able to open it. A database from before this check is
 * tested against a secret it already holds instead.
 */
import type { Querier } from './backtestRunRepository.js';
import { encryptionKey, openSecret, sealSecret } from '../config/secretBox.js';

const CHECK_KEY = 'encryption_key_check';
const CHECK_PLAINTEXT = 'tradingapp-encryption-key-check';

export interface KeyCheckResult {
  ok: boolean;
  /** What is wrong and how to fix it, when not ok. */
  reason?: string;
}

const FIX =
  'Put the SETTINGS_ENCRYPTION_KEY this database was set up with back in .env and restart. ' +
  'If that key is lost, run ./tradingapp.sh forget-secrets to clear what it sealed ' +
  '(broker credentials, the MFA secret and secret settings are then entered again).';

/** One sealed value already in the database, from any table that seals them. */
async function anySealedValue(db: Querier): Promise<string | null> {
  const sources = [
    `SELECT ciphertext FROM app_settings WHERE ciphertext IS NOT NULL LIMIT 1`,
    `SELECT ciphertext FROM broker_connections WHERE ciphertext IS NOT NULL LIMIT 1`,
    `SELECT ciphertext FROM auth_credentials WHERE ciphertext IS NOT NULL LIMIT 1`,
  ];
  for (const sql of sources) {
    const { rows } = await db.query(sql, []);
    if (rows?.[0]?.ciphertext) return rows[0].ciphertext;
  }
  return null;
}

export async function checkEncryptionKey(
  db: Querier,
  env: Record<string, string | undefined> = process.env
): Promise<KeyCheckResult> {
  let key: Buffer | null;
  try {
    key = encryptionKey(env);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  const { rows } = await db.query(`SELECT value FROM app_meta WHERE key = $1`, [CHECK_KEY]);
  const sealed: string | null = rows?.[0]?.value ?? (await anySealedValue(db));

  if (sealed) {
    if (!key) {
      return {
        ok: false,
        reason: `SETTINGS_ENCRYPTION_KEY is not set, but this database holds secrets sealed with one. ${FIX}`,
      };
    }
    try {
      openSecret(sealed, key);
    } catch {
      return {
        ok: false,
        reason: `SETTINGS_ENCRYPTION_KEY does not open the secrets in this database. ${FIX}`,
      };
    }
  }

  if (key && !rows?.[0]) {
    await db.query(
      `INSERT INTO app_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [CHECK_KEY, sealSecret(CHECK_PLAINTEXT, key)]
    );
  }
  return { ok: true };
}

/**
 * Clears everything sealed under the old key, for when it is lost. The
 * connections themselves stay (their secrets are entered again on the
 * Connections tab); stored secret settings, the MFA secret and the session key
 * go. Returns how many of each were cleared.
 */
export async function forgetSealedSecrets(db: Querier): Promise<Record<string, number>> {
  const settings = await db.query(
    `DELETE FROM app_settings WHERE ciphertext IS NOT NULL RETURNING key`,
    []
  );
  const connections = await db.query(
    `UPDATE broker_connections SET ciphertext = NULL, updated_at = NOW()
      WHERE ciphertext IS NOT NULL RETURNING id`,
    []
  );
  const credentials = await db.query(
    `DELETE FROM auth_credentials WHERE ciphertext IS NOT NULL RETURNING id`,
    []
  );
  await db.query(`DELETE FROM app_meta WHERE key = $1`, [CHECK_KEY]);
  return {
    secret_settings: settings.rows?.length ?? 0,
    connection_secrets: connections.rows?.length ?? 0,
    credentials: credentials.rows?.length ?? 0,
  };
}
