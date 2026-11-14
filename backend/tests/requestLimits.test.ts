/**
 * Body size limits (S-11) and the metrics scrape token (S-09).
 */
import express from 'express';
import request from 'supertest';

import {
  bodyErrors,
  jsonBody,
  metricsGuard,
  takesLargeBody,
} from '../src/middleware/requestLimits.js';

function app(token?: string) {
  const a = express();
  a.use(jsonBody());
  a.use(bodyErrors());
  a.post('/api/orders', (req, res) => res.json({ keys: Object.keys(req.body).length }));
  a.post('/api/export/parquet', (req, res) => res.json({ rows: req.body.rows.length }));
  a.post('/api/market-data/upload', (req, res) => res.json({ bars: req.body.bars.length }));
  a.get(
    '/metrics',
    metricsGuard(() => token),
    (_req, res) => res.type('text/plain').send('up 1\n')
  );
  return a;
}

const big = (n: number) => Array.from({ length: n }, (_, i) => ({ i, pad: 'x'.repeat(100) }));

describe('JSON body limits', () => {
  it('names the two routes that take a large body', () => {
    expect(takesLargeBody('/api/export/parquet')).toBe(true);
    expect(takesLargeBody('/api/market-data/upload')).toBe(true);
    expect(takesLargeBody('/api/exporter')).toBe(false);
    expect(takesLargeBody('/api/orders')).toBe(false);
  });

  it('takes an ordinary body anywhere and refuses one over 100 KB with a JSON 413', async () => {
    const ok = await request(app()).post('/api/orders').send({ symbol: 'MSFT', quantity: 1 });
    expect(ok.status).toBe(200);

    const res = await request(app())
      .post('/api/orders')
      .send({ rows: big(2000) }); // about 240 KB
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('Request body too large');
  });

  it('takes a large body on the export and the upload', async () => {
    const rows = big(2000);
    const exported = await request(app()).post('/api/export/parquet').send({ rows });
    expect(exported.body).toEqual({ rows: 2000 });
    const uploaded = await request(app()).post('/api/market-data/upload').send({ bars: rows });
    expect(uploaded.body).toEqual({ bars: 2000 });
  });

  it('answers a body that is not JSON with a JSON 400', async () => {
    const res = await request(app())
      .post('/api/orders')
      .set('Content-Type', 'application/json')
      .send('{"symbol": ');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not valid JSON/);
  });
});

describe('metrics scrape token', () => {
  it('leaves /metrics open while no token is set', async () => {
    const res = await request(app()).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('up 1');
    expect((await request(app('  ')).get('/metrics')).status).toBe(200);
  });

  it('needs the token as a bearer once one is set', async () => {
    const a = app('scrape-secret');
    expect((await request(a).get('/metrics')).status).toBe(401);
    const wrong = await request(a).get('/metrics').set('Authorization', 'Bearer scrape-secreT');
    expect(wrong.status).toBe(401);
    expect(wrong.headers['www-authenticate']).toBe('Bearer');
    // Not in the URL, where it would be logged.
    expect((await request(a).get('/metrics?token=scrape-secret')).status).toBe(401);
    const right = await request(a).get('/metrics').set('Authorization', 'Bearer scrape-secret');
    expect(right.status).toBe(200);
  });
});
