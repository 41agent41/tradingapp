/**
 * First-run setup and the Security tab's API, against an in-memory store.
 */
import express from 'express';
import request from 'supertest';

import { createAuthMiddleware } from '../src/middleware/auth.js';
import authRoutes from '../src/routes/auth.js';
import securityRoutes from '../src/routes/security.js';
import { credentials } from '../src/services/credentials.js';
import { notifier } from '../src/services/notifier.js';
import { setSetupCodeForTest } from '../src/services/setupCode.js';
import { credentialsDb } from './helpers/credentialsDb.js';
import { totpNow } from './helpers/totp.js';

const SAVED_ENV: NodeJS.ProcessEnv = { ...process.env };
const PASSWORD = 'a long enough password';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(createAuthMiddleware());
  app.use('/api/auth', authRoutes);
  app.use('/api/security', securityRoutes);
  app.get('/api/protected', (_req, res) => res.json({ ok: true }));
  return app;
}

function cookieOf(res: request.Response): string {
  return String(res.headers['set-cookie']).split(';')[0];
}

let db: ReturnType<typeof credentialsDb>;

beforeEach(async () => {
  for (const k of ['APP_PASSWORD', 'API_TOKEN', 'SESSION_SECRET', 'TRADING_TOKENS']) {
    delete process.env[k];
  }
  delete process.env.ORDER_MFA_SECRET;
  process.env.NODE_ENV = 'production';
  process.env.SETTINGS_ENCRYPTION_KEY = 'b'.repeat(64);
  db = credentialsDb();
  credentials.attach(db);
  await credentials.load();
  setSetupCodeForTest('ABCD-EFGH-JKMN');
  jest.spyOn(notifier, 'notify').mockResolvedValue({ sent: true });
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const k of Object.keys(process.env)) if (!(k in SAVED_ENV)) delete process.env[k];
  Object.assign(process.env, SAVED_ENV);
  setSetupCodeForTest(null);
});

async function setUp(app: express.Express): Promise<string> {
  const r = await request(app)
    .post('/api/auth/setup')
    .send({ code: 'abcd efgh jkmn', password: PASSWORD });
  expect(r.status).toBe(200);
  return cookieOf(r);
}

describe('first-run setup', () => {
  it('locks a production API until a password is chosen', async () => {
    const app = buildApp();
    const r = await request(app).get('/api/protected');
    expect(r.status).toBe(401);
    expect(r.body.setup_required).toBe(true);
    const s = await request(app).get('/api/auth/session');
    expect(s.body).toMatchObject({ authenticated: false, setup_required: true });
  });

  it('needs the setup code', async () => {
    const r = await request(buildApp())
      .post('/api/auth/setup')
      .set('X-Forwarded-For', '10.9.9.9')
      .send({ code: 'WRONG-CODE-0000', password: PASSWORD });
    expect(r.status).toBe(401);
    expect(credentials.hasPassword()).toBe(false);
  });

  it('sets the password, signs in, and cannot run twice', async () => {
    const app = buildApp();
    const cookie = await setUp(app);
    expect((await request(app).get('/api/protected').set('Cookie', cookie)).status).toBe(200);
    expect((await request(app).get('/api/protected')).status).toBe(401);
    const again = await request(app)
      .post('/api/auth/setup')
      .send({ code: 'ABCD-EFGH-JKMN', password: 'someone else entirely' });
    expect(again.status).toBe(409);
    const login = await request(app).post('/api/auth/login').send({ password: PASSWORD });
    expect(login.status).toBe(200);
  });
});

describe('/api/security', () => {
  it('never returns a secret', async () => {
    const app = buildApp();
    const cookie = await setUp(app);
    const made = await request(app)
      .post('/api/security/tokens')
      .set('Cookie', cookie)
      .send({ kind: 'api', label: 'backup script' });
    expect(made.status).toBe(201);
    const r = await request(app).get('/api/security').set('Cookie', cookie);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(made.body.token);
    expect(r.body.password.source).toBe('database');
    expect(r.body.tokens.api).toHaveLength(1);
  });

  it('changes the password only with the current one, and signs out', async () => {
    const app = buildApp();
    const cookie = await setUp(app);
    const wrong = await request(app)
      .put('/api/security/password')
      .set('Cookie', cookie)
      .send({ current: 'not it at all', password: 'the next password' });
    expect(wrong.status).toBe(403);
    const ok = await request(app)
      .put('/api/security/password')
      .set('Cookie', cookie)
      .send({ current: PASSWORD, password: 'the next password' });
    expect(ok.status).toBe(200);
    expect((await request(app).get('/api/protected').set('Cookie', cookie)).status).toBe(401);
  });

  it('a created API token works for scripts until revoked', async () => {
    const app = buildApp();
    const cookie = await setUp(app);
    const made = await request(app)
      .post('/api/security/tokens')
      .set('Cookie', cookie)
      .send({ kind: 'api', label: 'cron' });
    const bearer = `Bearer ${made.body.token}`;
    expect((await request(app).get('/api/protected').set('Authorization', bearer)).status).toBe(
      200
    );
    await request(app).delete(`/api/security/tokens/${made.body.view.id}`).set('Cookie', cookie);
    expect((await request(app).get('/api/protected').set('Authorization', bearer)).status).toBe(
      401
    );
  });

  it('asks for the trading token and MFA code once they exist', async () => {
    const app = buildApp();
    const cookie = await setUp(app);
    // The first trading token needs no step-up: there is nothing to step up with.
    const first = await request(app)
      .post('/api/security/tokens')
      .set('Cookie', cookie)
      .send({ kind: 'trading', label: 'phone' });
    expect(first.status).toBe(201);
    const trading = first.body.token;

    const noToken = await request(app)
      .post('/api/security/tokens')
      .set('Cookie', cookie)
      .send({ kind: 'trading', label: 'laptop' });
    expect(noToken.status).toBe(403);

    // MFA enrolment: start (with the trading token), confirm with a code.
    const begun = await request(app)
      .post('/api/security/mfa')
      .set('Cookie', cookie)
      .set('X-Trading-Token', trading);
    expect(begun.status).toBe(200);
    expect(begun.body.otpauth_uri).toContain(`secret=${begun.body.secret}`);
    const confirmed = await request(app)
      .post('/api/security/mfa/confirm')
      .set('Cookie', cookie)
      .send({ code: totpNow(begun.body.secret) });
    expect(confirmed.status).toBe(200);

    // Removing MFA now needs a current code.
    const noCode = await request(app)
      .delete('/api/security/mfa')
      .set('Cookie', cookie)
      .set('X-Trading-Token', trading);
    expect(noCode.status).toBe(401);
    const removed = await request(app)
      .delete('/api/security/mfa')
      .set('Cookie', cookie)
      .set('X-Trading-Token', trading)
      .set('X-MFA-Code', totpNow(begun.body.secret));
    expect(removed.status).toBe(200);
  });
});
