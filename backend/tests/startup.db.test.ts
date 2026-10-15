/**
 * Migrations and the encryption-key check against a real TimescaleDB.
 *
 * Builds a brand-new database from nothing, the way a clean install starts, so
 * the schema file has to apply in one batch exactly as the backend runs it.
 * Runs only with DB_TESTS=1 and the POSTGRES_* variables pointing at a server
 * where that user may create databases (CI provides one); otherwise skipped.
 */
import { Pool } from 'pg';
import { checkEncryptionKey, forgetSealedSecrets } from '../src/services/keyCheck.js';
import { BASELINE_VERSION, runMigrations } from '../src/services/migrations.js';
import { sealSecret } from '../src/config/secretBox.js';

const run = process.env.DB_TESTS === '1' ? describe : describe.skip;

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const dbName = `startup_test_${Date.now().toString(36)}`;

function pool(database: string) {
  return new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: Number(process.env.POSTGRES_PORT || 5432),
    user: process.env.POSTGRES_USER || 'tradingapp',
    password: process.env.POSTGRES_PASSWORD || '',
    database,
  });
}

run('startup against a real database', () => {
  jest.setTimeout(120000);
  const admin = pool(process.env.POSTGRES_DB || 'tradingapp');
  let db: Pool;

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE ${dbName}`);
    db = pool(dbName);
  });

  afterAll(async () => {
    await db?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  it('builds an empty database from the schema files and records them', async () => {
    const client = await db.connect();
    try {
      const first = await runMigrations(client);
      expect(first.applied[0]).toBe(BASELINE_VERSION);
      expect(first.applied).toContain('001_app_meta');

      const second = await runMigrations(client);
      expect(second.applied).toEqual([]);
    } finally {
      client.release();
    }

    const tables = await db.query(
      `SELECT to_regclass('candlestick_data') AS bars, to_regclass('app_meta') AS meta,
              to_regclass('daily_candlestick_data') AS daily`
    );
    expect(tables.rows[0]).toEqual({
      bars: 'candlestick_data',
      meta: 'app_meta',
      daily: 'daily_candlestick_data',
    });
  });

  it('records the key on first start and refuses a different one', async () => {
    expect(await checkEncryptionKey(db, { SETTINGS_ENCRYPTION_KEY: KEY_A })).toEqual({ ok: true });
    expect(await checkEncryptionKey(db, { SETTINGS_ENCRYPTION_KEY: KEY_A })).toEqual({ ok: true });

    const wrong = await checkEncryptionKey(db, { SETTINGS_ENCRYPTION_KEY: KEY_B });
    expect(wrong.ok).toBe(false);
    expect(wrong.reason).toMatch(/does not open the secrets/);

    const missing = await checkEncryptionKey(db, {});
    expect(missing.ok).toBe(false);
    expect(missing.reason).toMatch(/not set/);
  });

  it('checks a database from before the check against a secret it already holds', async () => {
    await db.query(`DELETE FROM app_meta`);
    await db.query(
      `INSERT INTO broker_connections (platform, account, ciphertext) VALUES ('oanda', 'p1', $1)`,
      [sealSecret('{"token":"x"}', Buffer.from(KEY_A, 'hex'))]
    );

    expect((await checkEncryptionKey(db, { SETTINGS_ENCRYPTION_KEY: KEY_B })).ok).toBe(false);
    expect((await checkEncryptionKey(db, { SETTINGS_ENCRYPTION_KEY: KEY_A })).ok).toBe(true);
  });

  it('starts with a new key once the old secrets are forgotten', async () => {
    const cleared = await forgetSealedSecrets(db);
    expect(cleared.connection_secrets).toBe(1);

    expect(await checkEncryptionKey(db, { SETTINGS_ENCRYPTION_KEY: KEY_B })).toEqual({ ok: true });
    const kept = await db.query(`SELECT account, ciphertext FROM broker_connections`);
    expect(kept.rows).toEqual([{ account: 'p1', ciphertext: null }]);
  });
});
