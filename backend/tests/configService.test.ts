/**
 * ConfigService: `.env` over the database over the consumer's default, with
 * secrets encrypted at rest and every write audited.
 */
import { ConfigService } from '../src/config/configService.js';
import { openSecret } from '../src/config/secretBox.js';

const KEY_HEX = 'a'.repeat(64);

interface Row {
  key: string;
  value: string | null;
  ciphertext: string | null;
  version: number;
  updated_at: Date;
  updated_by: string | null;
}

/** A stand-in for Postgres that understands the service's four statements. */
function fakeDb() {
  const rows = new Map<string, Row>();
  const audit: any[] = [];
  const db = {
    rows,
    audit,
    failReads: false,
    async query(text: string, params: unknown[] = []) {
      if (text.startsWith('SELECT key, value, ciphertext')) {
        if (db.failReads) throw new Error('relation "app_settings" does not exist');
        return { rows: [...rows.values()] };
      }
      if (text.includes('INSERT INTO app_settings')) {
        const [key, value, ciphertext, actor, newShown, ip, reason] = params as any[];
        const prev = rows.get(key);
        rows.set(key, {
          key,
          value,
          ciphertext,
          version: (prev?.version ?? 0) + 1,
          updated_at: new Date('2026-10-14T00:00:00Z'),
          updated_by: actor,
        });
        audit.push({
          key,
          action: 'set',
          old_value: prev ? (prev.ciphertext ? '(secret)' : prev.value) : null,
          new_value: newShown,
          changed_by: actor,
          source_ip: ip,
          reason,
        });
        return { rows: [] };
      }
      if (text.includes('DELETE FROM app_settings')) {
        const [key, def, actor, ip, reason] = params as any[];
        const prev = rows.get(key);
        if (prev) {
          rows.delete(key);
          audit.push({
            key,
            action: 'clear',
            old_value: prev.value,
            new_value: def,
            changed_by: actor,
            source_ip: ip,
            reason,
          });
        }
        return { rows: [] };
      }
      if (text.includes('FROM settings_audit')) {
        return {
          rows: audit
            .map((a, i) => ({ id: String(i + 1), ...a, changed_at: new Date() }))
            .reverse(),
        };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
  return db;
}

const ctx = { actor: 'browser', ip: '10.0.0.5', reason: 'tuning' };

describe('ConfigService', () => {
  it('returns undefined for an unset key, so the consumer applies its default', () => {
    const svc = new ConfigService({});
    expect(svc.get('PROMOTION_MIN_TRADES')).toBeUndefined();
    expect(svc.source('PROMOTION_MIN_TRADES')).toBe('default');
    expect(svc.source('PORTFOLIO_BASE_CURRENCY')).toBe('unset');
  });

  it('reads a value saved to the database', async () => {
    const db = fakeDb();
    const svc = new ConfigService({});
    svc.attach(db);
    await svc.set('PROMOTION_MIN_TRADES', '50', ctx);
    expect(svc.get('PROMOTION_MIN_TRADES')).toBe('50');
    expect(svc.source('PROMOTION_MIN_TRADES')).toBe('database');
    expect(db.audit).toEqual([
      expect.objectContaining({
        key: 'PROMOTION_MIN_TRADES',
        action: 'set',
        old_value: null,
        new_value: '50',
        reason: 'tuning',
      }),
    ]);
  });

  it('lets .env win over the database and refuses to save a key set there', async () => {
    const db = fakeDb();
    db.rows.set('PROMOTION_MIN_TRADES', {
      key: 'PROMOTION_MIN_TRADES',
      value: '50',
      ciphertext: null,
      version: 1,
      updated_at: new Date(),
      updated_by: 'browser',
    });
    const svc = new ConfigService({ PROMOTION_MIN_TRADES: '10' });
    svc.attach(db);
    await svc.refresh();
    expect(svc.get('PROMOTION_MIN_TRADES')).toBe('10');
    expect(svc.source('PROMOTION_MIN_TRADES')).toBe('environment');
    await expect(svc.set('PROMOTION_MIN_TRADES', '60', ctx)).rejects.toMatchObject({ status: 409 });
  });

  it('treats an empty environment value as unset', async () => {
    const db = fakeDb();
    const svc = new ConfigService({ PROMOTION_MIN_TRADES: '  ' });
    svc.attach(db);
    await svc.set('PROMOTION_MIN_TRADES', '40', ctx);
    expect(svc.get('PROMOTION_MIN_TRADES')).toBe('40');
  });

  it('refuses keys whose consumer still reads .env, and unknown keys', async () => {
    const svc = new ConfigService({});
    svc.attach(fakeDb());
    await expect(svc.set('SESSION_TTL_HOURS', '4', ctx)).rejects.toMatchObject({
      status: 409,
    });
    await expect(svc.set('POSTGRES_PASSWORD', 'x', ctx)).rejects.toMatchObject({ status: 404 });
  });

  it('ignores a stored row for a key that is not editable', async () => {
    const db = fakeDb();
    db.rows.set('SESSION_TTL_HOURS', {
      key: 'SESSION_TTL_HOURS',
      value: '4',
      ciphertext: null,
      version: 1,
      updated_at: new Date(),
      updated_by: null,
    });
    const svc = new ConfigService({});
    svc.attach(db);
    await svc.refresh();
    expect(svc.get('SESSION_TTL_HOURS')).toBeUndefined();
  });

  it('validates and normalises before saving', async () => {
    const svc = new ConfigService({});
    svc.attach(fakeDb());
    await expect(svc.set('PROMOTION_MIN_TRADES', '2.5', ctx)).rejects.toMatchObject({
      status: 400,
    });
    await expect(svc.set('PROMOTION_MIN_TRADES', '0', ctx)).rejects.toMatchObject({ status: 400 });
    await expect(svc.set('PROMOTION_PAPER_GATE', 'maybe', ctx)).rejects.toMatchObject({
      status: 400,
    });
    await svc.set('PROMOTION_PAPER_GATE', 'OFF', ctx);
    expect(svc.get('PROMOTION_PAPER_GATE')).toBe('off');
  });

  it('clears a stored value back to the default', async () => {
    const db = fakeDb();
    const svc = new ConfigService({});
    svc.attach(db);
    await svc.set('NEWS_CALENDAR_MAX_AGE_HOURS', '48', ctx);
    await svc.clear('NEWS_CALENDAR_MAX_AGE_HOURS', ctx);
    expect(svc.get('NEWS_CALENDAR_MAX_AGE_HOURS')).toBeUndefined();
    expect(db.audit.map((a) => a.action)).toEqual(['set', 'clear']);
  });

  it('keeps the last good copy when the database cannot be read', async () => {
    const db = fakeDb();
    const svc = new ConfigService({});
    svc.attach(db);
    await svc.set('PROMOTION_MIN_TRADES', '50', ctx);
    db.failReads = true;
    expect(await svc.refresh()).toBe(false);
    expect(svc.get('PROMOTION_MIN_TRADES')).toBe('50');
    expect(svc.status().error).toMatch(/app_settings/);
  });

  it('tells subscribers when a watched value changes, and only then', async () => {
    const db = fakeDb();
    const svc = new ConfigService({});
    svc.attach(db);
    const backfill = jest.fn();
    const other = jest.fn();
    const stop = svc.subscribe(['BACKFILL_ENABLED', 'BACKFILL_PERIOD'], backfill);
    svc.subscribe(['NEWS_CALENDAR_URL'], other);

    await svc.set('BACKFILL_ENABLED', 'true', ctx);
    expect(backfill).toHaveBeenCalledTimes(1);
    await svc.refresh();
    expect(backfill).toHaveBeenCalledTimes(1);
    await svc.set('BACKFILL_ENABLED', 'true', ctx);
    expect(backfill).toHaveBeenCalledTimes(1);
    await svc.clear('BACKFILL_ENABLED', ctx);
    expect(backfill).toHaveBeenCalledTimes(2);
    expect(other).not.toHaveBeenCalled();

    stop();
    await svc.set('BACKFILL_PERIOD', '1D', ctx);
    expect(backfill).toHaveBeenCalledTimes(2);
  });

  it('keeps notifying when one subscriber throws', async () => {
    const svc = new ConfigService({});
    svc.attach(fakeDb());
    const after = jest.fn();
    svc.subscribe(['BACKFILL_PERIOD'], () => {
      throw new Error('boom');
    });
    svc.subscribe(['BACKFILL_PERIOD'], after);
    await svc.set('BACKFILL_PERIOD', '1D', ctx);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('start resolves once the stored values are read', async () => {
    const db = fakeDb();
    db.rows.set('BACKFILL_PERIOD', {
      key: 'BACKFILL_PERIOD',
      value: '1M',
      ciphertext: null,
      version: 1,
      updated_at: new Date(),
      updated_by: null,
    });
    const svc = new ConfigService({});
    svc.attach(db);
    await svc.start();
    expect(svc.get('BACKFILL_PERIOD')).toBe('1M');
    svc.stop();
  });

  it('asEnv resolves registered keys lazily and passes others through', async () => {
    const svc = new ConfigService({ SOMETHING_ELSE: 'x' });
    svc.attach(fakeDb());
    const env = svc.asEnv();
    expect(env.PROMOTION_MIN_TRADES).toBeUndefined();
    await svc.set('PROMOTION_MIN_TRADES', '45', ctx);
    expect(env.PROMOTION_MIN_TRADES).toBe('45');
    expect(env.SOMETHING_ELSE).toBe('x');
  });

  it('describe never exposes a secret and marks env values locked', () => {
    const svc = new ConfigService({
      TELEGRAM_BOT_TOKEN: 'bot-token-123',
      PROMOTION_MIN_TRADES: '9',
    });
    const views = svc.describe();
    const token = views.find((v) => v.key === 'TELEGRAM_BOT_TOKEN')!;
    expect(token.value).toBeNull();
    expect(token.is_set).toBe(true);
    expect(JSON.stringify(views)).not.toContain('bot-token-123');
    const trades = views.find((v) => v.key === 'PROMOTION_MIN_TRADES')!;
    expect(trades).toMatchObject({
      value: '9',
      locked: true,
      source: 'environment',
      editable: true,
    });
  });

  it('never registers a bootstrap value', () => {
    const keys = new ConfigService({}).describe().map((v) => v.key);
    for (const bootstrap of [
      'POSTGRES_HOST',
      'POSTGRES_PASSWORD',
      'SETTINGS_ENCRYPTION_KEY',
      'BROKER_SERVICE_TOKEN',
      'REDIS_PASSWORD',
      'BACKEND_PORT',
      'NODE_ENV',
    ]) {
      expect(keys).not.toContain(bootstrap);
    }
  });
});

describe('ConfigService secrets', () => {
  // No editable setting is a secret yet, so mark one editable for the test.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const registry = require('../src/config/registry.js');
  const def = registry.settingDef('TELEGRAM_BOT_TOKEN');
  beforeAll(() => {
    def.editable = true;
  });
  afterAll(() => {
    def.editable = false;
  });

  it('stores a secret only as ciphertext, audits it as (secret), and reads it back', async () => {
    const db = fakeDb();
    const svc = new ConfigService({ SETTINGS_ENCRYPTION_KEY: KEY_HEX });
    svc.attach(db);
    await svc.set('TELEGRAM_BOT_TOKEN', 'bot-token-xyz', ctx);
    const row = db.rows.get('TELEGRAM_BOT_TOKEN')!;
    expect(row.value).toBeNull();
    expect(row.ciphertext).not.toContain('bot-token-xyz');
    expect(openSecret(row.ciphertext!, Buffer.from(KEY_HEX, 'hex'))).toBe('bot-token-xyz');
    expect(db.audit[0].new_value).toBe('(secret)');
    expect(svc.get('TELEGRAM_BOT_TOKEN')).toBe('bot-token-xyz');
  });

  it('refuses to store a secret without an encryption key', async () => {
    const svc = new ConfigService({});
    svc.attach(fakeDb());
    await expect(svc.set('TELEGRAM_BOT_TOKEN', 'bot-token-xyz', ctx)).rejects.toMatchObject({
      status: 409,
    });
  });
});
