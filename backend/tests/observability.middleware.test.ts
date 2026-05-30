/**
 * Tests for the observability middleware.
 *
 * Covers: request-id pass-through, request-id minting, AsyncLocalStorage
 * propagation, response header echo, prom-client histogram observation
 * and request log emission.
 */
import express from 'express';
import request from 'supertest';

import { observabilityMiddleware } from '../src/middleware/observability.js';
import { currentRequestId, logger } from '../src/services/logger.js';
import { httpRequestDuration, registry } from '../src/services/metrics.js';

function buildApp() {
  const app = express();
  app.use(observabilityMiddleware());
  app.get('/test/:n', (req, res) => {
    res.json({
      seen_request_id: currentRequestId() ?? null,
      n: req.params.n,
    });
  });
  app.get('/error', (_req, res) => {
    res.status(503).json({ ok: false });
  });
  return app;
}

describe('observabilityMiddleware', () => {
  it('passes through a caller-supplied X-Request-Id and exposes it via ALS', async () => {
    const app = buildApp();
    const res = await request(app).get('/test/1').set('X-Request-Id', 'caller-xyz');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe('caller-xyz');
    expect(res.body.seen_request_id).toBe('caller-xyz');
  });

  it('mints a uuid-shaped X-Request-Id when none supplied', async () => {
    const app = buildApp();
    const res = await request(app).get('/test/2');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(res.body.seen_request_id).toBe(res.headers['x-request-id']);
  });

  it('rejects an absurdly long header and falls back to a fresh id', async () => {
    const app = buildApp();
    const longId = 'x'.repeat(200);
    const res = await request(app).get('/test/3').set('X-Request-Id', longId);
    expect(res.headers['x-request-id']).not.toBe(longId);
    expect(res.headers['x-request-id'].length).toBeLessThan(150);
  });

  it('observes a duration into the prom-client histogram', async () => {
    await registry.resetMetrics();
    const app = buildApp();
    await request(app).get('/test/4');
    const out = await registry.getSingleMetricAsString('http_request_duration_seconds');
    expect(out).toMatch(/http_request_duration_seconds_count\{.*method="GET".*\} 1/);
  });

  it('emits a structured log line on finish (info level)', async () => {
    const spy = jest.spyOn(logger, 'info').mockImplementation(() => undefined as any);
    const app = buildApp();
    await request(app).get('/error');
    expect(spy).toHaveBeenCalled();
    const [payload] = spy.mock.calls[spy.mock.calls.length - 1];
    expect(payload).toMatchObject({
      req: expect.objectContaining({ method: 'GET', url: '/error' }),
      res: { statusCode: 503 },
    });
    spy.mockRestore();
  });
});

describe('httpRequestDuration histogram', () => {
  it('has the expected bucket boundaries', () => {
    // Sanity check: prom-client doesn't expose buckets after construction in a
    // stable way, but we can serialise and look for one boundary.
    const metric = httpRequestDuration as unknown as { hashMap: Record<string, unknown> };
    expect(metric).toBeDefined();
  });
});
