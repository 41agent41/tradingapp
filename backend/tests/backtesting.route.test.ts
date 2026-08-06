/**
 * Integration tests for the backtesting proxy routes.
 *
 * Hits the Express router with supertest so the validation paths are
 * exercised end-to-end. The route's two side-effecting collaborators —
 * axios (calls into the IB service) and BacktestRunRepository (DB) —
 * are intercepted via jest.mock so the suite is hermetic.
 */
import express from 'express';
import request from 'supertest';

jest.mock('axios');
jest.mock('../src/services/database.js', () => ({
  dbService: { query: jest.fn() },
}));
jest.mock('../src/services/cache.js', () => ({
  cacheService: {
    wrap: async (_key: string, _ttl: number, factory: () => Promise<unknown>) => factory(),
  },
}));
jest.mock('../src/services/backtestRunRepository.js', () => {
  const insert = jest.fn().mockResolvedValue({ id: 99 });
  return {
    __esModule: true,
    BacktestRunRepository: jest.fn().mockImplementation(() => ({ insert })),
    __insert: insert,
  };
});
jest.mock('../src/services/strategyRepository.js', () => {
  const findDefinition = jest.fn();
  return {
    __esModule: true,
    StrategyRepository: jest.fn().mockImplementation(() => ({ findDefinition })),
    __findDefinition: findDefinition,
  };
});

import axios from 'axios';
import backtestingRouter from '../src/routes/backtesting.js';

const axiosMock = axios as jest.Mocked<typeof axios>;
// Grab the mocked repositories at module load — the same registry instances the
// route imported. `resetModules: true` (jest.config.cjs) makes an in-test
// `jest.requireMock(...)` hand back a fresh instance the route never uses.
const repoMock = jest.requireMock('../src/services/backtestRunRepository.js') as {
  __insert: jest.Mock;
};
const defRepoMock = jest.requireMock('../src/services/strategyRepository.js') as {
  __findDefinition: jest.Mock;
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/backtesting', backtestingRouter);
  return app;
}

