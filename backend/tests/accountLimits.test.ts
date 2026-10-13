/**
 * Account-level loss limits that include floating P&L.
 */
import {
  connectionLimitsFor,
  evaluateAccountLimits,
  hasEquityLimits,
  tradingDay,
  type EquityMarks,
} from '../src/services/accountLimits.js';

const marks = (overrides: Partial<EquityMarks> = {}): EquityMarks => ({
  trading_day: '2026-10-13',
  day_start_equity: 10_000,
  high_water_mark: 10_500,
  equity: 10_000,
  ...overrides,
});

describe('connectionLimitsFor', () => {
  const conn = { broker: 'mt5', brokerAccount: 'sim-a' };

  it('reads the fleet-wide equity caps', () => {
    expect(
      connectionLimitsFor(conn, {
        CONNECTION_MAX_DAILY_EQUITY_LOSS: '300',
        CONNECTION_MAX_DRAWDOWN: '1000',
      })
    ).toEqual({ max_daily_equity_loss: 300, max_drawdown: 1000 });
  });

  it('lets a per-connection value override the fleet-wide one', () => {
    expect(
      connectionLimitsFor(conn, {
        CONNECTION_MAX_DRAWDOWN: '1000',
        CONNECTION_MAX_DRAWDOWN__MT5_SIM_A: '400',
      })
    ).toEqual({ max_drawdown: 400 });
  });

  it('keeps the existing order and realised-loss caps', () => {
    expect(
      connectionLimitsFor(conn, {
        CONNECTION_MAX_ORDERS_PER_DAY: '5',
        CONNECTION_MAX_DAILY_LOSS__MT5_SIM_A: '200',
      })
    ).toEqual({ max_orders_per_day: 5, max_daily_loss: 200 });
  });

  it('ignores zero, negative and unparseable values', () => {
    expect(
      connectionLimitsFor(conn, {
        CONNECTION_MAX_DRAWDOWN: '0',
        CONNECTION_MAX_DAILY_EQUITY_LOSS: 'lots',
      })
    ).toBeNull();
  });
});

describe('evaluateAccountLimits', () => {
  it('flags equity at or past the daily loss from the start of the day', () => {
    const breaches = evaluateAccountLimits(marks({ equity: 9_700 }), {
      max_daily_equity_loss: 300,
    });
    expect(breaches.map((b) => b.kind)).toEqual(['daily_equity_loss']);
    expect(breaches[0].loss).toBe(300);
  });

  it('flags equity past the drawdown from the high-water mark', () => {
    // 10,500 peak to 9,400 is 1,100, past a 1,000 limit, though the day itself
    // is only down 600.
    const breaches = evaluateAccountLimits(marks({ equity: 9_400 }), {
      max_daily_equity_loss: 700,
      max_drawdown: 1_000,
    });
    expect(breaches.map((b) => b.kind)).toEqual(['drawdown']);
  });

  it('counts floating losses, which realised P&L would miss', () => {
    // Nothing has closed, so realised P&L is zero, but equity is down 350.
    expect(
      evaluateAccountLimits(marks({ equity: 9_650 }), { max_daily_equity_loss: 300 })
    ).toHaveLength(1);
  });

  it('passes inside the limits, and with none declared', () => {
    expect(
      evaluateAccountLimits(marks({ equity: 9_800 }), {
        max_daily_equity_loss: 300,
        max_drawdown: 1_000,
      })
    ).toEqual([]);
    expect(evaluateAccountLimits(marks({ equity: 1 }), null)).toEqual([]);
  });

  it('knows which limits are equity limits', () => {
    expect(hasEquityLimits({ max_daily_loss: 5 })).toBe(false);
    expect(hasEquityLimits({ max_drawdown: 5 })).toBe(true);
    expect(hasEquityLimits(null)).toBe(false);
  });
});

describe('tradingDay', () => {
  it('rolls the day at midnight in the configured zone, not UTC', () => {
    // 22:30 UTC is already the next day at a UTC+3 broker server.
    const at = new Date('2026-10-12T22:30:00Z');
    expect(tradingDay(at, 'UTC')).toBe('2026-10-12');
    expect(tradingDay(at, 'Europe/Athens')).toBe('2026-10-13');
  });
});
