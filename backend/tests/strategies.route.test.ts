/**
 * Integration tests for the /api/strategies routes.
 *
 * The route's collaborators — StrategyRepository (DB) and axios (the evaluate
 * proxy into the IB service) — are intercepted via jest.mock so the suite is
 * hermetic (mirrors backtesting.route.test.ts).
 */
import express from 'express';
import request from 'supertest';

jest.mock('axios');
jest.mock('../src/services/database.js', () => ({
  dbService: { query: jest.fn() },
}));

const repoImpl = {
  createDefinition: jest.fn(),
  listDefinitions: jest.fn(),
  findDefinition: jest.fn(),
  createRun: jest.fn(),
  listRuns: jest.fn(),
  findRun: jest.fn(),
  updateRunStatus: jest.fn(),
  listSignals: jest.fn(),
};
jest.mock('../src/services/strategyRepository.js', () => ({
  __esModule: true,
  StrategyRepository: jest.fn().mockImplementation(() => repoImpl),
}));

import axios from 'axios';
import strategiesRouter from '../src/routes/strategies.js';

const axiosMock = axios as jest.Mocked<typeof axios>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/strategies', strategiesRouter);
  return app;
}

const VALID_DEF = {
  name: 'MA',
  symbol: 'MSFT',
  timeframe: '5min',
  rule_set: { entry: { all: [] } },
};

beforeEach(() => jest.clearAllMocks());

describe('POST /api/strategies/definitions', () => {
  it('400s when required fields are missing', async () => {
    const res = await request(buildApp()).post('/api/strategies/definitions').send({ name: 'MA' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing required/i);
  });

  it('400s on an invalid timeframe', async () => {
    const res = await request(buildApp())
      .post('/api/strategies/definitions')
      .send({ ...VALID_DEF, timeframe: '7min' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid timeframe/i);
  });

  it("400s when rule_set has no 'entry' group", async () => {
    const res = await request(buildApp())
      .post('/api/strategies/definitions')
      .send({ ...VALID_DEF, rule_set: { foo: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/entry/i);
  });

  it('201s and returns the created row', async () => {
    repoImpl.createDefinition.mockResolvedValue({ id: 11, ...VALID_DEF });
    const res = await request(buildApp()).post('/api/strategies/definitions').send(VALID_DEF);
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(11);
    expect(repoImpl.createDefinition).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'MA', symbol: 'MSFT' })
    );
  });
});

describe('POST /api/strategies/runs', () => {
  it('400s without a definition_id', async () => {
    const res = await request(buildApp()).post('/api/strategies/runs').send({});
    expect(res.status).toBe(400);
  });

  it('400s on an invalid account_mode', async () => {
    const res = await request(buildApp())
      .post('/api/strategies/runs')
      .send({ definition_id: 1, account_mode: 'margin' });
    expect(res.status).toBe(400);
  });

  it('404s when the definition does not exist', async () => {
    repoImpl.findDefinition.mockResolvedValue(null);
    const res = await request(buildApp()).post('/api/strategies/runs').send({ definition_id: 999 });
    expect(res.status).toBe(404);
  });

  it('201s and carries sizing/risk from the definition rule_set', async () => {
    repoImpl.findDefinition.mockResolvedValue({
      id: 1,
      broker: 'ib',
      rule_set: { entry: { all: [] }, sizing: { size: 100 }, risk: { max_orders_per_day: 4 } },
    });
    repoImpl.createRun.mockResolvedValue({ id: 50, status: 'running' });
    const res = await request(buildApp())
      .post('/api/strategies/runs')
      .send({ definition_id: 1, account_mode: 'paper' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(50);
    expect(repoImpl.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        definition_id: 1,
        sizing: { size: 100 },
        risk: { max_orders_per_day: 4 },
      })
    );
  });
});

describe('POST /api/strategies/runs/:id/stop', () => {
  it('404s when the run is missing', async () => {
    repoImpl.updateRunStatus.mockResolvedValue(null);
    const res = await request(buildApp()).post('/api/strategies/runs/7/stop');
    expect(res.status).toBe(404);
  });

  it('stops an existing run', async () => {
    repoImpl.updateRunStatus.mockResolvedValue({ id: 7, status: 'stopped' });
    const res = await request(buildApp()).post('/api/strategies/runs/7/stop');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('stopped');
    expect(repoImpl.updateRunStatus).toHaveBeenCalledWith(7, 'stopped');
  });
});

describe('GET /api/strategies/runs/:id/signals', () => {
  it('returns the recorded signals', async () => {
    repoImpl.listSignals.mockResolvedValue([{ id: 1, signal: 'buy' }]);
    const res = await request(buildApp()).get('/api/strategies/runs/7/signals');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.signals[0].signal).toBe('buy');
  });
});

describe('POST /api/strategies/evaluate (proxy)', () => {
  it('forwards to the IB service and returns its body', async () => {
    axiosMock.post.mockResolvedValue({ data: { signal: 'buy', bar_time: 't' } } as any);
    const res = await request(buildApp())
      .post('/api/strategies/evaluate')
      .send({ bars: [], rule_set: VALID_DEF.rule_set });
    expect(res.status).toBe(200);
    expect(res.body.signal).toBe('buy');
  });

  it('propagates an IB-service error status', async () => {
    axiosMock.post.mockRejectedValue({ response: { status: 400, data: { detail: 'bad' } } });
    const res = await request(buildApp()).post('/api/strategies/evaluate').send({ bars: [] });
    expect(res.status).toBe(400);
    expect(res.body.detail).toBe('bad');
  });
});
