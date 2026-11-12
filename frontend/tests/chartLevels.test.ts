/**
 * The price lines a chart draws for what the trader holds in its instrument.
 */
import { describe, expect, it } from 'vitest';

import { priceLevels, sameInstrument } from '../app/lib/chartLevels';

describe('sameInstrument', () => {
  it('ignores case and separators', () => {
    expect(sameInstrument('EUR.USD', 'eur_usd')).toBe(true);
    expect(sameInstrument('EUR/USD', 'EURUSD')).toBe(true);
    expect(sameInstrument('EURUSD', 'EURGBP')).toBe(false);
  });
});

describe('priceLevels', () => {
  it('draws a position with its stop and target', () => {
    const lines = priceLevels(
      'EUR.USD',
      [
        {
          symbol: 'EURUSD',
          position: -10000,
          average_cost: 1.1,
          stop_loss: 1.11,
          take_profit: 1.08,
        },
        { symbol: 'GBP.USD', position: 5, average_cost: 1.3 },
        { symbol: 'EUR.USD', position: 0, average_cost: 1.2 },
      ],
      []
    );
    expect(lines.map((l) => [l.key, l.price, l.title, l.style])).toEqual([
      ['position:short', 1.1, 'Short 10,000', 'solid'],
      ['stop:short', 1.11, 'Stop', 'dashed'],
      ['target:short', 1.08, 'Target', 'dashed'],
    ]);
  });

  it('leaves out a level the broker did not report', () => {
    const lines = priceLevels(
      'AAPL',
      [{ symbol: 'AAPL', position: 3, average_cost: 190, stop_loss: null, take_profit: 0 }],
      []
    );
    expect(lines.map((l) => l.title)).toEqual(['Long 3']);
  });

  it('draws each working order that waits at a price', () => {
    const lines = priceLevels(
      'EUR.USD',
      [],
      [
        {
          order_id: '7',
          symbol: 'EUR.USD',
          action: 'BUY',
          quantity: 2000,
          order_type: 'LMT',
          price: 1.09,
        },
        {
          order_id: '8',
          symbol: 'EUR.USD',
          action: 'SELL',
          quantity: 2000,
          remaining_quantity: 500,
          order_type: 'STP_LMT',
          price: 1.07,
        },
        {
          order_id: '9',
          symbol: 'EUR.USD',
          action: 'BUY',
          quantity: 1,
          order_type: 'MKT',
          price: null,
        },
        {
          order_id: '10',
          symbol: 'USD.JPY',
          action: 'BUY',
          quantity: 1,
          order_type: 'LMT',
          price: 150,
        },
      ]
    );
    expect(lines.map((l) => [l.key, l.price, l.title, l.style])).toEqual([
      ['order:7', 1.09, 'Buy limit 2,000', 'dotted'],
      ['order:8', 1.07, 'Sell stop-limit 500', 'dotted'],
    ]);
  });
});
