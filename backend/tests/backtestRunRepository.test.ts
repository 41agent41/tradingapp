/**
 * Tests for BacktestRunRepository.
 *
 * The repo is exercised against a hand-rolled fake `Querier` so the suite
 * is hermetic — no Postgres connection required.
 */
import {
  BacktestRunRepository,
  type BacktestRunInput,
  type Querier,
  paramsHash,
} from '../src/services/backtestRunRepository.js';

class FakeQuerier implements Querier {
  calls: Array<{ text: string; params: unknown[] }> = [];
  nextRows: any[] = [];

  async query(text: string, params: unknown[] = []) {
    this.calls.push({ text, params });
    return { rows: this.nextRows };
  }
}

function sampleInput(overrides: Partial<BacktestRunInput> = {}): BacktestRunInput {
  return {
    strategy: 'ma_crossover',
    symbol: 'msft',
    timeframe: '1day',
    period: '1Y',
    initial_capital: 100000,
    commission: 0.001,
    params: { fast: 10, slow: 30 },
    metrics: { sharpe: 1.2 },
    equity_curve: [
      { time: 1, value: 100000 },
      { time: 2, value: 101234 },
    ],
    trades: [{ side: 'long' }, { side: 'short' }],
    ...overrides,
  };
}

describe('paramsHash', () => {
  it('produces a stable, deterministic hash for the same input', () => {
    const a = paramsHash(sampleInput());
    const b = paramsHash(sampleInput());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalises symbol case so MSFT and msft hash identically', () => {
    expect(paramsHash(sampleInput({ symbol: 'MSFT' }))).toBe(
      paramsHash(sampleInput({ symbol: 'msft' })),
    );
  });

  it('changes when an input parameter changes', () => {
    const baseline = paramsHash(sampleInput());
    expect(paramsHash(sampleInput({ commission: 0.002 }))).not.toBe(baseline);
    expect(paramsHash(sampleInput({ params: { fast: 5, slow: 30 } }))).not.toBe(baseline);
  });

  it('does NOT include the metrics or equity curve in the hash', () => {
    const baseline = paramsHash(sampleInput());
    const other = paramsHash(
      sampleInput({ metrics: { sharpe: 99 }, equity_curve: [], trades: [] }),
    );
    expect(other).toBe(baseline);
  });
});

describe('BacktestRunRepository.insert', () => {
  it('uppercases the symbol, persists trade_count + final_equity from the curve', async () => {
    const db = new FakeQuerier();
    db.nextRows = [{ id: 42 }];
    const repo = new BacktestRunRepository(db);

    await repo.insert(sampleInput());

    expect(db.calls).toHaveLength(1);
    const call = db.calls[0];
    expect(call.text).toMatch(/INSERT INTO backtest_runs/);
    // values index map (1-based in SQL, 0-based in array):
    //   [strategy, symbol, timeframe, period, start, end, capital, commission,
    //    params, hash, metrics, equity, trades, trade_count, final_equity]
    expect(call.params[1]).toBe('MSFT');
    expect(call.params[13]).toBe(2); // trade_count
    expect(call.params[14]).toBe(101234); // final_equity from last curve point
  });

  it('coerces non-array trades / equity_curve to []', async () => {
    const db = new FakeQuerier();
    db.nextRows = [{ id: 1 }];
    const repo = new BacktestRunRepository(db);

    await repo.insert(
      sampleInput({ trades: null as unknown as any[], equity_curve: undefined as unknown as any[] }),
    );

    const call = db.calls[0];
    expect(call.params[11]).toBe('[]'); // equity_curve JSON
    expect(call.params[12]).toBe('[]'); // trades JSON
    expect(call.params[13]).toBe(0); // trade_count
    expect(call.params[14]).toBeNull(); // final_equity
  });

  it('passes through CUSTOM range fields when provided', async () => {
    const db = new FakeQuerier();
    db.nextRows = [{ id: 1 }];
    const repo = new BacktestRunRepository(db);

    await repo.insert(
      sampleInput({ period: 'CUSTOM', start_date: '2025-01-01', end_date: '2025-12-31' }),
    );

    const call = db.calls[0];
    expect(call.params[3]).toBe('CUSTOM');
    expect(call.params[4]).toBe('2025-01-01');
    expect(call.params[5]).toBe('2025-12-31');
  });
});

describe('BacktestRunRepository.list', () => {
  it('builds the bare query with default limit/offset when no filters supplied', async () => {
    const db = new FakeQuerier();
    db.nextRows = [];
    const repo = new BacktestRunRepository(db);

    await repo.list();
    const call = db.calls[0];

    expect(call.text).toMatch(/FROM backtest_runs/);
    expect(call.text).not.toMatch(/WHERE/);
    expect(call.text).toMatch(/ORDER BY created_at DESC/);
    // Default: [limit=25, offset=0]
    expect(call.params).toEqual([25, 0]);
  });

  it('adds symbol + strategy WHERE clauses and uppercases symbol', async () => {
    const db = new FakeQuerier();
    db.nextRows = [];
    const repo = new BacktestRunRepository(db);

    await repo.list({ symbol: 'aapl', strategy: 'rsi_mean_reversion', limit: 5, offset: 10 });
    const call = db.calls[0];

    expect(call.text).toMatch(/WHERE symbol = \$1 AND strategy = \$2/);
    expect(call.params).toEqual(['AAPL', 'rsi_mean_reversion', 5, 10]);
  });

  it('clamps limit to [1, 100]', async () => {
    const db = new FakeQuerier();
    db.nextRows = [];
    const repo = new BacktestRunRepository(db);

    await repo.list({ limit: 9999 });
    expect(db.calls[0].params[0]).toBe(100);

    await repo.list({ limit: -10 });
    expect(db.calls[1].params[0]).toBe(25); // negative falls back to default
  });
});

describe('BacktestRunRepository.findById', () => {
  it('returns the row when present', async () => {
    const db = new FakeQuerier();
    db.nextRows = [{ id: 7, strategy: 'ma_crossover' }];
    const repo = new BacktestRunRepository(db);

    const row = await repo.findById(7);
    expect(row?.id).toBe(7);
    expect(db.calls[0].params).toEqual([7]);
  });

  it('returns null when the row is missing', async () => {
    const db = new FakeQuerier();
    db.nextRows = [];
    const repo = new BacktestRunRepository(db);

    expect(await repo.findById(999)).toBeNull();
  });
});
