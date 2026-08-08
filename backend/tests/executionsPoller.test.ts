/**
 * ExecutionsPoller tests. Every dependency is injected, so the orchestration —
 * venue discovery, the overlapping window, per-venue and per-row isolation, the
 * re-link pass — is exercised with no DB, venue or network.
 *
 * The behaviours pinned here are the ones that make it safe to leave running:
 * one bad venue or one bad row must never cost the rest of the sync, and a
 * long tick must never overlap the next.
 */
import {
  ExecutionsPoller,
  type ExecutionsPollerDeps,
  type RemoteExecution,
} from '../src/services/executionsPoller.js';
import type { Connection } from '../src/services/orderTypes.js';

function remote(overrides: Partial<RemoteExecution> = {}): RemoteExecution {
  return {
    exec_id: 'e1',
    order_id: '42',
    symbol: 'MSFT',
    side: 'BUY',
    quantity: 100,
    price: 410.25,
    commission: 1,
    realized_pnl: null,
    executed_at: '2026-08-07T13:30:00Z',
    currency: 'USD',
    broker: 'ib',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ExecutionsPollerDeps> = {}): ExecutionsPollerDeps {
  return {
    listConnections: jest.fn().mockResolvedValue([{ broker: 'ib', brokerAccount: 'default' }]),
    fetchExecutions: jest.fn().mockResolvedValue([remote()]),
    upsert: jest.fn().mockResolvedValue({ inserted: true }),
    relinkOrphans: jest.fn().mockResolvedValue(0),
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

function poller(deps: Partial<ExecutionsPollerDeps>, opts = {}) {
  return new ExecutionsPoller({ deps: makeDeps(deps), enabled: true, ...opts });
}

describe('ExecutionsPoller — ingest', () => {
  it('polls every active venue and upserts its fills', async () => {
    const deps = makeDeps({
      listConnections: jest.fn().mockResolvedValue([
        { broker: 'ib', brokerAccount: 'default' },
        { broker: 'alpaca', brokerAccount: 'default' },
      ]),
      fetchExecutions: jest.fn().mockResolvedValue([remote(), remote({ exec_id: 'e2' })]),
    });
    const p = new ExecutionsPoller({ deps, enabled: true, lookbackDays: 3 });

    await p.runOnce();

    expect(deps.fetchExecutions).toHaveBeenCalledWith(
      { broker: 'ib', brokerAccount: 'default' },
      3
    );
    expect(deps.fetchExecutions).toHaveBeenCalledWith(
      { broker: 'alpaca', brokerAccount: 'default' },
      3
    );
    expect(deps.upsert).toHaveBeenCalledTimes(4);
    expect(p.inserted).toBe(4);
    expect(p.errors).toBe(0);
  });

  // Bug ① from the multi-platform plan. MT5 allocates deal tickets per
  // terminal starting low, so two accounts genuinely both report deal
  // `12345`. The poller must stamp the connection it polled — not anything
  // from the payload — or the second fill is swallowed as a duplicate by the
  // unique key and the position, realised P&L and max_daily_loss all go wrong.
  it('stamps each fill with the connection it was polled from', async () => {
    const deps = makeDeps({
      listConnections: jest.fn().mockResolvedValue([
        { broker: 'mt5', brokerAccount: 'icmarkets-live' },
        { broker: 'mt5', brokerAccount: 'pepperstone-live' },
      ]),
      // The same exec_id from both accounts — the collision this key fixes.
      fetchExecutions: jest.fn().mockResolvedValue([remote({ exec_id: '12345' })]),
    });

    await new ExecutionsPoller({ deps, enabled: true }).runOnce();

    expect(deps.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ exec_id: '12345', broker_account: 'icmarkets-live' })
    );
    expect(deps.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ exec_id: '12345', broker_account: 'pepperstone-live' })
    );
  });

  it('ignores any account the payload claims, trusting only the polled connection', async () => {
    const deps = makeDeps({
      listConnections: jest
        .fn()
        .mockResolvedValue([{ broker: 'mt5', brokerAccount: 'icmarkets-live' }]),
      fetchExecutions: jest.fn().mockResolvedValue([remote({ account: 'some-other-account' })]),
    });

    await new ExecutionsPoller({ deps, enabled: true }).runOnce();

    expect(deps.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ broker_account: 'icmarkets-live' })
    );
  });

  it('maps the venue payload onto the stored shape', async () => {
    const deps = makeDeps();
    await new ExecutionsPoller({ deps, enabled: true }).runOnce();

    expect(deps.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        broker: 'ib',
        exec_id: 'e1',
        broker_order_id: '42',
        symbol: 'MSFT',
        side: 'BUY',
        quantity: 100,
        price: 410.25,
        commission: 1,
        executed_at: '2026-08-07T13:30:00Z',
      })
    );
  });

  it('counts re-delivered fills as seen, not as new', async () => {
    // The window overlaps deliberately, so most rows on most ticks are repeats.
    const p = poller({ upsert: jest.fn().mockResolvedValue({ inserted: false }) });

    await p.runOnce();

    expect(p.fetched).toBe(1);
    expect(p.inserted).toBe(0);
  });

  it('skips rows with no exec_id or symbol without counting an error', async () => {
    const deps = makeDeps({
      fetchExecutions: jest
        .fn()
        .mockResolvedValue([
          remote({ exec_id: '' }),
          remote({ symbol: '' }),
          remote({ exec_id: 'good' }),
        ]),
    });
    const p = new ExecutionsPoller({ deps, enabled: true });

    await p.runOnce();

    expect(deps.upsert).toHaveBeenCalledTimes(1);
    expect(p.errors).toBe(0);
  });
});

