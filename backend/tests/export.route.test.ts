/**
 * Integration tests for POST /api/export/parquet — focused on the
 * validation branches. The actual parquet encoding is exercised in CI
 * end-to-end; here we keep the suite fast and hermetic.
 */
import express from 'express';
import request from 'supertest';

import exportRouter from '../src/routes/export.js';

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  app.use('/api/export', exportRouter);
  return app;
}

describe('POST /api/export/parquet — validation', () => {
  it('rejects an empty columns array', async () => {
    const res = await request(buildApp())
      .post('/api/export/parquet')
      .send({ columns: [], rows: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/columns/i);
  });

  it('rejects a non-array rows field', async () => {
    const res = await request(buildApp())
      .post('/api/export/parquet')
      .send({ columns: [{ key: 'a', type: 'string' }], rows: 'oops' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rows/i);
  });

  it('rejects a column missing the key field', async () => {
    const res = await request(buildApp())
      .post('/api/export/parquet')
      .send({ columns: [{ type: 'string' }], rows: [{ a: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/key/i);
  });

  it('413s when there are too many rows', async () => {
    const rows = Array(200_001)
      .fill(null)
      .map((_, i) => ({ a: i }));
    const res = await request(buildApp())
      .post('/api/export/parquet')
      .send({ columns: [{ key: 'a', type: 'number' }], rows });
    expect(res.status).toBe(413);
  });

  it('413s when there are too many columns', async () => {
    const columns = Array(257)
      .fill(null)
      .map((_, i) => ({ key: `c${i}`, type: 'string' as const }));
    const res = await request(buildApp()).post('/api/export/parquet').send({ columns, rows: [] });
    expect(res.status).toBe(413);
  });
});
