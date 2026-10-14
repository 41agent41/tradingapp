/**
 * /api/settings: lists every registered setting without leaking a secret or
 * any bootstrap value, saves only what the page may change, and puts the
 * order step-up in front of protected settings.
 */
import { createHmac } from 'crypto';
import express from 'express';
import request from 'supertest';

import { configService } from '../src/config/configService.js';
import settingsRouter from '../src/routes/settings.js';
import { notifier } from '../src/services/notifier.js';
import { isLiveTradingEnabled } from '../src/services/orderTypes.js';

const SAVED_ENV: NodeJS.ProcessEnv = { ...process.env };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRouter);
  return app;
}

function memoryDb() {
  const rows = new Map<string, any>();
  return {
    async query(text: string, params: any[] = []) {
      if (text.startsWith('SELECT key, value, ciphertext')) return { rows: [...rows.values()] };
      if (text.includes('INSERT INTO app_settings')) {
        rows.set(params[0], {
          key: params[0],
          value: params[1],
          ciphertext: params[2],
          version: 1,
          updated_at: new Date(),
          updated_by: params[3],
        });
        return { rows: [] };
      }
      if (text.includes('DELETE FROM app_settings')) {
        rows.delete(params[0]);
        return { rows: [] };
      }
      if (text.includes('FROM settings_audit')) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

beforeEach(async () => {
  configService.attach(memoryDb());
  await configService.refresh();
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED_ENV)) delete process.env[k];
  }
  Object.assign(process.env, SAVED_ENV);
});

describe('GET /api/settings', () => {
  it('lists registered settings with their source', async () => {
    process.env.SYSTEMATIC_ENABLED = 'true';
    const r = await request(buildApp()).get('/api/settings');
    expect(r.status).toBe(200);
    const byKey = Object.fromEntries(r.body.settings.map((s: any) => [s.key, s]));
    expect(byKey.SYSTEMATIC_ENABLED).toMatchObject({
      value: 'true',
      source: 'environment',
      locked: true,
    });
    expect(byKey.PROMOTION_MIN_TRADES).toMatchObject({
      value: '30',
      source: 'default',
      editable: true,
    });
    expect(r.body.sections.map((s: any) => s.id)).toContain('trading');
  });

  it.each([
    ['TELEGRAM_BOT_TOKEN', 'telegram-token-XYZ'],
    ['APP_PASSWORD', 'login-password-XYZ'],
    ['SESSION_SECRET', 'session-secret-XYZ'],
    ['API_TOKEN', 'api-token-XYZ'],
    ['ORDER_MFA_SECRET', 'JBSWY3DPEHPK3PXP'],
    ['ALPACA_API_SECRET', 'alpaca-secret-XYZ'],
    ['POSTGRES_PASSWORD', 'db-password-XYZ'],
    ['REDIS_PASSWORD', 'redis-password-XYZ'],
    ['BROKER_SERVICE_TOKEN', 'broker-token-XYZ'],
    ['SETTINGS_ENCRYPTION_KEY', 'f'.repeat(64)],
  ])('never echoes %s back to the client', async (key, value) => {
    process.env[key] = value;
    const r = await request(buildApp()).get('/api/settings');
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(value);
  });
});