describe('ExecutionsPoller — isolation', () => {
  it('one unreachable venue does not stop the others', async () => {
    const fetchExecutions = jest
      .fn()
      .mockRejectedValueOnce(new Error('mt5 bridge unreachable'))
      .mockResolvedValueOnce([remote()]);
    const deps = makeDeps({
      listConnections: jest.fn().mockResolvedValue([
        { broker: 'mt5', brokerAccount: 'default' },
        { broker: 'ib', brokerAccount: 'default' },
      ]),
      fetchExecutions,
    });
    const p = new ExecutionsPoller({ deps, enabled: true });

    await p.runOnce();

    expect(p.errors).toBe(1);
    expect(p.inserted).toBe(1);
  });

  it('one bad row does not abandon the rest of the batch', async () => {
    const upsert = jest
      .fn()
      .mockRejectedValueOnce(new Error('constraint violation'))
      .mockResolvedValue({ inserted: true });
    const deps = makeDeps({
      fetchExecutions: jest
        .fn()
        .mockResolvedValue([remote({ exec_id: 'bad' }), remote({ exec_id: 'ok' })]),
      upsert,
    });
    const p = new ExecutionsPoller({ deps, enabled: true });

    await p.runOnce();

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(p.errors).toBe(1);
    expect(p.inserted).toBe(1);
  });

  it('never throws out of runOnce', async () => {
    const p = poller({ listConnections: jest.fn().mockRejectedValue(new Error('db down')) });
    await expect(p.runOnce()).resolves.toBeUndefined();
    expect(p.errors).toBe(1);
  });
});

describe('ExecutionsPoller — attribution', () => {
  it('re-links orphaned fills after ingest, not before', async () => {
    // A fill polled in the same tick its order was acknowledged must still get
    // attributed, so the re-link has to see this tick's rows.
    const order: string[] = [];
    const deps = makeDeps({
      upsert: jest.fn().mockImplementation(async () => {
        order.push('upsert');
        return { inserted: true };
      }),
      relinkOrphans: jest.fn().mockImplementation(async () => {
        order.push('relink');
        return 2;
      }),
    });
    const p = new ExecutionsPoller({ deps, enabled: true });

    await p.runOnce();

    expect(order).toEqual(['upsert', 'relink']);
    expect(p.relinked).toBe(2);
  });

  it('a failed re-link is counted, not fatal', async () => {
    const p = poller({ relinkOrphans: jest.fn().mockRejectedValue(new Error('nope')) });

    await p.runOnce();

    expect(p.errors).toBe(1);
    expect(p.inserted).toBe(1);
  });
});

describe('ExecutionsPoller — lifecycle', () => {
  it('does nothing when disabled', async () => {
    const deps = makeDeps();
    const p = new ExecutionsPoller({ deps, enabled: false });

    p.start();

    expect(p.status().enabled).toBe(false);
    expect(deps.fetchExecutions).not.toHaveBeenCalled();
    p.stop();
  });

  it('skips a tick while the previous one is still running', async () => {
    let release!: () => void;
    const deps = makeDeps({
      listConnections: jest.fn().mockImplementation(
        () =>
          new Promise<Connection[]>((resolve) => {
            release = () => resolve([{ broker: 'ib', brokerAccount: 'default' }]);
          })
      ),
    });
    const p = new ExecutionsPoller({ deps, enabled: true });

    const first = p.runOnce();
    await p.runOnce(); // should return immediately
    release();
    await first;

    expect(deps.listConnections).toHaveBeenCalledTimes(1);
  });

  it('reports its diagnostics', async () => {
    const p = poller({});
    await p.runOnce();

    expect(p.status()).toEqual(
      expect.objectContaining({
        enabled: true,
        running: false,
        totals: expect.objectContaining({ runs: 1, fetched: 1, inserted: 1 }),
      })
    );
  });
});
