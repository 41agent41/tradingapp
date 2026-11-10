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
jest.mock('../src/services/marketDataService.js', () => ({
  marketDataService: {
    getOrCreateContract: jest.fn().mockResolvedValue(31),
    storeCandlestickData: jest.fn().mockResolvedValue({ inserted: 0, updated: 0, errors: 0 }),
  },
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
import { dbService } from '../src/services/database.js';
import backtestingRouter from '../src/routes/backtesting.js';

const axiosMock = axios as jest.Mocked<typeof axios>;
// Grab the mocked repositories at module load — the same registry instances the
// route imported. `resetModules: true` (jest.config.cjs) makes an in-test
// `jest.requireMock(...)` hand back a fresh instance the route never uses.
const repoMock = jest.requireMock('../src/services/backtestRunRepository.js') as {
  __insert: jest.Mock;
};
const marketDataMock = jest.requireMock('../src/services/marketDataService.js') as {
  marketDataService: { storeCandlestickData: jest.Mock };
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
      .send({ data: 'broker', symbol: 'MSFT', strategy: 'ma_crossover', timeframe: '1day' });

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
          source: 'oanda', // priority default
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

    const res = await request(buildApp())
      .post('/api/backtesting/run')
      .send({ data: 'broker', definition_id: 7 });

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
    const res = await request(buildApp())
      .post('/api/backtesting/run')
      .send({ data: 'broker', definition_id: 99 });
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
      .send({
        data: 'broker',
        rule_set: { symbol: 'AAPL', timeframe: '1day', entry: { all: [] } },
      });

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

  it('labels an inline Jesse definition by its strategy and forwards hyperparameters', async () => {
    axiosMock.post.mockResolvedValueOnce({
      data: {
        success: true,
        engine: 'jesse',
        results: { equity_curve: [], trades_summary: [] },
        timeframe: '1hour',
        period: '1Y',
      },
    });

    const ruleSet = { engine: 'jesse', strategy: 'SMACrossover', hyperparameters: { fast: 5 } };
    const res = await request(buildApp())
      .post('/api/backtesting/run')
      .send({ data: 'broker', symbol: 'MSFT', timeframe: '1hour', rule_set: ruleSet });

    expect(res.status).toBe(200);
    expect(axiosMock.post).toHaveBeenCalledWith(
      expect.stringContaining('/backtesting/run'),
      { rule_set: ruleSet },
      expect.objectContaining({
        params: expect.objectContaining({ symbol: 'MSFT', timeframe: '1hour' }),
      })
    );
    expect(repoMock.__insert).toHaveBeenCalledWith(
      expect.objectContaining({
        strategy: 'jesse:SMACrossover',
        params: expect.objectContaining({ rule_set: ruleSet }),
      })
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
      .send({ data: 'broker', symbol: 'MSFT', strategy: 'ma_crossover', timeframe: '1day' });

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

// --------------------------------------------------------------------------- //
// Stored bars (the default): coverage, the choice when bars are missing, the hash
// --------------------------------------------------------------------------- //

const HOUR = 3600;
const T0 = Date.UTC(2026, 0, 5) / 1000;

/** A database holding `count` hourly bars from `first` for contract 31. */
function storedBars(opts: { count: number; first?: number; contract?: boolean }) {
  const first = opts.first ?? T0;
  const rows = Array.from({ length: opts.count }, (_, i) => ({
    t: first + i * HOUR,
    o: 1.1,
    h: 1.2,
    l: 1.0,
    c: 1.15,
    v: 10,
  }));
  (dbService.query as jest.Mock).mockImplementation(async (sql: string) => {
    if (sql.includes('FROM contracts')) {
      return {
        rows:
          opts.contract === false
            ? []
            : [
                {
                  id: 31,
                  broker_account: 'default',
                  sec_type: 'CASH',
                  exchange: null,
                  currency: 'USD',
                },
              ],
      };
    }
    if (sql.includes('min(timestamp)')) {
      return {
        rows: [
          {
            bars: rows.length,
            first: rows.length ? new Date(first * 1000) : null,
            last: rows.length ? new Date(rows[rows.length - 1].t * 1000) : null,
          },
        ],
      };
    }
    if (sql.includes('lag(timestamp)')) return { rows: [] };
    if (sql.includes('extract(epoch')) return { rows };
    return { rows: [] };
  });
  return rows;
}

const RANGE = { start_date: '2026-01-05', end_date: '2026-01-09' };
const OK = {
  data: { success: true, results: { equity_curve: [], trades_summary: [] }, data_points: 96 },
};

describe('POST /api/backtesting/run on stored bars', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sends the stored bars with the run and records their range and hash', async () => {
    const rows = storedBars({ count: 96 });
    axiosMock.post.mockResolvedValueOnce(OK);

    const res = await request(buildApp())
      .post('/api/backtesting/run')
      .send({ symbol: 'eur_usd', strategy: 'ma_crossover', source: 'oanda', ...RANGE });

    expect(res.status).toBe(200);
    const [, body, config] = axiosMock.post.mock.calls[0];
    expect((body as any).bars.t).toHaveLength(96);
    expect((body as any).bars.t[0]).toBe(rows[0].t);
    expect((config as any).maxBodyLength).toBe(Infinity);
    expect(res.body.data).toMatchObject({
      source: 'stored',
      contract_id: 31,
      bars: 96,
      first_bar: '2026-01-05T00:00:00.000Z',
      complete: true,
    });
    expect(res.body.data.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(repoMock.__insert).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ source: 'stored', bars: 96, hash: res.body.data.hash }),
      })
    );

    // The same bars again give the same hash.
    axiosMock.post.mockResolvedValueOnce(OK);
    const again = await request(buildApp())
      .post('/api/backtesting/run')
      .send({ symbol: 'EUR_USD', strategy: 'ma_crossover', source: 'oanda', ...RANGE });
    expect(again.body.data.hash).toBe(res.body.data.hash);
  });

  it('answers 409 with the coverage and the choices when bars are missing', async () => {
    storedBars({ count: 24 });
    const res = await request(buildApp()).post('/api/backtesting/run').send({
      symbol: 'EUR_USD',
      strategy: 'ma_crossover',
      source: 'oanda',
      start_date: '2025-06-01',
      end_date: '2026-01-06',
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'coverage_incomplete',
      choices: ['fetch', 'use_stored'],
      coverage: { bars: 24, complete: false },
    });
    expect(res.body.detail).toMatch(/Missing: 2025-06-01 to 2026-01-05/);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  it('runs on what is stored when asked to, and marks the run incomplete', async () => {
    storedBars({ count: 60 });
    axiosMock.post.mockResolvedValueOnce(OK);
    const res = await request(buildApp()).post('/api/backtesting/run').send({
      symbol: 'EUR_USD',
      strategy: 'ma_crossover',
      source: 'oanda',
      start_date: '2025-06-01',
      end_date: '2026-01-08',
      on_missing: 'use_stored',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ source: 'stored', bars: 60, complete: false });
    expect(axiosMock.get).not.toHaveBeenCalled();
  });

  it('fetches what is missing from the broker and stores it before running', async () => {
    storedBars({ count: 60 });
    axiosMock.get.mockResolvedValue({
      data: { bars: [{ timestamp: T0 - HOUR, open: 1, high: 1, low: 1, close: 1, volume: 1 }] },
    });
    axiosMock.post.mockResolvedValueOnce(OK);
    const res = await request(buildApp()).post('/api/backtesting/run').send({
      symbol: 'EUR_USD',
      strategy: 'ma_crossover',
      source: 'oanda',
      start_date: '2025-12-01',
      end_date: '2026-01-08',
      on_missing: 'fetch',
    });
    expect(res.status).toBe(200);
    // The missing stretch, in whole days, from the instrument's own broker.
    expect(axiosMock.get).toHaveBeenCalledWith(
      expect.stringContaining('/market-data/history'),
      expect.objectContaining({
        params: expect.objectContaining({
          source: 'oanda',
          symbol: 'EUR_USD',
          timeframe: '1hour',
          secType: 'CASH',
          start_date: '2025-12-01',
          end_date: '2026-01-05',
        }),
      })
    );
    expect(marketDataMock.marketDataService.storeCandlestickData).toHaveBeenCalledWith(
      31,
      '1hour',
      [expect.objectContaining({ timestamp: new Date((T0 - HOUR) * 1000) })]
    );
  });

  it('says so when nothing is stored and nothing may be fetched', async () => {
    storedBars({ count: 0, contract: false });
    const res = await request(buildApp())
      .post('/api/backtesting/run')
      .send({ symbol: 'EUR_USD', strategy: 'ma_crossover', ...RANGE, on_missing: 'use_stored' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/No bars are stored/);
  });

  it('refuses a bad range or choice', async () => {
    const base = { symbol: 'EUR_USD', strategy: 'ma_crossover' };
    const bad = [
      [{ ...base, start_date: '2026-01-09', end_date: '2026-01-05' }, /before end_date/],
      [{ ...base, start_date: '2026-01-05' }, /both be dates/],
      [{ ...base, period: 'forever' }, /period must be/],
      [{ ...base, on_missing: 'guess' }, /on_missing/],
      [{ ...base, data: 'elsewhere' }, /data must be/],
    ] as const;
    for (const [body, message] of bad) {
      const res = await request(buildApp()).post('/api/backtesting/run').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(message);
    }
  });
});

describe('GET /api/backtesting/coverage', () => {
  it('reports what is stored for a range', async () => {
    storedBars({ count: 96 });
    const res = await request(buildApp())
      .get('/api/backtesting/coverage')
      .query({ symbol: 'eur_usd', source: 'oanda', timeframe: '1hour', ...RANGE });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      message: null,
      coverage: { contract_id: 31, bars: 96, complete: true, missing: [] },
    });
  });

  it('needs a symbol', async () => {
    const res = await request(buildApp()).get('/api/backtesting/coverage');
    expect(res.status).toBe(400);
  });
});
