/**
 * Prop-firm loss rules (R-P1), computed the firm's way.
 */
import {
  evaluatePropRules,
  inWeekendWindow,
  minuteOfWeek,
  parsePropRules,
  propScheduleRefusal,
  weekMinute,
  type PropMarks,
} from '../src/services/propRules.js';

const FTMO = JSON.stringify({
  firm: 'FTMO 100k',
  initial_balance: 100_000,
  daily_loss: { pct: 5, basis: 'balance' },
  max_loss: { pct: 10, mode: 'static' },
  buffer_pct: 20,
});

function marks(overrides: Partial<PropMarks> = {}): PropMarks {
  return {
    equity: 100_000,
    balance: 100_000,
    day_start_equity: 100_000,
    day_start_balance: 100_000,
    equity_high_water_mark: 100_000,
    balance_high_water_mark: 100_000,
    ...overrides,
  };
}

const byKind = (states: ReturnType<typeof evaluatePropRules>) =>
  Object.fromEntries(states.map((s) => [s.kind, s]));

describe('parsePropRules', () => {
  it('reads a static FTMO-style account', () => {
    expect(parsePropRules(FTMO)).toEqual({
      firm: 'FTMO 100k',
      initial_balance: 100_000,
      daily_loss: { pct: 5, basis: 'balance' },
      max_loss: { pct: 10, mode: 'static', lock_at_initial: true },
      buffer_pct: 20,
    });
  });

  it('defaults the buffer to 20% and the daily basis to balance', () => {
    const rules = parsePropRules(
      JSON.stringify({ initial_balance: 50_000, daily_loss: { amount: 2_500 } })
    );
    expect(rules.buffer_pct).toBe(20);
    expect(rules.daily_loss).toEqual({ amount: 2_500, basis: 'balance' });
  });

  it.each([
    ['not json', /valid JSON/],
    [JSON.stringify({ daily_loss: { pct: 5 } }), /initial_balance/],
    [JSON.stringify({ initial_balance: 1000 }), /daily_loss, max_loss or both/],
    [JSON.stringify({ initial_balance: 1000, daily_loss: { pct: 5, amount: 50 } }), /exactly one/],
    [JSON.stringify({ initial_balance: 1000, max_loss: { pct: 10, mode: 'sideways' } }), /mode/],
    [JSON.stringify({ initial_balance: 1000, daily_loss: { pct: 5 }, buffer_pct: 100 }), /buffer/],
  ])('refuses %s', (raw, message) => {
    expect(() => parsePropRules(raw)).toThrow(message);
  });
});

describe('evaluatePropRules', () => {
  const ftmo = parsePropRules(FTMO);

  it("measures the daily floor from the day's starting balance", () => {
    // Day started at 102,000 balance: floor is 102,000 - 5,000 = 97,000.
    const daily = byKind(
      evaluatePropRules(marks({ day_start_balance: 102_000, equity: 98_500 }), ftmo)
    ).prop_daily_loss;
    expect(daily.floor).toBe(97_000);
    expect(daily.room).toBe(1_500);
    expect(daily.stop_at).toBe(1_000);
    expect(daily.stopped).toBe(false);
  });

  it('stops entries short of the limit, inside the buffer', () => {
    // 800 of room is inside the 1,000 buffer (20% of 5,000), though the
    // firm's limit itself is not yet broken.
    const daily = byKind(evaluatePropRules(marks({ equity: 95_800 }), ftmo)).prop_daily_loss;
    expect(daily.room).toBe(800);
    expect(daily.stopped).toBe(true);
  });

  it('uses the higher of balance and equity when the firm does', () => {
    const rules = parsePropRules(
      JSON.stringify({ initial_balance: 100_000, daily_loss: { pct: 5, basis: 'higher' } })
    );
    // Day started with 3,000 floating profit: equity 103,000 sets the floor.
    const daily = evaluatePropRules(
      marks({ day_start_balance: 100_000, day_start_equity: 103_000, equity: 99_000 }),
      rules
    )[0];
    expect(daily.floor).toBe(98_000);
    expect(daily.room).toBe(1_000);
    expect(daily.stopped).toBe(true);
  });

  it('keeps a static max-loss floor at the initial balance less the allowance', () => {
    const max = byKind(
      evaluatePropRules(marks({ equity: 104_000, equity_high_water_mark: 110_000 }), ftmo)
    ).prop_max_loss;
    expect(max.floor).toBe(90_000);
  });

  it('trails the max-loss floor up with the highest equity, then locks it', () => {
    const rules = parsePropRules(
      JSON.stringify({
        initial_balance: 100_000,
        max_loss: { amount: 6_000, mode: 'trailing_equity' },
      })
    );
    const trailing = evaluatePropRules(marks({ equity_high_water_mark: 103_000 }), rules)[0];
    expect(trailing.floor).toBe(97_000);
    // Past the initial balance plus the allowance, the floor stops at the
    // initial balance.
    const locked = evaluatePropRules(
      marks({ equity: 108_000, equity_high_water_mark: 110_000 }),
      rules
    )[0];
    expect(locked.floor).toBe(100_000);
  });

  it('trails from the balance peak when the firm uses balance', () => {
    const rules = parsePropRules(
      JSON.stringify({
        initial_balance: 100_000,
        max_loss: { amount: 4_000, mode: 'trailing_balance', lock_at_initial: false },
      })
    );
    const state = evaluatePropRules(
      marks({ balance_high_water_mark: 106_000, equity_high_water_mark: 108_000 }),
      rules
    )[0];
    expect(state.floor).toBe(102_000);
  });

  it('stops entries when a balance-based rule has no balance to read', () => {
    const daily = byKind(
      evaluatePropRules(marks({ balance: null, day_start_balance: null }), ftmo)
    ).prop_daily_loss;
    expect(daily.stopped).toBe(true);
    expect(daily.detail).toMatch(/no balance/);
  });
});

