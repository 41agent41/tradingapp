/**
 * Browser origins and trusted proxies, set on Settings > Network and read on
 * every request (services/network.ts).
 */
import express from 'express';
import request from 'supertest';
import { allowedOrigins, originAllowed, trustedProxies } from '../src/services/network.js';

const settings = (values: Record<string, string>) => (k: string) => values[k];

describe('allowed origins', () => {
  it('accepts any origin when unset or *', () => {
    expect(allowedOrigins(settings({}))).toBeNull();
    expect(allowedOrigins(settings({ CORS_ORIGINS: 'https://a.example, *' }))).toBeNull();
    expect(originAllowed('https://anything.example', settings({}))).toBe(true);
  });

  it('accepts only the listed origins once set, and always a request with none', () => {
    const get = settings({ CORS_ORIGINS: 'https://a.example, https://b.example' });
    expect(originAllowed('https://b.example', get)).toBe(true);
    expect(originAllowed('https://evil.example', get)).toBe(false);
    expect(originAllowed(undefined, get)).toBe(true);
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
