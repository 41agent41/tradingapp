/**
 * Settings route tests.
 *
 * Ensures the allow-list / deny-pattern logic in
 * `routes/settings.ts` does not leak credential material.
 */
import express from 'express';
import request from 'supertest';

// `routes/settings.ts` uses ESM-style `.js` import suffixes that map back
// to the .ts source via jest.config.cjs `moduleNameMapper`.
import settingsRouter from '../src/routes/settings.js';

const SAVED_ENV: NodeJS.ProcessEnv = { ...process.env };

function withEnv(extra: Record<string, string>): void {
  for (const k of Object.keys(extra)) process.env[k] = extra[k];
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRouter);
  return app;
}

afterEach(() => {
  // Restore process.env between tests so cross-test leakage is impossible.
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED_ENV)) delete process.env[k];
  }
  Object.assign(process.env, SAVED_ENV);
});

describe('GET /api/settings', () => {
  it('returns whitelisted, non-credential keys', async () => {
    withEnv({
      NODE_ENV: 'test',
      SERVER_IP: '10.0.0.1',
      IB_HOST: 'ib-gateway.internal',
      IB_PORT: '4002',
      POSTGRES_HOST: 'db.internal',
      POSTGRES_USER: 'tradingapp',
      REDIS_HOST: 'redis',
    });
    const app = buildApp();

    const r = await request(app).get('/api/settings');
    expect(r.status).toBe(200);
    expect(r.body.settings).toMatchObject({
      NODE_ENV: 'test',
      SERVER_IP: '10.0.0.1',
      IB_HOST: 'ib-gateway.internal',
      IB_PORT: '4002',
      POSTGRES_HOST: 'db.internal',
      POSTGRES_USER: 'tradingapp',
      REDIS_HOST: 'redis',
    });
    expect(Array.isArray(r.body.meta.allowed_keys)).toBe(true);
  });

  it.each([
    ['POSTGRES_PASSWORD', 'super-secret-db-pw'],
    ['REDIS_PASSWORD', 'super-secret-redis-pw'],
    ['JWT_SECRET', 'jwt-secret-XYZ'],
    ['SESSION_SECRET', 'session-secret-XYZ'],
    ['API_TOKEN', 'api-token-XYZ'],
    ['SOME_OTHER_API_KEY', 'arbitrary-api-key'],
    ['DB_PASSWORD', 'leaky-password'],
    ['MY_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----'],
  ])('never echoes %s back to the client', async (key, value) => {
    withEnv({ [key]: value });
    const app = buildApp();

    const r = await request(app).get('/api/settings');
    expect(r.status).toBe(200);

    const flattened = JSON.stringify(r.body);
    expect(flattened).not.toContain(value);
    expect(r.body.settings[key]).toBeUndefined();
  });

  it('omits keys that are not present in process.env (no empty-string leaks)', async () => {
    // Make sure POSTGRES_HOST isn't accidentally surfaced as an empty
    // string when the operator hasn't set it.
    delete process.env.POSTGRES_HOST;
    const app = buildApp();

    const r = await request(app).get('/api/settings');
    expect(r.status).toBe(200);
    expect(r.body.settings.POSTGRES_HOST).toBeUndefined();
  });

  it('exposes the allow-list contract via meta.allowed_keys', async () => {
    const app = buildApp();
    const r = await request(app).get('/api/settings');
    expect(r.status).toBe(200);
    const keys: string[] = r.body.meta.allowed_keys;
    // Spot-check that nothing dangerous can be on the documented allow-list.
    for (const dangerous of [
      'POSTGRES_PASSWORD',
      'REDIS_PASSWORD',
      'JWT_SECRET',
      'SESSION_SECRET',
      'API_TOKEN',
    ]) {
      expect(keys).not.toContain(dangerous);
    }
  });
});
