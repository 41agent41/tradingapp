/**
 * resolveBroker — the market-data venue resolver (B1).
 */
import { resolveBroker } from '../src/routes/marketData/shared.js';

describe('resolveBroker', () => {
  it('defaults to ib', () => {
    expect(resolveBroker()).toBe('ib');
    expect(resolveBroker('')).toBe('ib');
    expect(resolveBroker(undefined)).toBe('ib');
  });

  it('accepts mt5 (case/space-insensitive)', () => {
    expect(resolveBroker('mt5')).toBe('mt5');
    expect(resolveBroker(' MT5 ')).toBe('mt5');
  });

  it('accepts alpaca and oanda (case/space-insensitive)', () => {
    expect(resolveBroker('alpaca')).toBe('alpaca');
    expect(resolveBroker(' Alpaca ')).toBe('alpaca');
    expect(resolveBroker('oanda')).toBe('oanda');
    expect(resolveBroker(' OANDA ')).toBe('oanda');
  });

  it('falls back to ib for anything else', () => {
    expect(resolveBroker('robinhood')).toBe('ib');
    expect(resolveBroker('IB')).toBe('ib');
  });
});
