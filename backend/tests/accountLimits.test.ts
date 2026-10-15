/**
 * Account-level loss limits that include floating P&L.
 */
import {
  connectionLimitsFor,
  loadConnectionLimits,
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

describe("a connection's own limits (Settings > Connections)", () => {
  const conn = { broker: 'oanda', brokerAccount: 'practice' };
  const stored = {
    limits: { max_drawdown: 800, max_orders_per_day: 10 },
    prop_rules: { firm: 'FTMO 10k', initial_balance: 10_000, max_loss: { pct: 10 } },
  };

  it('win over the fleet-wide cap and lose to .env for this connection', () => {
    expect(
      connectionLimitsFor(
        conn,
        {
          CONNECTION_MAX_DRAWDOWN: '1000',
          CONNECTION_MAX_ORDERS_PER_DAY__OANDA_PRACTICE: '3',
          CONNECTION_MAX_DAILY_LOSS: '200',
        },
        stored
      )
    ).toMatchObject({
      max_drawdown: 800,
      max_orders_per_day: 3,
      max_daily_loss: 200,
      prop: expect.objectContaining({ firm: 'FTMO 10k' }),
    });
  });

  it('give way to PROP_RULES in .env', () => {
    const env = {
      PROP_RULES__OANDA_PRACTICE:
        '{"firm":"env firm","initial_balance":5000,"max_loss":{"pct":10}}',
    };
    expect(connectionLimitsFor(conn, env, stored)?.prop?.firm).toBe('env firm');
  });

  it('are read from the store, and a read failure throws so entries fail closed', async () => {
    const store = { limitsFor: jest.fn(async () => stored) };
    expect(await loadConnectionLimits(conn, store, {})).toMatchObject({ max_drawdown: 800 });
    expect(store.limitsFor).toHaveBeenCalledWith('oanda', 'practice');

    const broken = { limitsFor: jest.fn(async () => Promise.reject(new Error('db down'))) };
    await expect(loadConnectionLimits(conn, broken, {})).rejects.toThrow('db down');
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

describe('prop rules through the account limits', () => {
  const conn = { broker: 'mt5', brokerAccount: 'ftmo' };
  const rules = JSON.stringify({
    firm: 'FTMO 100k',
    initial_balance: 100_000,
    daily_loss: { pct: 5, basis: 'balance' },
    max_loss: { pct: 10, mode: 'static' },
  });

  it("reads a connection's prop rules, and only from its own variable", () => {
    const limits = connectionLimitsFor(conn, { PROP_RULES__MT5_FTMO: rules });
    expect(limits?.prop?.firm).toBe('FTMO 100k');
    expect(hasEquityLimits(limits)).toBe(true);
    expect(
      connectionLimitsFor(
        { broker: 'mt5', brokerAccount: 'other' },
        { PROP_RULES__MT5_FTMO: rules }
      )
    ).toBeNull();
  });

  it('throws, naming the variable, when the rules cannot be read', () => {
    expect(() => connectionLimitsFor(conn, { PROP_RULES__MT5_FTMO: '{"daily_loss":{}}' })).toThrow(
      /PROP_RULES__MT5_FTMO needs initial_balance/
    );
  });

  it('reports a prop rule inside its buffer as a breach', () => {
    const limits = connectionLimitsFor(conn, { PROP_RULES__MT5_FTMO: rules });
    const breaches = evaluateAccountLimits(
      {
        trading_day: '2026-10-13',
        day_start_equity: 100_000,
        high_water_mark: 100_000,
        equity: 95_800,
        balance: 100_000,
        day_start_balance: 100_000,
        balance_high_water_mark: 100_000,
      },
      limits
    );
    expect(breaches.map((b) => b.kind)).toEqual(['prop_daily_loss']);
    expect(breaches[0].detail).toMatch(/FTMO 100k daily loss/);
  });
});
