/**
 * `settings import`: what .env holds today lands in the store unchanged (same
 * password, tokens, MFA and session key), a re-run changes nothing, and what
 * cannot be stored is reported as staying in .env.
 */
import { importFromEnv } from '../src/cli/importSettings.js';
import { ConfigService } from '../src/config/configService.js';
import { CredentialStore } from '../src/services/credentials.js';
import { credentialsDb } from './helpers/credentialsDb.js';

const KEY = 'a'.repeat(64);

/** The credentials fake, plus just enough of `app_settings`. */
function fakeDb() {
  const creds = credentialsDb();
  const settings = new Map<string, any>();
  const query = async (text: string, params: any[] = []) => {
    if (text.startsWith('CREATE TABLE')) return { rows: [] };
    if (text.startsWith('SELECT key, value, ciphertext')) return { rows: [...settings.values()] };
    if (text.includes('INSERT INTO app_settings')) {
      const [key, value, ciphertext, actor] = params;
      settings.set(key, {
        key,
        value,
        ciphertext,
        version: 1,
        updated_at: new Date(),
        updated_by: actor,
      });
      return { rows: [] };
    }
    return creds.query(text, params);
  };
  return { db: { query }, creds, settings };
}

const ENV = {
  SETTINGS_ENCRYPTION_KEY: KEY,
  APP_PASSWORD: 'correct horse battery staple',
  SESSION_SECRET: 'b'.repeat(64),
  API_TOKEN: 'script-token-1234',
  TRADING_TOKENS: 'trader-1, trader-2',
  ORDER_MFA_SECRET: 'JBSWY3DPEHPK3PXP',
  PROMOTION_MIN_TRADES: '40',
  TELEGRAM_BOT_TOKEN: '123:abc',
  LIVE_TRADING_ENABLED: 'false',
  POSTGRES_HOST: 'db',
};

describe('importFromEnv', () => {
  it('stores what .env holds so the lines can go', async () => {
    const { db } = fakeDb();
    const result = await importFromEnv(Object.keys(ENV), ENV, db);

    expect(result.imported.sort()).toEqual(
      [
        'APP_PASSWORD',
        'SESSION_SECRET',
        'API_TOKEN',
        'TRADING_TOKENS',
        'ORDER_MFA_SECRET',
        'PROMOTION_MIN_TRADES',
        'TELEGRAM_BOT_TOKEN',
      ].sort()
    );
    expect(result.kept.map((k) => k.key)).toEqual(['LIVE_TRADING_ENABLED']);

    // A store that no longer sees those keys in .env behaves the same.
    const after = new CredentialStore({ SETTINGS_ENCRYPTION_KEY: KEY });
    after.attach(db);
    await after.load();
    expect(after.verifyPassword(ENV.APP_PASSWORD)).toBe(true);
    expect(after.sessionSecret()).toBe(ENV.SESSION_SECRET);
    expect(after.matchToken('api', 'script-token-1234')).toBe(true);
    expect(after.matchToken('trading', 'trader-2')).toBe(true);
    expect(after.mfaSecret()).toBe(ENV.ORDER_MFA_SECRET);

    const config = new ConfigService({ SETTINGS_ENCRYPTION_KEY: KEY });
    config.attach(db);
    await config.refresh();
    expect(config.get('PROMOTION_MIN_TRADES')).toBe('40');
    expect(config.get('TELEGRAM_BOT_TOKEN')).toBe('123:abc');
  });

  it('changes nothing on a second run', async () => {
    const { db, creds, settings } = fakeDb();
    await importFromEnv(Object.keys(ENV), ENV, db);
    const audits = creds.audit.length;
    const versions = [...settings.values()].map((r) => r.updated_at);

    const again = await importFromEnv(Object.keys(ENV), ENV, db);
    expect(again.kept.map((k) => k.key)).toEqual(['LIVE_TRADING_ENABLED']);
    expect(creds.audit.length).toBe(audits);
    expect([...settings.values()].map((r) => r.updated_at)).toEqual(versions);
  });

  it('only looks at the keys it is given', async () => {
    const { db } = fakeDb();
    const result = await importFromEnv(['PROMOTION_MIN_TRADES'], ENV, db);
    expect(result.imported).toEqual(['PROMOTION_MIN_TRADES']);
  });

  it('keeps in .env what it cannot store', async () => {
    const { db } = fakeDb();
    const env = {
      APP_PASSWORD: 'short',
      ORDER_MFA_SECRET: 'JBSWY3DPEHPK3PXP',
      PROMOTION_MIN_TRADES: 'lots',
    };
    const result = await importFromEnv(Object.keys(env), env, db);
    const kept = Object.fromEntries(result.kept.map((k) => [k.key, k.reason]));
    expect(kept.APP_PASSWORD).toMatch(/shorter than 12/);
    expect(kept.ORDER_MFA_SECRET).toMatch(/SETTINGS_ENCRYPTION_KEY/);
    expect(kept.PROMOTION_MIN_TRADES).toBeDefined();
    expect(result.imported).toEqual([]);
  });

  it('lets an empty line go', async () => {
    const { db } = fakeDb();
    const env = { API_TOKEN: '', BACKFILL_ENABLED: '' };
    const result = await importFromEnv(Object.keys(env), env, db);
    expect(result.imported).toEqual(['API_TOKEN', 'BACKFILL_ENABLED']);
  });

  it('keeps a key the running backend has not loaded', async () => {
    const { db } = fakeDb();
    const result = await importFromEnv(['API_TOKEN', 'BACKFILL_ENABLED'], {}, db);
    expect(result.imported).toEqual([]);
    expect(result.kept.map((k) => k.reason)).toEqual([
      expect.stringMatching(/redeploy/),
      expect.stringMatching(/redeploy/),
    ]);
  });
});
