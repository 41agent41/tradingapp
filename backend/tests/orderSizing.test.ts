/**
 * orderSizing tests — the pure abstract-size → concrete-quantity resolver
 * used by the A3 execution engine.
 */
import { resolveOrderQuantity, roundToStep } from '../src/services/orderSizing.js';

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

  it('assumes whole shares when the venue supplies no spec', () => {
    // The safe fallback: whole shares is what every equity venue uses, and on
    // a lot-based venue a size still has to clear the minimum, so a wrong
    // guess errs toward refusing rather than toward an oversized order.
    expect(resolveOrderQuantity({ type: 'fixed', size: 1 }, { ...ib, broker: 'mt5' })).toEqual({
      ok: true,
      quantity: 1,
    });
    expect(resolveOrderQuantity({ type: 'fixed', size: 0.5 }, { ...ib, broker: 'mt5' }).ok).toBe(
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
    expect(resolveOrderQuantity({ type: 'fixed', unit: 'lots', size: 1 }, alpaca).ok).toBe(false);
    const r = resolveOrderQuantity({ type: 'fixed', unit: 'units', size: 1 }, alpaca);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/units/);
  });
});

describe('resolveOrderQuantity — broker-native units', () => {
  // A standard FX lot: 0.01 minimum and step, 100k units of base currency per
  // lot. That last factor is why lot sizing could never be approximated as
  // shares — getting it wrong is a five-order-of-magnitude error, not a
  // rounding one.
  const lotSpec = { unit: 'lots', minSize: 0.01, sizeStep: 0.01, contractSize: 100_000 };
  const mt5 = { price: 1.1, broker: 'mt5', equity: 10_000, spec: lotSpec };

  it('takes a fixed size as lots outright', () => {
    expect(resolveOrderQuantity({ type: 'fixed', unit: 'lots', size: 0.5 }, mt5)).toEqual({
      ok: true,
      quantity: 0.5,
    });
  });

  it('divides notional by price AND contract size', () => {
    // 110_000 / (1.1 x 100_000) = 1.0 lots. Without the contract size this
    // would resolve to 100_000 lots — ten billion units of exposure.
    expect(resolveOrderQuantity({ type: 'notional', size: 110_000 }, mt5)).toEqual({
      ok: true,
      quantity: 1,
    });
  });

  it('sizes pct_equity in lots', () => {
    // 10% of 10_000 = 1_000 / (1.1 x 100_000) = 0.00909 -> floors to 0.
    const r = resolveOrderQuantity({ type: 'pct_equity', size: 10 }, mt5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/minimum/);
    // 50% clears the 0.01 minimum.
    expect(resolveOrderQuantity({ type: 'pct_equity', size: 50 }, mt5)).toEqual({
      ok: true,
      quantity: 0.04,
    });
  });

  it('floors onto the venue step rather than rounding up', () => {
    // 0.079 lots must become 0.07, never 0.08 — rounding up would place a
    // larger order than the strategy asked for.
    const r = resolveOrderQuantity({ type: 'fixed', size: 0.079 }, mt5);
    expect(r).toEqual({ ok: true, quantity: 0.07 });
  });

  it('refuses a size below the venue minimum', () => {
    const r = resolveOrderQuantity({ type: 'fixed', size: 0.005 }, mt5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/minimum/);
  });

  it('clamps to the venue maximum when one is reported', () => {
    const capped = { ...mt5, spec: { ...lotSpec, maxSize: 2 } };
    expect(resolveOrderQuantity({ type: 'fixed', size: 50 }, capped)).toEqual({
      ok: true,
      quantity: 2,
    });
  });

  it('resolves OANDA units, where one unit IS one unit of base currency', () => {
    const oanda = {
      price: 1.1,
      broker: 'oanda',
      equity: 10_000,
      spec: { unit: 'units', minSize: 1, sizeStep: 1, contractSize: 1 },
    };
    // contract_size 1, so notional converts straight through price.
    expect(resolveOrderQuantity({ type: 'notional', size: 1100 }, oanda)).toEqual({
      ok: true,
      quantity: 1000,
    });
    expect(resolveOrderQuantity({ type: 'fixed', unit: 'units', size: 1500 }, oanda)).toEqual({
      ok: true,
      quantity: 1500,
    });
  });

  it("refuses a unit the venue doesn't trade in", () => {
    // The declared size means something other than what it says, and
    // converting it would be a guess.
    const r = resolveOrderQuantity({ type: 'fixed', unit: 'shares', size: 100 }, mt5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/lots/);
  });
});

describe('roundToStep', () => {
  it('floors onto the step', () => {
    expect(roundToStep(10.9, 1)).toBe(10);
    expect(roundToStep(0.079, 0.01)).toBe(0.07);
  });

  it('survives binary floating point at the step boundary', () => {
    // 0.07 / 0.01 is 6.999999999999999 in IEEE754 — a naive floor loses a
    // whole step.
    expect(roundToStep(0.07, 0.01)).toBe(0.07);
    expect(roundToStep(0.3, 0.1)).toBe(0.3);
  });

  it('passes the quantity through when the step is meaningless', () => {
    expect(roundToStep(1.234, 0)).toBe(1.234);
  });
});