describe('PUT /api/settings/:key', () => {
  it('saves an editable setting', async () => {
    const r = await request(buildApp())
      .put('/api/settings/NEWS_CALENDAR_MAX_AGE_HOURS')
      .send({ value: '48', reason: 'weekend feed is slow' });
    expect(r.status).toBe(200);
    expect(r.body.setting).toMatchObject({ value: '48', source: 'database' });
  });

  it('rejects an invalid value with the reason', async () => {
    const r = await request(buildApp())
      .put('/api/settings/NEWS_CALENDAR_MAX_AGE_HOURS')
      .send({ value: 'soon' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/number/);
  });

  it('refuses a setting that is set in .env', async () => {
    process.env.NEWS_CALENDAR_MAX_AGE_HOURS = '12';
    const r = await request(buildApp())
      .put('/api/settings/NEWS_CALENDAR_MAX_AGE_HOURS')
      .send({ value: '48' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/\.env/);
  });

  it('refuses a setting whose consumer still reads .env', async () => {
    const r = await request(buildApp()).put('/api/settings/SESSION_TTL_HOURS').send({ value: '4' });
    expect(r.status).toBe(409);
  });

  it('refuses a bootstrap value', async () => {
    const r = await request(buildApp()).put('/api/settings/POSTGRES_PASSWORD').send({ value: 'x' });
    expect(r.status).toBe(404);
  });

  it('needs the trader role for a step-up setting when one is configured', async () => {
    process.env.TRADING_TOKENS = 'trader-token-1';
    const app = buildApp();
    const denied = await request(app)
      .put('/api/settings/PROMOTION_MIN_TRADES')
      .send({ value: '10' });
    expect(denied.status).toBe(403);
    const allowed = await request(app)
      .put('/api/settings/PROMOTION_MIN_TRADES')
      .set('X-Trading-Token', 'trader-token-1')
      .send({ value: '10' });
    expect(allowed.status).toBe(200);
  });

  it('does not ask for step-up on an ordinary setting', async () => {
    process.env.TRADING_TOKENS = 'trader-token-1';
    const r = await request(buildApp())
      .put('/api/settings/NEWS_CALENDAR_REFRESH_MINUTES')
      .send({ value: '120' });
    expect(r.status).toBe(200);
  });
});

describe('DELETE /api/settings/:key', () => {
  it('returns the setting to its default', async () => {
    const app = buildApp();
    await request(app).put('/api/settings/NEWS_CALENDAR_REFRESH_MINUTES').send({ value: '120' });
    const r = await request(app).delete('/api/settings/NEWS_CALENDAR_REFRESH_MINUTES');
    expect(r.status).toBe(200);
    expect(r.body.setting).toMatchObject({ value: '360', source: 'default' });
  });
});

const MFA_SECRET = 'JBSWY3DPEHPK3PXP';

/** The current RFC 6238 code for a base32 secret. */
function totpNow(secret: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

function withSafeguards() {
  process.env.TRADING_TOKENS = 'trader-token-1';
  process.env.ORDER_MFA_SECRET = MFA_SECRET;
}

function stepUpHeaders() {
  return { 'X-Trading-Token': 'trader-token-1', 'X-MFA-Code': totpNow(MFA_SECRET) };
}

describe('turning live trading on from the page', () => {
  let alerts: jest.SpyInstance;
  beforeEach(() => {
    alerts = jest.spyOn(notifier, 'notify').mockResolvedValue({ sent: true });
  });
  afterEach(() => alerts.mockRestore());

  it('is refused until a trading token and MFA are set up', async () => {
    const r = await request(buildApp())
      .put('/api/settings/LIVE_TRADING_ENABLED')
      .send({ value: 'true', confirm: 'LIVE' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/trading token and an order MFA secret/);
  });

  it('needs the step-up, then the typed confirmation', async () => {
    withSafeguards();
    const app = buildApp();
    const noAuth = await request(app)
      .put('/api/settings/LIVE_TRADING_ENABLED')
      .send({ value: 'true', confirm: 'LIVE' });
    expect(noAuth.status).toBe(403);

    const noConfirm = await request(app)
      .put('/api/settings/LIVE_TRADING_ENABLED')
      .set(stepUpHeaders())
      .send({ value: 'true', confirm: 'live' });
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.body.confirm_required).toBe('LIVE');
    expect(isLiveTradingEnabled()).toBe(false);

    const ok = await request(app)
      .put('/api/settings/LIVE_TRADING_ENABLED')
      .set(stepUpHeaders())
      .send({ value: 'true', confirm: 'LIVE' });
    expect(ok.status).toBe(200);
    expect(isLiveTradingEnabled()).toBe(true);
    expect(alerts).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'critical', title: 'Setting changed: Live trading' })
    );
  });

  it('turns off with the login alone', async () => {
    withSafeguards();
    const app = buildApp();
    await request(app)
      .put('/api/settings/LIVE_TRADING_ENABLED')
      .set(stepUpHeaders())
      .send({ value: 'true', confirm: 'LIVE' });
    const off = await request(app)
      .put('/api/settings/LIVE_TRADING_ENABLED')
      .send({ value: 'false' });
    expect(off.status).toBe(200);
    expect(isLiveTradingEnabled()).toBe(false);
  });

  it('closes the gate if the safeguards are removed later', async () => {
    withSafeguards();
    await request(buildApp())
      .put('/api/settings/LIVE_TRADING_ENABLED')
      .set(stepUpHeaders())
      .send({ value: 'true', confirm: 'LIVE' });
    expect(isLiveTradingEnabled()).toBe(true);
    delete process.env.ORDER_MFA_SECRET;
    expect(isLiveTradingEnabled()).toBe(false);
  });
});

describe('the step-up only guards the riskier direction', () => {
  beforeEach(() => {
    jest.spyOn(notifier, 'notify').mockResolvedValue({ sent: true });
    process.env.TRADING_TOKENS = 'trader-token-1';
  });
  afterEach(() => jest.restoreAllMocks());

  it('lowers a cap with the login alone, and raises it only with the step-up', async () => {
    const app = buildApp();
    const lower = await request(app).put('/api/settings/ORDER_MAX_QUANTITY').send({ value: '500' });
    expect(lower.status).toBe(200);
    const raise = await request(app).put('/api/settings/ORDER_MAX_QUANTITY').send({ value: '900' });
    expect(raise.status).toBe(403);
    // Back to the default (100000) is a raise too.
    const reset = await request(app).delete('/api/settings/ORDER_MAX_QUANTITY');
    expect(reset.status).toBe(403);
  });

  it('treats 0 as "no cap" for an optional limit', async () => {
    const app = buildApp();
    expect(
      (await request(app).put('/api/settings/CONNECTION_MAX_DAILY_LOSS').send({ value: '200' }))
        .status
    ).toBe(200);
    expect(
      (await request(app).put('/api/settings/CONNECTION_MAX_DAILY_LOSS').send({ value: '0' }))
        .status
    ).toBe(403);
  });

  it('escalates the kill switch freely but needs the step-up to relax it', async () => {
    const app = buildApp();
    expect(
      (await request(app).put('/api/settings/KILL_SWITCH_ACTION').send({ value: 'halt' })).status
    ).toBe(200);
    expect(
      (await request(app).put('/api/settings/KILL_SWITCH_ACTION').send({ value: 'notify' })).status
    ).toBe(403);
  });

  it('always needs the step-up for a setting with no safer direction', async () => {
    const r = await request(buildApp())
      .put('/api/settings/TRADING_DAY_TIMEZONE')
      .send({ value: 'Europe/Athens' });
    expect(r.status).toBe(403);
  });
});

describe('risk setting validation', () => {
  it('rejects a time zone that does not exist', async () => {
    const r = await request(buildApp())
      .put('/api/settings/TRADING_DAY_TIMEZONE')
      .send({ value: 'Mars/Olympus' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/IANA/);
  });

  it('rejects a base currency that is not a code', async () => {
    const r = await request(buildApp())
      .put('/api/settings/PORTFOLIO_BASE_CURRENCY')
      .send({ value: 'dollars' });
    expect(r.status).toBe(400);
  });
});
