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
  setHoldoutStart: jest.fn(),
  listActiveHalts: jest.fn(),
  clearHalt: jest.fn(),
  listEquityMarks: jest.fn(),
  haltConnection: jest.fn(),
  countTradingDays: jest.fn(),
  resetHighWaterMark: jest.fn(),
};
jest.mock('../src/services/strategyRepository.js', () => ({
  __esModule: true,
  StrategyRepository: jest.fn().mockImplementation(() => repoImpl),
}));

const notifierImpl = { resolve: jest.fn(), notify: jest.fn() };

const flattenImpl = { flattenConnection: jest.fn() };
jest.mock('../src/services/flatten.js', () => {
  const actual = jest.requireActual('../src/services/flatten.js');
  return {
    __esModule: true,
    ...actual,
    defaultFlattenDeps: () => ({}),
    flattenConnection: (...args: unknown[]) => flattenImpl.flattenConnection(...args),
  };
});
jest.mock('../src/services/notifier.js', () => ({
  __esModule: true,
  notifier: notifierImpl,
}));

// The gate's own rules are tested in promotionGate.test.ts; here it is a
// stub that allows by default, and individual tests make it refuse.
const promotionImpl = {
  check: jest.fn(),
  paperStatus: jest.fn(),
};
jest.mock('../src/services/promotionService.js', () => ({
  __esModule: true,
  PromotionService: jest.fn().mockImplementation(() => promotionImpl),
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

function allow(stage = 'paper') {
  return { definition_id: 1, stage, allowed: true, reasons: [] };
}

beforeEach(() => {
  jest.clearAllMocks();
  promotionImpl.check.mockImplementation(async (_def: unknown, stage: string) => allow(stage));
  promotionImpl.paperStatus.mockResolvedValue(new Map());
});

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

  it("accepts a jesse definition without an 'entry' group", async () => {
    const jesseDef = {
      ...VALID_DEF,
      rule_set: { engine: 'jesse', strategy: 'SMACrossover', hyperparameters: { fast: 10 } },
    };
    repoImpl.createDefinition.mockResolvedValue({ id: 12, ...jesseDef });
    const res = await request(buildApp()).post('/api/strategies/definitions').send(jesseDef);
    expect(res.status).toBe(201);
    expect(repoImpl.createDefinition).toHaveBeenCalledWith(
      expect.objectContaining({ rule_set: jesseDef.rule_set })
    );
  });

  it("400s on a jesse definition without a 'strategy'", async () => {
    const res = await request(buildApp())
      .post('/api/strategies/definitions')
      .send({ ...VALID_DEF, rule_set: { engine: 'jesse' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/strategy/i);
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

  it('resumes a halted connection and resolves its halt alert', async () => {
    repoImpl.clearHalt.mockResolvedValue({
      id: 1,
      broker: 'mt5',
      broker_account: 'pepperstone',
      trigger_kind: 'unprotected_position',
    });
    notifierImpl.resolve.mockResolvedValue(undefined);
    const res = await request(buildApp())
      .post('/api/strategies/connections/mt5/pepperstone/resume')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.resumed).toBe(true);
    expect(repoImpl.clearHalt).toHaveBeenCalledWith('mt5', 'pepperstone', 'operator');
    expect(notifierImpl.resolve).toHaveBeenCalledWith(
      'killswitch:halt:mt5:pepperstone',
      expect.objectContaining({ title: 'Resumed: entries on mt5:pepperstone' })
    );
  });

  it('resets the high-water mark to current equity', async () => {
    repoImpl.resetHighWaterMark.mockResolvedValue({
      trading_day: '2026-10-13',
      day_start_equity: 9000,
      high_water_mark: 9000,
      equity: 9000,
    });
    const res = await request(buildApp())
      .post('/api/strategies/connections/mt5/pepperstone/reset-high-water-mark')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.high_water_mark).toBe(9000);
    expect(repoImpl.resetHighWaterMark).toHaveBeenCalledWith('mt5', 'pepperstone');
  });

  describe('flatten', () => {
    const providers = {
      data: {
        connections: {
          'mt5:pepperstone': { platform: 'mt5', account: 'pepperstone', account_mode: 'live' },
        },
      },
    };

    it('halts the connection, closes its positions and reports what it did', async () => {
      axiosMock.get.mockResolvedValue(providers);
      repoImpl.haltConnection.mockResolvedValue({ created: true });
      notifierImpl.notify.mockResolvedValue(undefined);
      flattenImpl.flattenConnection.mockResolvedValue({
        closed: [{ symbol: 'EURUSD.a', action: 'SELL', quantity: 1, audit_id: 5 }],
        failed: [],
        error: null,
      });
      const res = await request(buildApp())
        .post('/api/strategies/connections/mt5/pepperstone/flatten')
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({ halted: true, complete: true, connection: 'mt5:pepperstone' })
      );
      expect(repoImpl.haltConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          broker: 'mt5',
          brokerAccount: 'pepperstone',
          triggerKind: 'operator_flatten',
        })
      );
      expect(flattenImpl.flattenConnection).toHaveBeenCalledWith(
        expect.anything(),
        { broker: 'mt5', brokerAccount: 'pepperstone' },
        'live',
        'operator'
      );
      expect(notifierImpl.notify).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Positions closed on mt5:pepperstone by the operator' })
      );
    });

    it('says what is still open when a close fails', async () => {
      axiosMock.get.mockResolvedValue(providers);
      repoImpl.haltConnection.mockResolvedValue({ created: false });
      notifierImpl.notify.mockResolvedValue(undefined);
      flattenImpl.flattenConnection.mockResolvedValue({
        closed: [],
        failed: [{ symbol: 'EURUSD.a', error: 'not placed (live_disabled)' }],
        error: null,
      });
      const res = await request(buildApp())
        .post('/api/strategies/connections/mt5/pepperstone/flatten')
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.complete).toBe(false);
      expect(res.body.failed).toHaveLength(1);
      expect(notifierImpl.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: 'critical',
          title: expect.stringMatching(/INCOMPLETE/),
        })
      );
    });

    it('refuses an unknown connection without halting anything', async () => {
      axiosMock.get.mockResolvedValue(providers);
      repoImpl.haltConnection.mockClear();
      const res = await request(buildApp())
        .post('/api/strategies/connections/mt5/nowhere/flatten')
        .send({});
      expect(res.status).toBe(404);
      expect(repoImpl.haltConnection).not.toHaveBeenCalled();
    });

    it('refuses when the broker service cannot say the account mode', async () => {
      axiosMock.get.mockRejectedValue(new Error('ECONNREFUSED'));
      const res = await request(buildApp())
        .post('/api/strategies/connections/mt5/pepperstone/flatten')
        .send({});
      expect(res.status).toBe(502);
    });
  });

  it('answers 404 when resuming a connection that is not halted', async () => {
    repoImpl.clearHalt.mockResolvedValue(null);
    const res = await request(buildApp())
      .post('/api/strategies/connections/mt5/pepperstone/resume')
      .send({});
    expect(res.status).toBe(404);
  });
});

