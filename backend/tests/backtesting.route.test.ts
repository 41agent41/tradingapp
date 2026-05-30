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

import axios from 'axios';
import backtestingRouter from '../src/routes/backtesting.js';

const axiosMock = axios as jest.Mocked<typeof axios>;

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

  it('returns 400 when symbol or strategy is missing', async () => {
    const res = await request(buildApp())
      .post('/api/backtesting/run')
      .send({ symbol: 'MSFT' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing required/i);
  });

  it('returns 400 for an unknown timeframe', async () => {
    const res = await request(buildApp())
      .post('/api/backtesting/run')
      .send({ symbol: 'MSFT', strategy: 'ma_crossover', timeframe: '7min' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid timeframe/i);
  });

  it('returns 400 when initial_capital is non-positive', async () => {
    const res = await request(buildApp())
      .post('/api/backtesting/run')
      .send({
        symbol: 'MSFT',
        strategy: 'ma_crossover',
        timeframe: '1day',
        initial_capital: 0,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/initial_capital/);
  });

  it('returns 400 when commission is out of [0,1]', async () => {
    const res = await request(buildApp())
      .post('/api/backtesting/run')
      .send({
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
        }),
      }),
    );
  });

  it('still returns 200 even if the persistence insert throws', async () => {
    const repoMock = jest.requireMock('../src/services/backtestRunRepository.js') as {
      __insert: jest.Mock;
    };
    repoMock.__insert.mockRejectedValueOnce(new Error('db down'));

    axiosMock.post.mockResolvedValueOnce({
      data: { success: true, results: { equity_curve: [], trades_summary: [] }, timeframe: '1day', period: '1Y' },
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
      data: { strategies: { ma_crossover: { name: 'MA Crossover', indicators: ['sma'], description: '' } } },
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
