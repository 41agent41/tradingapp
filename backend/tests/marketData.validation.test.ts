/**
 * marketData router validation tests.
 *
 * Exercises the up-front parameter validation without actually reaching
 * the IB service or the database. The downstream services are not
 * mocked because the validation rejects before any network call is
 * attempted.
 */
import express from 'express';
import request from 'supertest';

import marketDataRouter from '../src/routes/marketData.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/market-data', marketDataRouter);
  return app;
}

describe('POST /api/market-data/search validation', () => {
  const app = buildApp();

  it('rejects requests missing symbol', async () => {
    const r = await request(app)
      .post('/api/market-data/search')
      .set('x-data-query-enabled', 'true')
      .send({ secType: 'STK' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Missing required parameters/);
  });

  it('rejects requests missing secType', async () => {
    const r = await request(app)
      .post('/api/market-data/search')
      .set('x-data-query-enabled', 'true')
      .send({ symbol: 'MSFT' });
    expect(r.status).toBe(400);
  });

  it('rejects an unknown secType', async () => {
    const r = await request(app)
      .post('/api/market-data/search')
      .set('x-data-query-enabled', 'true')
      .send({ symbol: 'MSFT', secType: 'NOT_REAL' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Invalid security type/i);
    expect(Array.isArray(r.body.valid_secTypes)).toBe(true);
  });

  it('rejects a blank symbol string', async () => {
    const r = await request(app)
      .post('/api/market-data/search')
      .set('x-data-query-enabled', 'true')
      .send({ symbol: '   ', secType: 'STK' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Invalid symbol/i);
  });

  it('returns the disabled-response when x-data-query-enabled is not set', async () => {
    const r = await request(app)
      .post('/api/market-data/search')
      .send({ symbol: 'MSFT', secType: 'STK' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ disabled: true });
  });
});

describe('GET /api/market-data/history validation', () => {
  const app = buildApp();

  it('returns the disabled-response when x-data-query-enabled is not set', async () => {
    const r = await request(app).get('/api/market-data/history?symbol=MSFT&timeframe=1hour');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ disabled: true });
  });

  it('rejects missing required parameters', async () => {
    const r = await request(app)
      .get('/api/market-data/history')
      .set('x-data-query-enabled', 'true');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Missing required parameters/i);
  });

  it('rejects unknown timeframes', async () => {
    const r = await request(app)
      .get('/api/market-data/history?symbol=MSFT&timeframe=42min')
      .set('x-data-query-enabled', 'true');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Invalid timeframe/i);
    expect(Array.isArray(r.body.valid_timeframes)).toBe(true);
  });
});
