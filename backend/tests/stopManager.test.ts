/**
 * Tests for bar-close stop management (Component E — E-3).
 *
 * The property under test is the ratchet: a stop may only ever tighten. With
 * the stop held at the broker there is no high-water mark in the app to check,
 * so the correctness of "never move backwards" rests entirely on this
 * comparison — which is why the cases below hammer it from both directions.
 */
import { applyTrail, decideTrail } from '../src/services/stopManager.js';

const connection = { broker: 'mt5', brokerAccount: 'icmarkets' };

describe('decideTrail — the ratchet', () => {
  it('tightens a long stop upward', () => {
    const d = decideTrail(99, 98, 1, 0, 105);
    expect(d).toEqual(expect.objectContaining({ move: true, stopPrice: 99 }));
  });

  it('refuses to loosen a long stop', () => {
    // The whole point. A 2-bar low that drops on a pullback must not drag the
    // stop down with it.
    const d = decideTrail(97, 98, 1, 0, 105);
    expect(d.move).toBe(false);
    expect(d.reason).toMatch(/not tighter/);
  });

  it('tightens a short stop downward', () => {
    const d = decideTrail(101, 102, -1, 0, 95);
    expect(d).toEqual(expect.objectContaining({ move: true, stopPrice: 101 }));
  });

  it('refuses to loosen a short stop', () => {
    const d = decideTrail(103, 102, -1, 0, 95);
    expect(d.move).toBe(false);
  });

  it('does not move a stop that is unchanged', () => {
    // An equal stop is not tighter; sending it would be a pointless modify on
    // every bar for the life of the position.
    expect(decideTrail(98, 98, 1, 0, 105).move).toBe(false);
  });

  it('sets a stop on a position that has none', () => {
    const d = decideTrail(99, null, 1, 0, 105);
    expect(d).toEqual(expect.objectContaining({ move: true, stopPrice: 99 }));
    expect(d.reason).toMatch(/no stop at the venue/);
  });
});

describe('decideTrail — refusals', () => {
  it('does nothing with no open position', () => {
    expect(decideTrail(99, 98, 0, 0, 105).move).toBe(false);
  });

  it('does nothing when no stop resolved for the bar', () => {
    expect(decideTrail(null, 98, 1, 0, 105).move).toBe(false);
  });

  it('refuses a long trail that has crossed above the market', () => {
    // `bar_extreme` on a sharp reversal can resolve past price; sending it
    // would close the position at market under the guise of protecting it.
    const d = decideTrail(106, 98, 1, 0, 105);
    expect(d.move).toBe(false);
    expect(d.reason).toMatch(/at or above price/);
  });

  it('refuses a short trail that has crossed below the market', () => {
    const d = decideTrail(94, 102, -1, 0, 95);
    expect(d.move).toBe(false);
    expect(d.reason).toMatch(/at or below price/);
  });

  it("refuses a trail inside the venue's minimum distance", () => {
    // The venue would reject the modify and leave the old stop in place, so
    // skipping reaches the same outcome with less noise.
    const d = decideTrail(104.999, 98, 1, 0.005, 105);
    expect(d.move).toBe(false);
    expect(d.reason).toMatch(/minimum distance/);
  });

  it('always explains itself', () => {
    // A trail that quietly does nothing is indistinguishable from a broken
    // one, and this runs on every bar of every open position.
    for (const d of [
      decideTrail(null, 98, 1),
      decideTrail(97, 98, 1, 0, 105),
      decideTrail(99, 98, 0),
    ]) {
      expect(d.reason).toBeTruthy();
    }
  });
});

describe('applyTrail', () => {
  const position = { symbol: 'EURUSD.a', size: 1, avgPrice: 1.1, stopLoss: 1.09 };

  it('sends the modify when the stop tightens', async () => {
    const modifyStop = jest.fn().mockResolvedValue(undefined);
    const result = await applyTrail(
      { modifyStop },
      { connection, position, desiredStop: 1.095, referencePrice: 1.12 }
    );

    expect(result.moved).toBe(true);
    expect(modifyStop).toHaveBeenCalledWith(connection, 'EURUSD.a', 1.095);
  });

  it('sends nothing when the stop would loosen', async () => {
    const modifyStop = jest.fn();
    const result = await applyTrail(
      { modifyStop },
      { connection, position, desiredStop: 1.08, referencePrice: 1.12 }
    );

    expect(result.moved).toBe(false);
    expect(modifyStop).not.toHaveBeenCalled();
  });

  it('survives a venue that refuses the modify', async () => {
    // The previous stop stays in place — degraded but still protected. Failing
    // the evaluation would stop the strategy managing what it still can.
    const modifyStop = jest.fn().mockRejectedValue(new Error('market closed'));
    const result = await applyTrail(
      { modifyStop },
      { connection, position, desiredStop: 1.095, referencePrice: 1.12 }
    );

    expect(result.moved).toBe(false);
    expect(result.error).toMatch(/market closed/);
  });
});