describe('prop schedule rules (R-P2)', () => {
  const base = {
    firm: 'FTMO 100k',
    initial_balance: 100_000,
    daily_loss: { pct: 5 },
  };
  const parse = (extra: object) => parsePropRules(JSON.stringify({ ...base, ...extra }));

  it('reads a news blackout, defaulting to 2 minutes either side of high impact', () => {
    expect(parse({ news_blackout: {} }).news_blackout).toEqual({
      minutes_before: 2,
      minutes_after: 2,
      impact: ['High'],
    });
    expect(() => parse({ news_blackout: { minutes_before: -1 } })).toThrow('news_blackout');
    expect(() => parse({ news_blackout: { impact: 'High' } })).toThrow('news_blackout.impact');
  });

  it('reads a weekend window, resuming Monday by default', () => {
    expect(parse({ weekend: { no_entries_after: 'fri 20:00' } }).weekend).toEqual({
      no_entries_after: 'fri 20:00',
      resume: 'mon 00:00',
      from_minute: 4 * 1440 + 20 * 60,
      until_minute: 0,
    });
    expect(() => parse({ weekend: { no_entries_after: 'friday' } })).toThrow('weekend');
    expect(() => parse({ weekend: { no_entries_after: 'fri 25:00' } })).toThrow('weekend');
  });

  it('reads a minimum number of trading days', () => {
    expect(
      parse({ min_trading_days: { days: 4, start_date: '2026-10-01' } }).min_trading_days
    ).toEqual({ days: 4, start_date: '2026-10-01' });
    expect(() => parse({ min_trading_days: { days: 0, start_date: '2026-10-01' } })).toThrow(
      'min_trading_days.days'
    );
    expect(() => parse({ min_trading_days: { days: 4, start_date: 'Oct 1' } })).toThrow(
      'start_date'
    );
  });

  it('reads the week in the trading timezone', () => {
    expect(weekMinute('Mon 00:00')).toBe(0);
    expect(weekMinute('sun 23:59')).toBe(6 * 1440 + 23 * 60 + 59);
    // Friday 21:30 UTC is Saturday 00:30 on a UTC+3 server.
    const at = new Date('2026-10-16T21:30:00Z');
    expect(minuteOfWeek(at, 'UTC')).toBe(4 * 1440 + 21 * 60 + 30);
    expect(minuteOfWeek(at, 'Europe/Athens')).toBe(5 * 1440 + 30);
  });

  it('places entries outside the weekend window and refuses them inside it', () => {
    const rules = parse({ weekend: { no_entries_after: 'fri 20:00', resume: 'sun 22:00' } });
    const refusal = (iso: string) =>
      propScheduleRefusal({
        rules,
        now: new Date(iso),
        timeZone: 'UTC',
        currencies: ['EUR', 'USD'],
        calendar: null,
      });
    expect(refusal('2026-10-16T19:59:00Z')).toBeNull();
    expect(refusal('2026-10-16T20:00:00Z')).toMatch(/weekend rule/);
    expect(refusal('2026-10-17T12:00:00Z')).toMatch(/weekend rule/);
    expect(refusal('2026-10-18T22:00:00Z')).toBeNull();
    expect(inWeekendWindow(new Date('2026-10-14T12:00:00Z'), rules.weekend!, 'UTC')).toBe(false);
  });

  it('refuses entries near news, and when the calendar cannot be trusted', () => {
    const rules = parse({ news_blackout: { minutes_before: 5, minutes_after: 5 } });
    const event = {
      at: new Date('2026-10-02T12:30:00Z'),
      currency: 'USD',
      impact: 'High',
      title: 'Non-Farm Employment Change',
    };
    const fresh = { events: [event], stale: false, fetchedAt: new Date(), error: null };
    const check = (iso: string, calendar: any, currencies = ['EUR', 'USD']) =>
      propScheduleRefusal({ rules, now: new Date(iso), timeZone: 'UTC', currencies, calendar });

    expect(check('2026-10-02T12:26:00Z', fresh)).toMatch(/news blackout: USD Non-Farm/);
    expect(check('2026-10-02T12:36:00Z', fresh)).toBeNull();
    expect(check('2026-10-02T12:30:00Z', fresh, ['GBP', 'JPY'])).toBeNull();
    expect(check('2026-10-02T09:00:00Z', { ...fresh, stale: true, error: 'blocked' })).toMatch(
      /calendar is out of date \(blocked\)/
    );
    expect(check('2026-10-02T09:00:00Z', null)).toMatch(/calendar is unavailable/);
    expect(check('2026-10-02T09:00:00Z', fresh, [])).toMatch(/currencies are unknown/);
  });
});
