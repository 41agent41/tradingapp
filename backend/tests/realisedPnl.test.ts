/**
 * Realised P&L / net position reducer tests.
 *
 * This is the arithmetic that replaces the platform's submitted-order estimate
 * of a position with the fills the venue actually reported, so the cases that
 * matter are the ones the old estimate got wrong: partial fills, reversals
 * through flat, and commissions.
 */
import { realisedPnl, netPositions, type Fill } from '../src/services/realisedPnl.js';

function fill(
  side: 'BUY' | 'SELL',
  quantity: number,
  price: number,
  commission = 0,
  symbol = 'MSFT'
): Fill {
  return { symbol, side, quantity, price, commission };
}

describe('realisedPnl — average-cost basis', () => {
  it('realises nothing on an opening fill', () => {
    expect(realisedPnl([fill('BUY', 100, 50)]).realised).toBe(0);
  });

  it('realises the round trip on a full close', () => {
    const result = realisedPnl([fill('BUY', 100, 50), fill('SELL', 100, 55)]);
    expect(result.realised).toBe(500);
  });

  it('realises only the closed portion of a partial exit', () => {
    // The exact case the submitted-order estimate could not see.
    const result = realisedPnl([fill('BUY', 100, 50), fill('SELL', 40, 55)]);
    expect(result.realised).toBe(200);
    expect(netPositions([fill('BUY', 100, 50), fill('SELL', 40, 55)]).MSFT).toBe(60);
  });

  it('averages the cost across adds rather than matching lots', () => {
    // 100 @ 50 + 100 @ 60 -> avg 55; selling 200 @ 60 realises 200 x 5.
    const result = realisedPnl([fill('BUY', 100, 50), fill('BUY', 100, 60), fill('SELL', 200, 60)]);
    expect(result.realised).toBe(1000);
  });

  it('handles a short: profit when the buy-back is cheaper', () => {
    const result = realisedPnl([fill('SELL', 100, 50), fill('BUY', 100, 45)]);
    expect(result.realised).toBe(500);
  });

  it('reverses through flat without realising P&L on shares never held', () => {
    // Long 100 @ 50, then sell 150 @ 60: closes 100 (+1000) and opens a short
    // 50 at 60. Treating it as "close 150" would invent 500 of profit.
    const fills = [fill('BUY', 100, 50), fill('SELL', 150, 60), fill('BUY', 50, 55)];
    const result = realisedPnl(fills);
    expect(result.realised).toBe(1000 + 250);
    expect(netPositions(fills).MSFT).toBe(0);
  });
});

describe('realisedPnl — commissions', () => {
  it('subtracts commission on entries as well as exits', () => {
    const result = realisedPnl([fill('BUY', 100, 50, 1), fill('SELL', 100, 55, 1)]);
    expect(result.realised).toBe(498);
    expect(result.commission).toBe(2);
  });

  it('treats a commission reported as negative as a cost either way', () => {
    // MT5 reports commission as a negative number; IB as a positive one.
    const result = realisedPnl([fill('BUY', 100, 50, -1), fill('SELL', 100, 55, -1)]);
    expect(result.realised).toBe(498);
  });

  it('an unreported commission is zero, not NaN', () => {
    const result = realisedPnl([
      { symbol: 'MSFT', side: 'BUY', quantity: 100, price: 50, commission: null },
      { symbol: 'MSFT', side: 'SELL', quantity: 100, price: 55 },
    ]);
    expect(result.realised).toBe(500);
  });
});

describe('realisedPnl — multiple symbols', () => {
  it('keeps positions and P&L separate per symbol', () => {
    const fills = [
      fill('BUY', 100, 50, 0, 'MSFT'),
      fill('BUY', 10, 200, 0, 'AAPL'),
      fill('SELL', 100, 55, 0, 'MSFT'),
      fill('SELL', 10, 190, 0, 'AAPL'),
    ];
    const result = realisedPnl(fills);
    expect(result.bySymbol.MSFT).toBe(500);
    expect(result.bySymbol.AAPL).toBe(-100);
    expect(result.realised).toBe(400);
  });

  it('normalises symbol case so one instrument is one position', () => {
    const fills = [fill('BUY', 100, 50, 0, 'msft'), fill('SELL', 100, 55, 0, 'MSFT')];
    expect(realisedPnl(fills).realised).toBe(500);
    expect(netPositions(fills).MSFT).toBe(0);
  });
});

describe('realisedPnl — degenerate input', () => {
  it('an empty list is flat and zero', () => {
    expect(realisedPnl([])).toEqual({ realised: 0, commission: 0, bySymbol: {} });
    expect(netPositions([])).toEqual({});
  });

  it('accepts numeric strings (what pg returns for NUMERIC columns)', () => {
    const result = realisedPnl([
      { symbol: 'MSFT', side: 'BUY', quantity: '100', price: '50.00', commission: '1.00' },
      { symbol: 'MSFT', side: 'SELL', quantity: '100', price: '55.00', commission: '1.00' },
    ]);
    expect(result.realised).toBe(498);
  });

  it('a zero-quantity fill moves nothing but still costs its commission', () => {
    const result = realisedPnl([fill('BUY', 0, 50, 1)]);
    expect(result.realised).toBe(-1);
    expect(netPositions([fill('BUY', 0, 50, 1)]).MSFT).toBe(0);
  });
});
