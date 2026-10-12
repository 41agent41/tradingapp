/**
 * The promotion gate's rules: backtest, then paper, then live.
 */
import {
  type BacktestEvidence,
  type DefinitionFacts,
  type PaperRunEvidence,
  evaluatePromotion,
  isoDay,
  promotionThresholds,
  realisedDrawdown,
} from '../src/services/promotionGate.js';

const T = promotionThresholds({});
const NOW = new Date('2026-10-12T00:00:00Z');

const DEF: DefinitionFacts = {
  id: 7,
  symbol: 'EURUSD',
  timeframe: '1hour',
  holdout_start: '2025-01-01',
};

function backtest(overrides: Partial<BacktestEvidence> = {}): BacktestEvidence {
  return {
    id: 1,
    symbol: 'EURUSD',
    timeframe: '1hour',
    data_start: '2025-01-02T00:00:00+00:00',
    trade_count: 40,
    max_drawdown: -10,
    avg_trade_pnl: 12.5,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function paper(overrides: Partial<PaperRunEvidence> = {}): PaperRunEvidence {
  return {
    run_id: 3,
    connection: 'mt5:demo',
    status: 'running',
    started_at: '2026-09-01T00:00:00Z',
    stopped_at: null,
    trade_fills: 20,
    max_drawdown_amount: 1000, // 10% of 10k
    equity: 10_000,
    ...overrides,
  };
}

describe('thresholds', () => {
  it('defaults to the agreed numbers', () => {
    expect(T).toEqual({
      minTrades: 30,
      maxBacktestDrawdownPct: 20,
      minPaperDays: 28,
      paperDrawdownRatio: 1.5,
      enforcePaper: true,
    });
  });

  it('reads overrides and ignores nonsense', () => {
    const t = promotionThresholds({ PROMOTION_MIN_TRADES: '50', PROMOTION_MIN_PAPER_DAYS: '-1' });
    expect(t.minTrades).toBe(50);
    expect(t.minPaperDays).toBe(28);
  });
});

describe('paper stage', () => {
  it('passes with a qualifying backtest', () => {
    const d = evaluatePromotion(DEF, 'paper', [backtest()], [], T, NOW);
    expect(d.allowed).toBe(true);
    expect(d.backtest_id).toBe(1);
  });

  it('needs a holdout start on the definition', () => {
    const d = evaluatePromotion({ ...DEF, holdout_start: null }, 'paper', [backtest()], [], T, NOW);
    expect(d.allowed).toBe(false);
    expect(d.reasons[0]).toMatch(/holdout start/);
  });

  it('needs a backtest', () => {
    const d = evaluatePromotion(DEF, 'paper', [], [], T, NOW);
    expect(d.allowed).toBe(false);
    expect(d.reasons[0]).toMatch(/no backtest of definition 7 yet/);
  });

  it.each([
    ['data before the holdout', { data_start: '2024-12-31' }, /before the holdout/],
    ['too few trades', { trade_count: 29 }, /29 trades, fewer than 30/],
    ['zero expectancy', { avg_trade_pnl: 0 }, /expectancy/],
    ['missing expectancy', { avg_trade_pnl: null }, /expectancy/],
    ['deep drawdown', { max_drawdown: -20 }, /drawdown 20.0%/],
    ['another symbol', { symbol: 'GBPUSD' }, /GBPUSD/],
    ['another timeframe', { timeframe: '5min' }, /5min/],
    ['no recorded start', { data_start: null }, /did not record/],
  ])('refuses a backtest with %s', (_name, overrides, reason) => {
    const d = evaluatePromotion(DEF, 'paper', [backtest(overrides)], [], T, NOW);
    expect(d.allowed).toBe(false);
    expect(d.reasons.join(' ')).toMatch(reason);
  });

  it('lets any qualifying backtest count, and reports the newest failing one', () => {
    const old = backtest({ id: 1, created_at: '2026-01-01T00:00:00Z' });
    const bad = backtest({ id: 2, trade_count: 3, created_at: '2026-02-01T00:00:00Z' });
    expect(evaluatePromotion(DEF, 'paper', [old, bad], [], T, NOW).backtest_id).toBe(1);
    const d = evaluatePromotion(DEF, 'paper', [bad], [], T, NOW);
    expect(d.reasons[0]).toMatch(/#2/);
  });

  it('can be switched off for paper only', () => {
    const t = promotionThresholds({ PROMOTION_PAPER_GATE: 'off' });
    expect(evaluatePromotion(DEF, 'paper', [], [], t, NOW).allowed).toBe(true);
    expect(evaluatePromotion(DEF, 'live', [], [paper()], t, NOW).allowed).toBe(false);
  });
});

describe('live stage', () => {
  it('passes with a qualifying backtest and four weeks of paper', () => {
    const d = evaluatePromotion(DEF, 'live', [backtest()], [paper()], T, NOW);
    expect(d.allowed).toBe(true);
    expect(d.paper_run_id).toBe(3);
  });

  it('still needs the backtest', () => {
    const d = evaluatePromotion(DEF, 'live', [], [paper()], T, NOW);
    expect(d.allowed).toBe(false);
  });

  it('needs a paper run', () => {
    const d = evaluatePromotion(DEF, 'live', [backtest()], [], T, NOW);
    expect(d.reasons[0]).toMatch(/no paper run/);
  });

  it('needs 28 days of paper', () => {
    const d = evaluatePromotion(
      DEF,
      'live',
      [backtest()],
      [paper({ started_at: '2026-09-20T00:00:00Z' })],
      T,
      NOW
    );
    expect(d.allowed).toBe(false);
    expect(d.reasons[0]).toMatch(/22.0 days of paper, fewer than 28/);
  });

  it('counts a stopped run up to when it stopped', () => {
    const run = paper({ started_at: '2026-08-01T00:00:00Z', stopped_at: '2026-08-15T00:00:00Z' });
    expect(evaluatePromotion(DEF, 'live', [backtest()], [run], T, NOW).allowed).toBe(false);
  });

  it('refuses paper drawdown beyond 1.5x the backtest', () => {
    // Backtest 10% -> limit 15%; 1600 of 10k is 16%.
    const run = paper({ max_drawdown_amount: 1600 });
    const d = evaluatePromotion(DEF, 'live', [backtest()], [run], T, NOW);
    expect(d.allowed).toBe(false);
    expect(d.reasons[0]).toMatch(/16.0%, more than 1.5× the backtest's 10.0%/);
  });

  it('fails closed when the paper equity cannot be read', () => {
    const d = evaluatePromotion(DEF, 'live', [backtest()], [paper({ equity: null })], T, NOW);
    expect(d.allowed).toBe(false);
    expect(d.reasons[0]).toMatch(/equity could not be read/);
  });

  it('ignores errored runs', () => {
    const d = evaluatePromotion(DEF, 'live', [backtest()], [paper({ status: 'error' })], T, NOW);
    expect(d.allowed).toBe(false);
  });
});

describe('realisedDrawdown', () => {
  it('measures the fall from the realised peak', () => {
    const fills = [
      { symbol: 'X', side: 'BUY', quantity: 1, price: 100 },
      { symbol: 'X', side: 'SELL', quantity: 1, price: 150 }, // +50, peak 50
      { symbol: 'X', side: 'BUY', quantity: 1, price: 150 },
      { symbol: 'X', side: 'SELL', quantity: 1, price: 80 }, // -70 -> -20
      { symbol: 'X', side: 'BUY', quantity: 1, price: 80 },
      { symbol: 'X', side: 'SELL', quantity: 1, price: 90 }, // +10 -> -10
    ];
    expect(realisedDrawdown(fills)).toBe(70);
  });

  it('is zero without fills', () => {
    expect(realisedDrawdown([])).toBe(0);
  });
});

describe('isoDay', () => {
  it('reads a node-postgres DATE (local midnight) as the stored day', () => {
    expect(isoDay(new Date(2025, 0, 1))).toBe('2025-01-01');
    expect(isoDay('2025-01-01T23:00:00Z')).toBe('2025-01-01');
  });
});
