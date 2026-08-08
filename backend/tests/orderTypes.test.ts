/**
 * Tests for the pure validation in `orderTypes.ts`. This is the only
 * code in the orders flow that runs on every request, so it deserves
 * tight coverage.
 */
import {
  validateOrder,
  isLiveTradingEnabled,
  checkPositionLimit,
  positionCap,
  isPositionLimitEnabled,
  connectionLabel,
  connectionOf,
} from '../src/services/orderTypes.js';

/** A minimal valid order the connection-identity cases vary one field of. */
const base = { symbol: 'MSFT', action: 'BUY', quantity: 10, order_type: 'MKT' };

describe('validateOrder — happy paths', () => {
  it('accepts a minimal MKT order with the default tif / account_mode', () => {
    const result = validateOrder({
      symbol: 'msft',
      action: 'BUY',
      quantity: 10,
      order_type: 'MKT',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.symbol).toBe('MSFT'); // uppercased
    expect(result.value.tif).toBe('DAY');
    expect(result.value.account_mode).toBe('paper');
    expect(result.value.broker).toBe('ib'); // default venue (B1)
    expect(result.value.limit_price).toBeNull();
    expect(result.value.stop_price).toBeNull();
  });

  it('accepts an explicit broker and rejects an unknown one (B1)', () => {
    const ok = validateOrder({
      symbol: 'EURUSD',
      action: 'BUY',
      quantity: 1,
      order_type: 'MKT',
      broker: 'mt5',
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.broker).toBe('mt5');

    const bad = validateOrder({
      symbol: 'MSFT',
      action: 'BUY',
      quantity: 1,
      order_type: 'MKT',
      broker: 'robinhood',
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.some((e) => /broker/.test(e))).toBe(true);
  });

  it('accepts alpaca and oanda as brokers', () => {
    const alpaca = validateOrder({
      symbol: 'AAPL',
      action: 'BUY',
      quantity: 1,
      order_type: 'MKT',
      broker: 'alpaca',
    });
    expect(alpaca.ok).toBe(true);
    if (alpaca.ok) expect(alpaca.value.broker).toBe('alpaca');

    const oanda = validateOrder({
      symbol: 'EUR.USD',
      action: 'BUY',
      quantity: 1000,
      order_type: 'MKT',
      broker: 'oanda',
    });
    expect(oanda.ok).toBe(true);
    if (oanda.ok) expect(oanda.value.broker).toBe('oanda');
  });

  it('accepts a LMT order with a positive limit_price', () => {
    const result = validateOrder({
      symbol: 'AAPL',
      action: 'SELL',
      quantity: 1,
      order_type: 'LMT',
      limit_price: 200.5,
      tif: 'GTC',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.limit_price).toBe(200.5);
  });

  it('accepts a STP_LMT order with both prices', () => {
    const result = validateOrder({
      symbol: 'AAPL',
      action: 'BUY',
      quantity: 1,
      order_type: 'STP_LMT',
      limit_price: 200,
      stop_price: 199,
    });
    expect(result.ok).toBe(true);
  });
});

describe('validateOrder — required fields', () => {
  it('rejects missing symbol', () => {
    const r = validateOrder({ action: 'BUY', quantity: 1, order_type: 'MKT' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.includes('symbol'))).toBe(true);
  });

  it('rejects unknown action', () => {
    const r = validateOrder({ symbol: 'MSFT', action: 'HOLD', quantity: 1, order_type: 'MKT' });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown order_type', () => {
    const r = validateOrder({ symbol: 'MSFT', action: 'BUY', quantity: 1, order_type: 'ICEBERG' });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown tif', () => {
    const r = validateOrder({
      symbol: 'MSFT',
      action: 'BUY',
      quantity: 1,
      order_type: 'MKT',
      tif: 'OPG',
    });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown account_mode', () => {
    const r = validateOrder({
      symbol: 'MSFT',
      action: 'BUY',
      quantity: 1,
      order_type: 'MKT',
      account_mode: 'demo',
    });
    expect(r.ok).toBe(false);
  });

  it('rejects non-positive quantity', () => {
    expect(
      validateOrder({ symbol: 'MSFT', action: 'BUY', quantity: 0, order_type: 'MKT' }).ok
    ).toBe(false);
    expect(
      validateOrder({ symbol: 'MSFT', action: 'BUY', quantity: -1, order_type: 'MKT' }).ok
    ).toBe(false);
  });
});

describe('validateOrder — price field cross-checks', () => {
  it('rejects LMT missing limit_price', () => {
    const r = validateOrder({ symbol: 'MSFT', action: 'BUY', quantity: 1, order_type: 'LMT' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.includes('limit_price'))).toBe(true);
  });

  it('rejects STP missing stop_price', () => {
    const r = validateOrder({ symbol: 'MSFT', action: 'BUY', quantity: 1, order_type: 'STP' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.includes('stop_price'))).toBe(true);
  });

  it('rejects MKT with extraneous limit_price', () => {
    const r = validateOrder({
      symbol: 'MSFT',
      action: 'BUY',
      quantity: 1,
      order_type: 'MKT',
      limit_price: 100,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.includes('limit_price'))).toBe(true);
  });

  it('rejects STP with extraneous limit_price', () => {
    const r = validateOrder({
      symbol: 'MSFT',
      action: 'BUY',
      quantity: 1,
      order_type: 'STP',
      stop_price: 100,
      limit_price: 99,
    });
    expect(r.ok).toBe(false);
  });
});

describe('validateOrder — fat-finger caps', () => {
  it('rejects quantity > ORDER_MAX_QUANTITY (default 100k)', () => {
    const r = validateOrder({
      symbol: 'MSFT',
      action: 'BUY',
      quantity: 1_000_000,
      order_type: 'MKT',
    });
    expect(r.ok).toBe(false);
  });

  it('rejects limit_price > ORDER_MAX_PRICE (default 1M)', () => {
    const r = validateOrder({
      symbol: 'MSFT',
      action: 'BUY',
      quantity: 1,
      order_type: 'LMT',
      limit_price: 2_000_000,
    });
    expect(r.ok).toBe(false);
  });
});

describe('isLiveTradingEnabled', () => {
  const orig = process.env.LIVE_TRADING_ENABLED;
  afterEach(() => {
    if (orig === undefined) delete process.env.LIVE_TRADING_ENABLED;
    else process.env.LIVE_TRADING_ENABLED = orig;
  });

  it('defaults to false when the env var is unset', () => {
    delete process.env.LIVE_TRADING_ENABLED;
    expect(isLiveTradingEnabled()).toBe(false);
  });
  it('is true only for the exact case-insensitive string "true"', () => {
    process.env.LIVE_TRADING_ENABLED = 'true';
    expect(isLiveTradingEnabled()).toBe(true);
    process.env.LIVE_TRADING_ENABLED = 'TRUE';
    expect(isLiveTradingEnabled()).toBe(true);
    process.env.LIVE_TRADING_ENABLED = '1';
    expect(isLiveTradingEnabled()).toBe(false);
    process.env.LIVE_TRADING_ENABLED = 'yes';
    expect(isLiveTradingEnabled()).toBe(false);
  });
});

describe('checkPositionLimit', () => {
  it('is always ok when the cap is disabled (<= 0)', () => {
    expect(checkPositionLimit(999, 'BUY', 999, 0).ok).toBe(true);
    expect(checkPositionLimit(999, 'BUY', 999, -5).ok).toBe(true);
  });

  it('adds quantity for BUY and subtracts for SELL', () => {
    expect(checkPositionLimit(100, 'BUY', 50, 1000).projected).toBe(150);
    expect(checkPositionLimit(100, 'SELL', 50, 1000).projected).toBe(50);
  });

  it('rejects when the projected absolute net exceeds the cap', () => {
    const d = checkPositionLimit(900, 'BUY', 200, 1000);
    expect(d.ok).toBe(false);
    expect(d.projected).toBe(1100);
    expect(d.detail).toMatch(/cap ±1000/);
  });

  it('allows reducing an over-cap position via the opposite side', () => {
    // Already long 1500 (e.g. cap lowered later); a SELL that shrinks the
    // net to 1100 is still over-cap and rejected...
    expect(checkPositionLimit(1500, 'SELL', 400, 1000).ok).toBe(false);
    // ...but a SELL that brings it within the cap is allowed.
    expect(checkPositionLimit(1500, 'SELL', 600, 1000).ok).toBe(true);
  });

  it('treats the cap symmetrically for short positions', () => {
    expect(checkPositionLimit(-900, 'SELL', 200, 1000).ok).toBe(false);
    expect(checkPositionLimit(-900, 'SELL', 50, 1000).ok).toBe(true);
  });

  it('allows reaching exactly the cap', () => {
    expect(checkPositionLimit(0, 'BUY', 1000, 1000).ok).toBe(true);
    expect(checkPositionLimit(0, 'BUY', 1001, 1000).ok).toBe(false);
  });
});

describe('positionCap / isPositionLimitEnabled', () => {
  const orig = process.env.ORDER_MAX_POSITION;
  afterEach(() => {
    if (orig === undefined) delete process.env.ORDER_MAX_POSITION;
    else process.env.ORDER_MAX_POSITION = orig;
  });

  it('defaults to 0 (disabled) when unset', () => {
    delete process.env.ORDER_MAX_POSITION;
    expect(positionCap()).toBe(0);
    expect(isPositionLimitEnabled()).toBe(false);
  });

  it('reads a positive cap from the environment', () => {
    process.env.ORDER_MAX_POSITION = '500';
    expect(positionCap()).toBe(500);
    expect(isPositionLimitEnabled()).toBe(true);
  });

  it('clamps a negative or non-numeric value to 0', () => {
    process.env.ORDER_MAX_POSITION = '-10';
    expect(positionCap()).toBe(0);
    process.env.ORDER_MAX_POSITION = 'abc';
    expect(positionCap()).toBe(0);
  });
});

describe('broker_account (connection identity — C-0)', () => {
  it('defaults to "default" when absent, empty or null', () => {
    for (const value of [undefined, null, '', '   ']) {
      const v = validateOrder({ ...base, broker_account: value });
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.value.broker_account).toBe('default');
    }
  });

  it('lowercases and trims so a connection has one canonical spelling', () => {
    const v = validateOrder({ ...base, broker_account: '  Pepperstone-Live  ' });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.broker_account).toBe('pepperstone-live');
  });

  it('accepts the identifier charset', () => {
    for (const account of ['ib1', 'mt5_demo', 'ftmo-challenge-2']) {
      const v = validateOrder({ ...base, broker_account: account });
      expect(v.ok).toBe(true);
    }
  });

  it('rejects values that would be unsafe in a label, key or URL', () => {
    for (const account of ['-leading-dash', 'has space', 'has/slash', 'has:colon', 'é']) {
      const v = validateOrder({ ...base, broker_account: account });
      expect(v.ok).toBe(false);
    }
  });

  it('rejects an over-long account', () => {
    const v = validateOrder({ ...base, broker_account: 'a'.repeat(65) });
    expect(v.ok).toBe(false);
  });

  it('rejects a non-string account rather than coercing it', () => {
    const v = validateOrder({ ...base, broker_account: 42 });
    expect(v.ok).toBe(false);
  });

  // The platform enum stays closed while the account stays free-form: adding
  // an account is configuration, adding a platform is a code change.
  it('does not accept a platform:account string in the broker field', () => {
    const v = validateOrder({ ...base, broker: 'mt5:pepperstone-live' });
    expect(v.ok).toBe(false);
  });
});

describe('connectionLabel / connectionOf', () => {
  it('labels a connection as platform:account', () => {
    expect(connectionLabel('mt5', 'pepperstone-live')).toBe('mt5:pepperstone-live');
  });

  it('maps a persisted row onto a connection, defaulting both halves', () => {
    expect(connectionOf({ broker: 'mt5', broker_account: 'demo' })).toEqual({
      broker: 'mt5',
      brokerAccount: 'demo',
    });
    // A row written before C-0 has no account; it belongs to the default one.
    expect(connectionOf({ broker: 'mt5' })).toEqual({
      broker: 'mt5',
      brokerAccount: 'default',
    });
  });
});