describe('POST /api/backtesting/run — validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 400 when no strategy selector is provided', async () => {
    const res = await request(buildApp()).post('/api/backtesting/run').send({ symbol: 'MSFT' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exactly one of 'strategy', 'definition_id' or 'rule_set'/i);
  });

  it('returns 400 when both a strategy key and a rule_set are provided', async () => {
    const res = await request(buildApp())
      .post('/api/backtesting/run')
      .send({ symbol: 'MSFT', strategy: 'ma_crossover', rule_set: { entry: { all: [] } } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exactly one/i);
  });

  it('returns 400 for an unknown sec_type', async () => {
    const res = await request(buildApp())
      .post('/api/backtesting/run')
      .send({ symbol: 'MSFT', strategy: 'ma_crossover', sec_type: 'BANANA' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid sec_type/i);
  });

  it('returns 400 for an unknown timeframe', async () => {
    const res = await request(buildApp())
      .post('/api/backtesting/run')
      .send({ symbol: 'MSFT', strategy: 'ma_crossover', timeframe: '7min' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid timeframe/i);
  });

  it('returns 400 when initial_capital is non-positive', async () => {
    const res = await request(buildApp()).post('/api/backtesting/run').send({
      symbol: 'MSFT',
      strategy: 'ma_crossover',
      timeframe: '1day',
      initial_capital: 0,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/initial_capital/);
  });

  it('returns 400 when commission is out of [0,1]', async () => {
    const res = await request(buildApp()).post('/api/backtesting/run').send({
      symbol: 'MSFT',
      strategy: 'ma_crossover',
      timeframe: '1day',
      commission: 1.5,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/commission/);
  });

  it('forwards a valid run to the IB service and returns persisted_id', async () => {
    axiosMock.post.mockResolvedValueOnce({
      data: {
        success: true,
        results: {
          symbol: 'MSFT',
          total_return_percent: 5.4,
          equity_curve: [{ time: 1, value: 100 }],
          trades_summary: [{ pnl: 12 }],
        },
        data_points: 200,
        timeframe: '1day',
        period: '1Y',
      },
    });

    const res = await request(buildApp())
      .post('/api/backtesting/run')
      .send({ symbol: 'MSFT', strategy: 'ma_crossover', timeframe: '1day' });

    expect(res.status).toBe(200);
    expect(res.body.persisted_id).toBe(99);
    expect(res.body.results.total_return_percent).toBe(5.4);
    expect(axiosMock.post).toHaveBeenCalledWith(
      expect.stringContaining('/backtesting/run'),
      null,
      expect.objectContaining({
        params: expect.objectContaining({
          symbol: 'MSFT',
          strategy: 'ma_crossover',
          timeframe: '1day',
          sec_type: 'STK',
          exchange: 'SMART',
          currency: 'USD',
          source: 'ib',
        }),
      })
    );
  });

  it('backtests a saved definition: rule_set body + instrument fields from the row', async () => {
    defRepoMock.__findDefinition.mockResolvedValueOnce({
      id: 7,
      name: 'FX rules',
      broker: 'oanda',
      symbol: 'EUR.USD',
      sec_type: 'CASH',
      exchange: 'IDEALPRO',
      currency: 'USD',
      timeframe: '1hour',
      rule_set: { entry: { all: [] } },
    });
    axiosMock.post.mockResolvedValueOnce({
      data: {
        success: true,
        results: { equity_curve: [], trades_summary: [] },
        data_points: 120,
        timeframe: '1hour',
        period: '1Y',
      },
    });

    const res = await request(buildApp()).post('/api/backtesting/run').send({ definition_id: 7 });

    expect(res.status).toBe(200);
    expect(defRepoMock.__findDefinition).toHaveBeenCalledWith(7);
    expect(axiosMock.post).toHaveBeenCalledWith(
      expect.stringContaining('/backtesting/run'),
      { rule_set: { entry: { all: [] } } },
      expect.objectContaining({
        params: expect.objectContaining({
          symbol: 'EUR.USD',
          timeframe: '1hour',
          sec_type: 'CASH',
          exchange: 'IDEALPRO',
          currency: 'USD',
          source: 'oanda',
        }),
      })
    );
    // No registered-strategy key is forwarded for a rule-set run.
    const params = axiosMock.post.mock.calls[0][2]?.params as Record<string, unknown>;
    expect(params.strategy).toBeUndefined();
    // Persisted under a rules label with the rule-set kept for reproducibility.
    expect(repoMock.__insert).toHaveBeenCalledWith(
      expect.objectContaining({
        strategy: 'rules:def:7',
        symbol: 'EUR.USD',
        params: expect.objectContaining({ rule_set: { entry: { all: [] } } }),
      })
    );
  });

  it('returns 404 when the definition does not exist', async () => {
    defRepoMock.__findDefinition.mockResolvedValueOnce(null);
    const res = await request(buildApp()).post('/api/backtesting/run').send({ definition_id: 99 });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Definition not found/i);
  });

  it('backtests an inline rule_set, defaulting symbol/timeframe from it', async () => {
    axiosMock.post.mockResolvedValueOnce({
      data: {
        success: true,
        results: { equity_curve: [], trades_summary: [] },
        timeframe: '1day',
        period: '1Y',
      },
    });

    const res = await request(buildApp())
      .post('/api/backtesting/run')
      .send({ rule_set: { symbol: 'AAPL', timeframe: '1day', entry: { all: [] } } });

    expect(res.status).toBe(200);
    expect(axiosMock.post).toHaveBeenCalledWith(
      expect.stringContaining('/backtesting/run'),
      { rule_set: expect.objectContaining({ symbol: 'AAPL' }) },
      expect.objectContaining({
        params: expect.objectContaining({ symbol: 'AAPL', timeframe: '1day' }),
      })
    );
    expect(repoMock.__insert).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'rules:inline' })
    );
  });

  it('still returns 200 even if the persistence insert throws', async () => {
    repoMock.__insert.mockRejectedValueOnce(new Error('db down'));

    axiosMock.post.mockResolvedValueOnce({
      data: {
        success: true,
        results: { equity_curve: [], trades_summary: [] },
        timeframe: '1day',
        period: '1Y',
      },
    });

    const res = await request(buildApp())
      .post('/api/backtesting/run')
      .send({ symbol: 'MSFT', strategy: 'ma_crossover', timeframe: '1day' });

    expect(res.status).toBe(200);
    expect(res.body.persisted_id).toBeNull();
  });
});

describe('GET /api/backtesting/strategies', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('proxies to the IB service and returns its payload', async () => {
    axiosMock.get.mockResolvedValueOnce({
      data: {
        strategies: {
          ma_crossover: { name: 'MA Crossover', indicators: ['sma'], description: '' },
        },
      },
    });
    const res = await request(buildApp()).get('/api/backtesting/strategies');
    expect(res.status).toBe(200);
    expect(res.body.strategies.ma_crossover.name).toBe('MA Crossover');
  });

  it('translates ECONNREFUSED into 503', async () => {
    const err = new Error('refused') as Error & { code?: string };
    err.code = 'ECONNREFUSED';
    axiosMock.get.mockRejectedValueOnce(err);
    const res = await request(buildApp()).get('/api/backtesting/strategies');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/strategies/i);
  });
});
