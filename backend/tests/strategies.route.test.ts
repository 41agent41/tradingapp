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
  createGroup: jest.fn(),
  listGroupRuns: jest.fn(),
  stopGroup: jest.fn(),
  stopConnection: jest.fn(),
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

// --------------------------------------------------------------------------- //
// Deploy to many connections (C-3)
// --------------------------------------------------------------------------- //
describe('POST /api/strategies/definitions/:id/deploy', () => {
  const definition = {
    id: 1,
    symbol: 'EURUSD',
    broker: 'mt5',
    rule_set: { sizing: { type: 'fixed', size: 1 }, risk: {} },
  };

  function previewOf(rows: any[]) {
    return {
      data: {
        symbol: 'EURUSD',
        results: rows,
        resolved: rows.filter((r) => r.ok).length,
        refused: rows.filter((r) => !r.ok).length,
      },
    };
  }

  const okLeg = (account: string, native: string) => ({
    ok: true,
    broker: 'mt5',
    account,
    native,
    canonical: 'EURUSD',
  });

  beforeEach(() => {
    jest.clearAllMocks();
    repoImpl.findDefinition.mockResolvedValue(definition);
    repoImpl.createGroup.mockResolvedValue({ group: { id: 9 }, runs: [{ id: 1 }, { id: 2 }] });
  });

  it('resolves each leg and creates the group with per-connection symbols', async () => {
    axiosMock.post.mockResolvedValue(
      previewOf([okLeg('icmarkets', 'EURUSD.a'), okLeg('pepperstone', 'EURUSD_i')])
    );

    const res = await request(buildApp())
      .post('/api/strategies/definitions/1/deploy')
      .send({
        targets: [
          { broker: 'mt5', account: 'icmarkets', canary: true },
          { broker: 'mt5', account: 'pepperstone' },
        ],
      });

    expect(res.status).toBe(201);
    const legs = repoImpl.createGroup.mock.calls[0][0].legs;
    expect(legs.map((l: any) => l.native_symbol)).toEqual(['EURUSD.a', 'EURUSD_i']);
    expect(legs.filter((l: any) => l.is_canary)).toHaveLength(1);
  });

  it('refuses the whole deploy when a leg cannot resolve', async () => {
    // With one strategy across accounts, silently running on a subset is
    // usually not what was intended.
    axiosMock.post.mockResolvedValue(
      previewOf([
        okLeg('icmarkets', 'EURUSD.a'),
        { ok: false, broker: 'mt5', account: 'ftmo', error: 'no symbol matching EURUSD' },
      ])
    );

    const res = await request(buildApp())
      .post('/api/strategies/definitions/1/deploy')
      .send({
        targets: [
          { broker: 'mt5', account: 'icmarkets', canary: true },
          { broker: 'mt5', account: 'ftmo' },
        ],
      });

    expect(res.status).toBe(422);
    expect(res.body.detail.refused[0].account).toBe('ftmo');
    expect(repoImpl.createGroup).not.toHaveBeenCalled();
  });

  it('starts the resolvable legs when allow_partial is set', async () => {
    axiosMock.post.mockResolvedValue(
      previewOf([
        okLeg('icmarkets', 'EURUSD.a'),
        { ok: false, broker: 'mt5', account: 'ftmo', error: 'no symbol matching EURUSD' },
      ])
    );

    const res = await request(buildApp())
      .post('/api/strategies/definitions/1/deploy')
      .send({
        allow_partial: true,
        targets: [
          { broker: 'mt5', account: 'icmarkets', canary: true },
          { broker: 'mt5', account: 'ftmo' },
        ],
      });

    expect(res.status).toBe(201);
    expect(repoImpl.createGroup.mock.calls[0][0].legs).toHaveLength(1);
    expect(res.body.refused[0].account).toBe('ftmo');
  });

  it('refuses when the nominated canary is the leg that could not resolve', async () => {
    // Promoting another leg silently would move the first risk onto an account
    // the operator did not choose.
    axiosMock.post.mockResolvedValue(
      previewOf([
        { ok: false, broker: 'mt5', account: 'icmarkets', error: 'ambiguous' },
        okLeg('pepperstone', 'EURUSD_i'),
      ])
    );

    const res = await request(buildApp())
      .post('/api/strategies/definitions/1/deploy')
      .send({
        allow_partial: true,
        targets: [
          { broker: 'mt5', account: 'icmarkets', canary: true },
          { broker: 'mt5', account: 'pepperstone' },
        ],
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/canary/i);
    expect(repoImpl.createGroup).not.toHaveBeenCalled();
  });

  it('requires exactly one canary', async () => {
    const app = buildApp();
    const none = await request(app)
      .post('/api/strategies/definitions/1/deploy')
      .send({ targets: [{ broker: 'mt5', account: 'a' }] });
    expect(none.status).toBe(400);

    const two = await request(app)
      .post('/api/strategies/definitions/1/deploy')
      .send({
        targets: [
          { broker: 'mt5', account: 'a', canary: true },
          { broker: 'mt5', account: 'b', canary: true },
        ],
      });
    expect(two.status).toBe(400);
  });

  it('carries per-leg sizing so accounts of different size are not forced to match', async () => {
    axiosMock.post.mockResolvedValue(
      previewOf([okLeg('small', 'EURUSD.a'), okLeg('large', 'EURUSD.a')])
    );

    await request(buildApp())
      .post('/api/strategies/definitions/1/deploy')
      .send({
        targets: [
          { broker: 'mt5', account: 'small', canary: true, sizing: { type: 'risk_pct', pct: 0.5 } },
          { broker: 'mt5', account: 'large', sizing: { type: 'risk_pct', pct: 2 } },
        ],
      });

    const legs = repoImpl.createGroup.mock.calls[0][0].legs;
    expect(legs[0].sizing).toEqual({ type: 'risk_pct', pct: 0.5 });
    expect(legs[1].sizing).toEqual({ type: 'risk_pct', pct: 2 });
  });

  it('surfaces a resolution outage as a 502 rather than deploying blind', async () => {
    axiosMock.post.mockRejectedValue(new Error('broker service down'));

    const res = await request(buildApp())
      .post('/api/strategies/definitions/1/deploy')
      .send({ targets: [{ broker: 'mt5', account: 'a', canary: true }] });

    expect(res.status).toBe(502);
    expect(repoImpl.createGroup).not.toHaveBeenCalled();
  });
});

describe('group and connection lifecycle (C-3)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('stops every leg of a group', async () => {
    repoImpl.stopGroup.mockResolvedValue(3);
    const res = await request(buildApp()).post('/api/strategies/groups/9/stop').send({});
    expect(res.status).toBe(200);
    expect(res.body.stopped).toBe(3);
  });

  it('panic-stops a whole connection regardless of group', async () => {
    repoImpl.stopConnection.mockResolvedValue(2);
    const res = await request(buildApp())
      .post('/api/strategies/connections/mt5/pepperstone/stop')
      .send({});
    expect(res.status).toBe(200);
    expect(repoImpl.stopConnection).toHaveBeenCalledWith('mt5', 'pepperstone');
    expect(res.body.connection).toBe('mt5:pepperstone');
  });
});
