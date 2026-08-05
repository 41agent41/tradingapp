/**
 * orderSizing tests — the pure abstract-size → concrete-quantity resolver
 * used by the A3 execution engine.
 */
import { resolveOrderQuantity } from '../src/services/orderSizing.js';

const ib = { price: 100, broker: 'ib', equity: null as number | null };

describe('resolveOrderQuantity — fixed', () => {
  it('returns the size as an integer share count', () => {
    expect(resolveOrderQuantity({ type: 'fixed', size: 100 }, ib)).toEqual({
      ok: true,
      quantity: 100,
    });
  });

  it('floors a fractional size', () => {
    expect(resolveOrderQuantity({ type: 'fixed', size: 10.9 }, ib)).toEqual({
      ok: true,
      quantity: 10,
    });
  });

  it('defaults type to fixed', () => {
    expect(resolveOrderQuantity({ size: 5 }, ib)).toEqual({ ok: true, quantity: 5 });
  });

  it('rejects a size below the 1-unit minimum', () => {
    const r = resolveOrderQuantity({ type: 'fixed', size: 0.4 }, ib);
    expect(r.ok).toBe(false);
  });
});

describe('resolveOrderQuantity — notional', () => {
  it('divides notional by price and floors', () => {
    // 1000 / 100 = 10 shares
    expect(resolveOrderQuantity({ type: 'notional', size: 1000 }, ib)).toEqual({
      ok: true,
      quantity: 10,
    });
    // 1050 / 100 = 10.5 -> 10
    expect(resolveOrderQuantity({ type: 'notional', size: 1050 }, ib)).toEqual({
      ok: true,
      quantity: 10,
    });
  });

  it('rejects when the price is not positive', () => {
    const r = resolveOrderQuantity({ type: 'notional', size: 1000 }, { ...ib, price: 0 });
    expect(r.ok).toBe(false);
  });

  it('rejects when the notional is below one share', () => {
    const r = resolveOrderQuantity({ type: 'notional', size: 50 }, ib); // 50/100 = 0.5
    expect(r.ok).toBe(false);
  });
});

describe('resolveOrderQuantity — pct_equity', () => {
  it('sizes from equity when it is known', () => {
    // 10% of 100_000 = 10_000; / 100 = 100 shares
    expect(
      resolveOrderQuantity({ type: 'pct_equity', size: 10 }, { ...ib, equity: 100_000 })
    ).toEqual({ ok: true, quantity: 100 });
  });

  it('rejects (fail closed) when equity is unknown', () => {
    const r = resolveOrderQuantity({ type: 'pct_equity', size: 10 }, ib);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/equity/);
  });
});

describe('resolveOrderQuantity — guards', () => {
  it('rejects a non-positive size', () => {
    expect(resolveOrderQuantity({ type: 'fixed', size: 0 }, ib).ok).toBe(false);
    expect(resolveOrderQuantity({ type: 'fixed', size: -5 }, ib).ok).toBe(false);
  });

  it("rejects 'lots' as MT5-only on an IB run", () => {
    const r = resolveOrderQuantity({ type: 'fixed', unit: 'lots', size: 1 }, ib);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/lots/);
  });

  it('rejects a non-share-sized broker (mt5, oanda)', () => {
    expect(resolveOrderQuantity({ type: 'fixed', size: 1 }, { ...ib, broker: 'mt5' }).ok).toBe(
      false
    );
    expect(resolveOrderQuantity({ type: 'fixed', size: 1 }, { ...ib, broker: 'oanda' }).ok).toBe(
      false
    );
  });

  it('rejects an unknown sizing type', () => {
    const r = resolveOrderQuantity({ type: 'martingale', size: 1 }, ib);
    expect(r.ok).toBe(false);
  });
});

describe('resolveOrderQuantity — alpaca (share-sized like IB)', () => {
  const alpaca = { price: 100, broker: 'alpaca', equity: null as number | null };

  it('resolves fixed/notional/pct_equity the same way as IB', () => {
    expect(resolveOrderQuantity({ type: 'fixed', size: 100 }, alpaca)).toEqual({
      ok: true,
      quantity: 100,
    });
    expect(resolveOrderQuantity({ type: 'notional', size: 1000 }, alpaca)).toEqual({
      ok: true,
      quantity: 10,
    });
  });

  it("still rejects 'lots' and 'units' units on an alpaca run", () => {
    expect(
      resolveOrderQuantity({ type: 'fixed', unit: 'lots', size: 1 }, alpaca).ok
    ).toBe(false);
    const r = resolveOrderQuantity({ type: 'fixed', unit: 'units', size: 1 }, alpaca);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/units/);
  });
});
