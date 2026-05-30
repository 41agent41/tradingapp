/**
 * Tests for the pure validation in `orderTypes.ts`. This is the only
 * code in the orders flow that runs on every request, so it deserves
 * tight coverage.
 */
import { validateOrder, isLiveTradingEnabled } from '../src/services/orderTypes.js';

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
    expect(result.value.limit_price).toBeNull();
    expect(result.value.stop_price).toBeNull();
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
      symbol: 'MSFT', action: 'BUY', quantity: 1, order_type: 'MKT', tif: 'OPG',
    });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown account_mode', () => {
    const r = validateOrder({
      symbol: 'MSFT', action: 'BUY', quantity: 1, order_type: 'MKT', account_mode: 'demo',
    });
    expect(r.ok).toBe(false);
  });

  it('rejects non-positive quantity', () => {
    expect(
      validateOrder({ symbol: 'MSFT', action: 'BUY', quantity: 0, order_type: 'MKT' }).ok,
    ).toBe(false);
    expect(
      validateOrder({ symbol: 'MSFT', action: 'BUY', quantity: -1, order_type: 'MKT' }).ok,
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
      symbol: 'MSFT', action: 'BUY', quantity: 1, order_type: 'MKT', limit_price: 100,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.includes('limit_price'))).toBe(true);
  });

  it('rejects STP with extraneous limit_price', () => {
    const r = validateOrder({
      symbol: 'MSFT', action: 'BUY', quantity: 1, order_type: 'STP',
      stop_price: 100, limit_price: 99,
    });
    expect(r.ok).toBe(false);
  });
});

describe('validateOrder — fat-finger caps', () => {
  it('rejects quantity > ORDER_MAX_QUANTITY (default 100k)', () => {
    const r = validateOrder({ symbol: 'MSFT', action: 'BUY', quantity: 1_000_000, order_type: 'MKT' });
    expect(r.ok).toBe(false);
  });

  it('rejects limit_price > ORDER_MAX_PRICE (default 1M)', () => {
    const r = validateOrder({
      symbol: 'MSFT', action: 'BUY', quantity: 1, order_type: 'LMT', limit_price: 2_000_000,
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
