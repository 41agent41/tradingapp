/**
 * Browser origins and trusted proxies, set on Settings > Network and read on
 * every request (services/network.ts).
 */
import express from 'express';
import request from 'supertest';
import cors from 'cors';
import {
  allowedOrigins,
  openOriginsWarning,
  originAllowed,
  trustedProxies,
} from '../src/services/network.js';

const settings = (values: Record<string, string>) => (k: string) => values[k];

describe('allowed origins', () => {
  it("accepts no other site's origin when unset (S-04)", () => {
    expect(allowedOrigins(settings({}))).toEqual([]);
    expect(originAllowed('https://anything.example', settings({}))).toBe(false);
    expect(originAllowed('https://anything.example', settings({ CORS_ORIGINS: ' , ' }))).toBe(
      false
    );
    expect(openOriginsWarning(settings({}))).toBeNull();
  });

  it("accepts the app's own pages, which arrive with no Origin", () => {
    expect(originAllowed(undefined, settings({}))).toBe(true);
    expect(originAllowed('', settings({}))).toBe(true);
  });

  it('accepts any origin only when * is set, and warns about it', () => {
    const get = settings({ CORS_ORIGINS: 'https://a.example, *' });
    expect(allowedOrigins(get)).toBeNull();
    expect(originAllowed('https://anything.example', get)).toBe(true);
    expect(openOriginsWarning(get)).toMatch(/any website/);
  });

  it('accepts only the listed origins once set, and always a request with none', () => {
    const get = settings({ CORS_ORIGINS: 'https://a.example, https://b.example' });
    expect(originAllowed('https://b.example', get)).toBe(true);
    expect(originAllowed('https://evil.example', get)).toBe(false);
    expect(originAllowed(undefined, get)).toBe(true);
    expect(openOriginsWarning(get)).toBeNull();
  });

  it('refuses a request from another site before it reaches a route', async () => {
    const app = express();
    const get = settings({ CORS_ORIGINS: 'https://a.example' });
    const reached = jest.fn();
    app.use(
      cors({
        origin: (origin, callback) =>
          originAllowed(origin, get) ? callback(null, true) : callback(new Error('not allowed')),
        credentials: true,
      })
    );
    app.post('/api/orders', (_req, res) => {
      reached();
      res.json({ ok: true });
    });
    app.use((_err: unknown, _req: express.Request, res: express.Response, _next: unknown) => {
      res.status(403).json({ error: 'origin' });
    });

    expect(
      (await request(app).post('/api/orders').set('Origin', 'https://evil.example')).status
    ).toBe(403);
    expect(reached).not.toHaveBeenCalled();
    expect((await request(app).post('/api/orders')).status).toBe(200);
    const listed = await request(app).post('/api/orders').set('Origin', 'https://a.example');
    expect(listed.status).toBe(200);
    expect(listed.headers['access-control-allow-origin']).toBe('https://a.example');
  });
});

describe('trusted proxies', () => {
  it('always trusts the frontend container and adds the configured proxies', () => {
    expect(trustedProxies(settings({}), {})).toBe(false);
    expect(trustedProxies(settings({}), { FRONTEND_PROXY_ADDRESS: '172.20.0.3' })).toEqual([
      '172.20.0.3',
    ]);
    expect(
      trustedProxies(settings({ TRUST_PROXY: '172.20.0.1, 172.20.0.3' }), {
        FRONTEND_PROXY_ADDRESS: '172.20.0.3',
      })
    ).toEqual(['172.20.0.3', '172.20.0.1']);
  });

  it('changes which forwarded address Express believes when re-applied', async () => {
    const app = express();
    let proxies: string[] | false = false;
    app.set('trust proxy', proxies);
    app.get('/ip', (req, res) => res.json({ ip: req.ip }));
    const forwarded = () => request(app).get('/ip').set('X-Forwarded-For', '203.0.113.9');

    expect((await forwarded()).body.ip).not.toBe('203.0.113.9');
    proxies = trustedProxies(settings({ TRUST_PROXY: 'loopback' }), {});
    app.set('trust proxy', proxies);
    expect((await forwarded()).body.ip).toBe('203.0.113.9');
  });
});
