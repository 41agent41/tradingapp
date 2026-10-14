/**
 * /api/settings: lists every registered setting without leaking a secret or
 * any bootstrap value, saves only what the page may change, and puts the
 * order step-up in front of protected settings.
 */
import express from 'express';
import request from 'supertest';

import { configService } from '../src/config/configService.js';
import settingsRouter from '../src/routes/settings.js';

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
    const r = await request(buildApp())
      .put('/api/settings/LIVE_TRADING_ENABLED')
      .send({ value: 'true' });
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