// --------------------------------------------------------------------------- //
// Fleet view (C-5)
// --------------------------------------------------------------------------- //
describe('GET /api/strategies/fleet', () => {
  const providers = {
    data: {
      connections: {
        'mt5:icmarkets': { platform: 'mt5', account: 'icmarkets', account_mode: 'live' },
        'mt5:pepperstone': { platform: 'mt5', account: 'pepperstone', account_mode: 'paper' },
      },
      currency: { consistent: true, currencies: ['USD'] },
    },
  };

  const legs = [
    {
      id: 1,
      definition_id: 10,
      broker: 'mt5',
      broker_account: 'icmarkets',
      native_symbol: 'EURUSD.a',
      account_mode: 'live',
      status: 'running',
      is_canary: true,
      current_stop: '1.09',
      run_group_id: 5,
    },
    {
      id: 2,
      definition_id: 10,
      broker: 'mt5',
      broker_account: 'pepperstone',
      native_symbol: 'EURUSD_i',
      account_mode: 'paper',
      status: 'pending',
      is_canary: false,
      current_stop: null,
      run_group_id: 5,
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    repoImpl.listRuns.mockResolvedValue(legs);
    repoImpl.listActiveHalts.mockResolvedValue([]);
    repoImpl.listEquityMarks.mockResolvedValue([]);
    repoImpl.findDefinition.mockResolvedValue({
      id: 10,
      name: 'EU trend',
      symbol: 'EURUSD',
      timeframe: '5min',
    });
  });

  it('groups legs by definition, so one strategy on N accounts reads as one row', async () => {
    axiosMock.get.mockResolvedValue(providers);

    const res = await request(buildApp()).get('/api/strategies/fleet');

    expect(res.status).toBe(200);
    expect(res.body.strategies).toHaveLength(1);
    expect(res.body.strategies[0].name).toBe('EU trend');
    expect(res.body.strategies[0].legs.map((l: any) => l.connection)).toEqual([
      'mt5:icmarkets',
      'mt5:pepperstone',
    ]);
    // Each leg carries the symbol it actually trades, not the canonical one.
    expect(res.body.strategies[0].legs.map((l: any) => l.native_symbol)).toEqual([
      'EURUSD.a',
      'EURUSD_i',
    ]);
  });

  it('counts active runs per connection', async () => {
    axiosMock.get.mockResolvedValue(providers);
    const res = await request(buildApp()).get('/api/strategies/fleet');

    const byLabel = Object.fromEntries(
      res.body.connections.map((c: any) => [c.connection, c.active_runs])
    );
    expect(byLabel['mt5:icmarkets']).toBe(1);
    expect(byLabel['mt5:pepperstone']).toBe(1);
  });

  it('surfaces the declared account_mode alongside each connection', async () => {
    // The live/demo distinction has to be visible where the mistake would be
    // made, not buried in config.
    axiosMock.get.mockResolvedValue(providers);
    const res = await request(buildApp()).get('/api/strategies/fleet');

    const live = res.body.connections.find((c: any) => c.connection === 'mt5:icmarkets');
    expect(live.account_mode).toBe('live');
  });

  it('marks a halted connection with what halted it', async () => {
    axiosMock.get.mockResolvedValue(providers);
    repoImpl.listActiveHalts.mockResolvedValue([
      {
        id: 3,
        broker: 'mt5',
        broker_account: 'icmarkets',
        trigger_kind: 'unprotected_position',
        detail: 'EURUSD is 0.1 with no protective stop',
        run_id: 1,
        halted_at: '2026-10-13T00:00:00Z',
        cleared_at: null,
        cleared_by: null,
      },
    ]);
    const res = await request(buildApp()).get('/api/strategies/fleet');

    const byLabel = Object.fromEntries(res.body.connections.map((c: any) => [c.connection, c]));
    expect(byLabel['mt5:icmarkets'].halt.trigger_kind).toBe('unprotected_position');
    expect(byLabel['mt5:pepperstone'].halt).toBeNull();
  });

  it("shows each connection's equity against its loss limits", async () => {
    axiosMock.get.mockResolvedValue(providers);
    process.env.CONNECTION_MAX_DRAWDOWN__MT5_ICMARKETS = '400';
    repoImpl.listEquityMarks.mockResolvedValue([
      {
        broker: 'mt5',
        broker_account: 'icmarkets',
        trading_day: '2026-10-13',
        day_start_equity: '10000',
        high_water_mark: '10500',
        last_equity: '10050',
        hwm_at: '2026-10-12T00:00:00Z',
        last_at: '2026-10-13T00:00:00Z',
      },
    ]);
    try {
      const res = await request(buildApp()).get('/api/strategies/fleet');
      const byLabel = Object.fromEntries(res.body.connections.map((c: any) => [c.connection, c]));
      expect(byLabel['mt5:icmarkets'].equity).toEqual(
        expect.objectContaining({
          equity: 10050,
          daily_loss: -50,
          drawdown: 450,
          max_drawdown: 400,
          breaches: ['drawdown'],
        })
      );
      expect(byLabel['mt5:pepperstone'].equity).toBeNull();
    } finally {
      delete process.env.CONNECTION_MAX_DRAWDOWN__MT5_ICMARKETS;
    }
  });

  it("shows a prop account's room against its firm's rules", async () => {
    axiosMock.get.mockResolvedValue(providers);
    process.env.PROP_RULES__MT5_ICMARKETS = JSON.stringify({
      firm: 'FTMO 10k',
      initial_balance: 10000,
      daily_loss: { pct: 5, basis: 'balance' },
      max_loss: { pct: 10, mode: 'static' },
    });
    repoImpl.listEquityMarks.mockResolvedValue([
      {
        broker: 'mt5',
        broker_account: 'icmarkets',
        trading_day: '2026-10-13',
        day_start_equity: '10000',
        high_water_mark: '10000',
        last_equity: '9700',
        day_start_balance: '10000',
        last_balance: '10000',
        balance_hwm: '10000',
        hwm_at: '2026-10-12T00:00:00Z',
        last_at: '2026-10-13T00:00:00Z',
      },
    ]);
    try {
      const res = await request(buildApp()).get('/api/strategies/fleet');
      const conn = res.body.connections.find((c: any) => c.connection === 'mt5:icmarkets');
      expect(conn.equity.prop.firm).toBe('FTMO 10k');
      expect(conn.equity.prop.rules).toEqual([
        expect.objectContaining({
          kind: 'prop_daily_loss',
          floor: 9500,
          room: 200,
          stopped: false,
        }),
        expect.objectContaining({ kind: 'prop_max_loss', floor: 9000, room: 700, stopped: false }),
      ]);
    } finally {
      delete process.env.PROP_RULES__MT5_ICMARKETS;
    }
  });

  it("shows a prop account's schedule rules and trading days so far", async () => {
    axiosMock.get.mockResolvedValue(providers);
    process.env.PROP_RULES__MT5_ICMARKETS = JSON.stringify({
      firm: 'FTMO 10k',
      initial_balance: 10000,
      daily_loss: { pct: 5 },
      news_blackout: {},
      weekend: { no_entries_after: 'fri 20:00' },
      min_trading_days: { days: 4, start_date: '2026-10-01' },
    });
    repoImpl.countTradingDays.mockResolvedValue(2);
    repoImpl.listEquityMarks.mockResolvedValue([
      {
        broker: 'mt5',
        broker_account: 'icmarkets',
        trading_day: '2026-10-13',
        day_start_equity: '10000',
        high_water_mark: '10000',
        last_equity: '10000',
        day_start_balance: '10000',
        last_balance: '10000',
        balance_hwm: '10000',
        hwm_at: '2026-10-12T00:00:00Z',
        last_at: '2026-10-13T00:00:00Z',
      },
    ]);
    try {
      const res = await request(buildApp()).get('/api/strategies/fleet');
      const conn = res.body.connections.find((c: any) => c.connection === 'mt5:icmarkets');
      expect(conn.equity.prop).toEqual(
        expect.objectContaining({
          news_blackout: { minutes_before: 2, minutes_after: 2, impact: ['High'] },
          weekend: { no_entries_after: 'fri 20:00', resume: 'mon 00:00' },
          min_trading_days: { days: 4, start_date: '2026-10-01', traded: 2 },
        })
      );
      expect(repoImpl.countTradingDays).toHaveBeenCalledWith(
        'mt5',
        'icmarkets',
        '2026-10-01',
        'UTC'
      );
    } finally {
      delete process.env.PROP_RULES__MT5_ICMARKETS;
    }
  });

  it("says so when a prop account's rules cannot be read", async () => {
    axiosMock.get.mockResolvedValue(providers);
    process.env.PROP_RULES__MT5_ICMARKETS = 'not json';
    try {
      const res = await request(buildApp()).get('/api/strategies/fleet');
      expect(res.status).toBe(200);
      const conn = res.body.connections.find((c: any) => c.connection === 'mt5:icmarkets');
      expect(conn.equity.limits_error).toMatch(/PROP_RULES__MT5_ICMARKETS is not valid JSON/);
    } finally {
      delete process.env.PROP_RULES__MT5_ICMARKETS;
    }
  });

  it('still answers when the broker service is unreachable', async () => {
    // The DB half is still worth having, and "the broker service is down" is
    // itself the headline rather than a blank screen.
    axiosMock.get.mockRejectedValue(new Error('broker service down'));

    const res = await request(buildApp()).get('/api/strategies/fleet');

    expect(res.status).toBe(200);
    expect(res.body.broker_service_error).toMatch(/broker service down/);
    expect(res.body.strategies).toHaveLength(1);
  });

  it('reports pending legs distinctly from running ones', async () => {
    // A canary-staged deploy is a normal state, not an error, and the UI has
    // to be able to say so.
    axiosMock.get.mockResolvedValue(providers);
    const res = await request(buildApp()).get('/api/strategies/fleet');

    expect(res.body.totals.active_runs).toBe(2);
    expect(res.body.totals.pending_runs).toBe(1);
    expect(res.body.strategies[0].legs.find((l: any) => l.is_canary).status).toBe('running');
  });
});

