/**
 * Auth middleware unit tests.
 *
 * The middleware reads `process.env.API_TOKEN` at construction time, so
 * each test sets the env var before calling `createAuthMiddleware()`.
 */
import express from 'express';
import request from 'supertest';
import { createAuthMiddleware } from '../src/middleware/auth.js';

function buildApp(token: string | undefined) {
  if (token === undefined) {
    delete process.env.API_TOKEN;
  } else {
    process.env.API_TOKEN = token;
  }

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
    const app = buildApp(undefined);

    it('lets unauthenticated requests through', async () => {
      const r = await request(app).get('/api/protected');
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ secret: 42 });
    });
  });

  describe('when API_TOKEN is set', () => {
    const TOKEN = 'super-secret-test-token-1234567890';
    const app = buildApp(TOKEN);

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
