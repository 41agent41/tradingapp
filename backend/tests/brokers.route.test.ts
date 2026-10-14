/**
 * /api/brokers relays the broker service's connection checks.
 */
import express from 'express';
import request from 'supertest';

jest.mock('axios');

import axios from 'axios';
import brokersRouter from '../src/routes/brokers.js';

const axiosMock = axios as jest.Mocked<typeof axios>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/brokers', brokersRouter);
  return app;
}

describe('/api/brokers', () => {
  it('relays the status list', async () => {
    axiosMock.get.mockResolvedValue({ data: { default: 'oanda', connections: [] } });
    const res = await request(buildApp()).get('/api/brokers/status');
    expect(res.status).toBe(200);
    expect(res.body.default).toBe('oanda');
    expect(axiosMock.get.mock.calls[0][0]).toMatch(/\/connections\/status$/);
  });

  it('tests one connection', async () => {
    axiosMock.post.mockResolvedValue({
      data: { label: 'oanda:default', check: { status: 'connected' } },
    });
    const res = await request(buildApp()).post('/api/brokers/oanda:default/test');
    expect(res.status).toBe(200);
    expect(res.body.check.status).toBe('connected');
    expect(axiosMock.post.mock.calls[0][0]).toMatch(/\/connections\/oanda%3Adefault\/test$/);
  });

  it('refuses a label that is not platform:account', async () => {
    const res = await request(buildApp()).post('/api/brokers/..%2Fhealth/test');
    expect(res.status).toBe(400);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  it("relays the broker service's error status", async () => {
    axiosMock.post.mockRejectedValue({
      response: { status: 404, data: { detail: 'No connection' } },
    });
    const res = await request(buildApp()).post('/api/brokers/mt5:nope/test');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No connection');
  });
});
