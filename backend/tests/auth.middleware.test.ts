/**
 * Auth middleware unit tests.
 *
 * The middleware reads the credentials on every request, so each block sets
 * the environment before its tests run.
 */
import express from 'express';
import request from 'supertest';
import { checkSocketAuth, createAuthMiddleware } from '../src/middleware/auth.js';
import authRoutes from '../src/routes/auth.js';
import { issueSession, SESSION_COOKIE } from '../src/services/session.js';

function useToken(token: string | undefined) {
  beforeEach(() => {
    delete process.env.APP_PASSWORD;
    delete process.env.SESSION_SECRET;
    if (token === undefined) delete process.env.API_TOKEN;
    else process.env.API_TOKEN = token;
  });
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(createAuthMiddleware());
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/database/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/protected', (_req, res) => res.json({ secret: 42 }));
  return app;
}

describe('createAuthMiddleware', () => {
  describe('when API_TOKEN is unset', () => {
    useToken(undefined);
    const app = buildApp();

    it('lets unauthenticated requests through', async () => {
      const r = await request(app).get('/api/protected');
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ secret: 42 });
    });
  });

  describe('when API_TOKEN is set', () => {
    const TOKEN = 'super-secret-test-token-1234567890';
    useToken(TOKEN);
    const app = buildApp();

    it('still allows /api/health without a token', async () => {
      const r = await request(app).get('/api/health');
      expect(r.status).toBe(200);
    });

    it('still allows /api/database/health without a token', async () => {
      const r = await request(app).get('/api/database/health');
      expect(r.status).toBe(200);
    });

    it('rejects protected routes without an Authorization header', async () => {
      const r = await request(app).get('/api/protected');
      expect(r.status).toBe(401);
      expect(r.body).toMatchObject({ error: 'Unauthorized' });
    });

    it('rejects protected routes with the wrong token', async () => {
      const r = await request(app).get('/api/protected').set('Authorization', 'Bearer wrong');
      expect(r.status).toBe(401);
    });

    it('rejects protected routes when the token is the right length but wrong value', async () => {
      // Same length as TOKEN to make sure the length-mismatch early-out
      // isn't masking a real mismatch.
      const sameLengthWrong = 'X'.repeat(TOKEN.length);
      const r = await request(app)
        .get('/api/protected')
        .set('Authorization', `Bearer ${sameLengthWrong}`);
      expect(r.status).toBe(401);
    });

    it('accepts the correct token via Authorization: Bearer', async () => {
      const r = await request(app).get('/api/protected').set('Authorization', `Bearer ${TOKEN}`);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ secret: 42 });
    });

    it('accepts the correct token via x-api-token', async () => {
      const r = await request(app).get('/api/protected').set('x-api-token', TOKEN);
      expect(r.status).toBe(200);
    });

    it('is not case-sensitive on the "Bearer " prefix', async () => {
      const r = await request(app).get('/api/protected').set('Authorization', `bearer ${TOKEN}`);
      expect(r.status).toBe(200);
    });
  });
});

describe('browser login sessions', () => {
  const PASSWORD = 'correct horse battery staple';
  let app: express.Express;

  beforeEach(() => {
    delete process.env.API_TOKEN;
    process.env.APP_PASSWORD = PASSWORD;
    process.env.SESSION_SECRET = 's'.repeat(48);
    app = express();
    app.use(express.json());
    app.use(createAuthMiddleware());
    app.use('/api/auth', authRoutes);
    app.get('/api/protected', (_req, res) => res.json({ secret: 42 }));
  });

  afterEach(() => {
    delete process.env.APP_PASSWORD;
    delete process.env.SESSION_SECRET;
  });

  it('rejects protected routes without a session', async () => {
    const r = await request(app).get('/api/protected');
    expect(r.status).toBe(401);
  });

  it('logs in with the right password and sets an HttpOnly cookie', async () => {
    const r = await request(app).post('/api/auth/login').send({ password: PASSWORD });
    expect(r.status).toBe(200);
    const cookie = String(r.headers['set-cookie']);
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');

    const session = cookie.split(';')[0];
    const ok = await request(app).get('/api/protected').set('Cookie', session);
    expect(ok.status).toBe(200);
    const probe = await request(app).get('/api/auth/session').set('Cookie', session);
    expect(probe.body.authenticated).toBe(true);
  });

  it('refuses a wrong password and sets no cookie', async () => {
    const r = await request(app)
      .post('/api/auth/login')
      .set('X-Forwarded-For', '10.0.0.1')
      .send({ password: 'wrong' });
    expect(r.status).toBe(401);
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  it('rejects a tampered or expired session cookie', async () => {
    const { value } = issueSession();
    const tampered = value.replace(/\.\d+\./, '.9999999999999.');
    const r1 = await request(app)
      .get('/api/protected')
      .set('Cookie', `${SESSION_COOKIE}=${tampered}`);
    expect(r1.status).toBe(401);

    const expired = issueSession(Date.now() - 48 * 3_600_000).value;
    const r2 = await request(app)
      .get('/api/protected')
      .set('Cookie', `${SESSION_COOKIE}=${expired}`);
    expect(r2.status).toBe(401);
  });

  it('rejects a session signed with a different secret', async () => {
    const { value } = issueSession();
    process.env.SESSION_SECRET = 'r'.repeat(48);
    const r = await request(app).get('/api/protected').set('Cookie', `${SESSION_COOKIE}=${value}`);
    expect(r.status).toBe(401);
  });

  it('accepts the session cookie on the Socket.IO handshake', () => {
    const { value } = issueSession();
    expect(checkSocketAuth({}, { cookie: `${SESSION_COOKIE}=${value}` }, {})).toBeNull();
    expect(checkSocketAuth({}, {}, {})).toBeInstanceOf(Error);
  });
});