describe('promotion gate', () => {
  const DEF = { id: 7, symbol: 'EURUSD', timeframe: '1hour', rule_set: {}, broker: 'mt5' };

  it('refuses a paper run without a passing backtest, with the reasons', async () => {
    repoImpl.findDefinition.mockResolvedValue(DEF);
    promotionImpl.check.mockResolvedValue({
      ...allow(),
      allowed: false,
      reasons: ['no backtest of definition 7 yet'],
    });
    const res = await request(buildApp())
      .post('/api/strategies/runs')
      .send({ definition_id: 7, account_mode: 'paper' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/paper gate/);
    expect(res.body.detail).toEqual(['no backtest of definition 7 yet']);
    expect(repoImpl.createRun).not.toHaveBeenCalled();
  });

  it('checks the live gate for a live run', async () => {
    repoImpl.findDefinition.mockResolvedValue(DEF);
    repoImpl.createRun.mockResolvedValue({ id: 1 });
    await request(buildApp())
      .post('/api/strategies/runs')
      .send({ definition_id: 7, account_mode: 'live' });
    expect(promotionImpl.check).toHaveBeenCalledWith(DEF, 'live');
  });

  it('refuses a deploy when any leg is live and the live gate fails', async () => {
    repoImpl.findDefinition.mockResolvedValue(DEF);
    promotionImpl.check.mockImplementation(async (_d: unknown, stage: string) =>
      stage === 'live' ? { ...allow('live'), allowed: false, reasons: ['too short'] } : allow()
    );
    const res = await request(buildApp())
      .post('/api/strategies/definitions/7/deploy')
      .send({
        targets: [
          { broker: 'mt5', account: 'a', canary: true },
          { broker: 'mt5', account: 'b', account_mode: 'live' },
        ],
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/live gate/);
    expect(promotionImpl.check.mock.calls.map((c: unknown[]) => c[1])).toEqual(['paper', 'live']);
    expect(axiosMock.post).not.toHaveBeenCalled();
    expect(repoImpl.createGroup).not.toHaveBeenCalled();
  });

  it('reports paper status on the definitions list', async () => {
    repoImpl.listDefinitions.mockResolvedValue([DEF]);
    promotionImpl.paperStatus.mockResolvedValue(
      new Map([[7, { ...allow(), allowed: false, reasons: ['no holdout'] }]])
    );
    const res = await request(buildApp()).get('/api/strategies/definitions');
    expect(res.body.definitions[0].promotion).toEqual({
      paper: { allowed: false, reasons: ['no holdout'] },
    });
  });

  it('returns both stages from the promotion route', async () => {
    repoImpl.findDefinition.mockResolvedValue(DEF);
    const res = await request(buildApp()).get('/api/strategies/definitions/7/promotion');
    expect(res.status).toBe(200);
    expect(res.body.paper.stage).toBe('paper');
    expect(res.body.live.stage).toBe('live');
  });
});

describe('holdout start', () => {
  it('is accepted at creation', async () => {
    repoImpl.createDefinition.mockResolvedValue({ id: 1 });
    const res = await request(buildApp())
      .post('/api/strategies/definitions')
      .send({ ...VALID_DEF, holdout_start: '2025-01-01' });
    expect(res.status).toBe(201);
    expect(repoImpl.createDefinition.mock.calls[0][0].holdout_start).toBe('2025-01-01');
  });

  it('rejects a future or malformed date', async () => {
    for (const bad of ['2999-01-01', '01/02/2025']) {
      const res = await request(buildApp())
        .post('/api/strategies/definitions')
        .send({ ...VALID_DEF, holdout_start: bad });
      expect(res.status).toBe(400);
    }
  });

  it('can be set once later', async () => {
    repoImpl.setHoldoutStart.mockResolvedValue({ id: 3, holdout_start: '2025-01-01' });
    const res = await request(buildApp())
      .patch('/api/strategies/definitions/3/holdout')
      .send({ holdout_start: '2025-01-01' });
    expect(res.status).toBe(200);
    expect(repoImpl.setHoldoutStart).toHaveBeenCalledWith(3, '2025-01-01');
  });

  it('cannot be moved once set', async () => {
    repoImpl.setHoldoutStart.mockResolvedValue(null);
    repoImpl.findDefinition.mockResolvedValue({ id: 3, holdout_start: '2024-06-01' });
    const res = await request(buildApp())
      .patch('/api/strategies/definitions/3/holdout')
      .send({ holdout_start: '2025-01-01' });
    expect(res.status).toBe(409);
  });
});
