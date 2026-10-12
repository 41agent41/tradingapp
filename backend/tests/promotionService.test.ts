/**
 * Evidence gathering for the promotion gate, against a fake database.
 */
jest.mock('axios');

import { PromotionService, definitionLabel } from '../src/services/promotionService.js';

function fakeDb(handler: (text: string, params: unknown[]) => any[]) {
  const calls: { text: string; params: unknown[] }[] = [];
  return {
    calls,
    db: {
      query: async (text: string, params: unknown[] = []) => {
        calls.push({ text, params });
        return { rows: handler(text, params) };
      },
    },
  };
}

const BACKTEST_ROW = {
  id: 11,
  strategy: 'rules:def:7',
  symbol: 'EURUSD',
  timeframe: '1hour',
  trade_count: 40,
  created_at: new Date('2026-01-01T00:00:00Z'),
  data_start: '2025-01-02T00:00:00',
  max_drawdown: '-10.5',
  avg_trade_pnl: '3.2',
};

describe('PromotionService', () => {
  it('reads backtests by the label definition backtests are saved under', async () => {
    const { db, calls } = fakeDb(() => [BACKTEST_ROW]);
    const service = new PromotionService(db);
    const out = await service.backtests([7, 8]);
    expect(calls[0].params[0]).toEqual([definitionLabel(7), definitionLabel(8)]);
    expect(out.get(7)).toEqual([
      {
        id: 11,
        symbol: 'EURUSD',
        timeframe: '1hour',
        data_start: '2025-01-02T00:00:00',
        trade_count: 40,
        max_drawdown: -10.5,
        avg_trade_pnl: 3.2,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(out.get(8)).toBeUndefined();
  });

  it('builds paper evidence from the run, its fills and its account equity', async () => {
    const { db } = fakeDb((text) => {
      if (text.includes('FROM strategy_runs')) {
        return [
          {
            id: 3,
            broker: 'mt5',
            broker_account: 'demo',
            status: 'running',
            started_at: new Date('2026-09-01T00:00:00Z'),
            stopped_at: null,
          },
        ];
      }
      return [
        { symbol: 'X', side: 'BUY', quantity: 1, price: 100 },
        { symbol: 'X', side: 'SELL', quantity: 1, price: 60 },
      ];
    });
    const equity = jest.fn().mockResolvedValue(5000);
    const runs = await new PromotionService(db, equity).paperRuns(7);
    expect(equity).toHaveBeenCalledWith('mt5', 'demo');
    expect(runs).toEqual([
      {
        run_id: 3,
        connection: 'mt5:demo',
        status: 'running',
        started_at: '2026-09-01T00:00:00.000Z',
        stopped_at: null,
        trade_fills: 2,
        max_drawdown_amount: 40,
        equity: 5000,
      },
    ]);
  });

  it('only gathers paper runs for the live stage', async () => {
    const { db, calls } = fakeDb(() => []);
    const decision = await new PromotionService(db).check(
      { id: 7, symbol: 'EURUSD', timeframe: '1hour', holdout_start: '2025-01-01' },
      'paper'
    );
    expect(decision.allowed).toBe(false);
    expect(calls.some((c) => c.text.includes('strategy_runs'))).toBe(false);
  });
});
