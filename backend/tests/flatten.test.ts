/**
 * Flatten a connection (E-6): close every open position at market.
 */
import {
  describeFlatten,
  flattenConnection,
  flattenSucceeded,
  type FlattenDeps,
} from '../src/services/flatten.js';

const connection = { broker: 'mt5', brokerAccount: 'ftmo' };

function deps(overrides: Partial<FlattenDeps> = {}): FlattenDeps {
  let audit = 100;
  return {
    positions: jest.fn().mockResolvedValue([
      { symbol: 'EURUSD.a', size: 0.37 },
      { symbol: 'XAUUSD.a', size: -2 },
      { symbol: 'GBPUSD.a', size: 0 },
    ]),
    instrumentSpec: jest.fn().mockResolvedValue({
      unit: 'lots',
      minSize: 0.01,
      sizeStep: 0.01,
      contractSize: 100000,
    }),
    submitOrder: jest.fn().mockImplementation(async () => ({
      ok: true,
      auditId: ++audit,
      ibBody: {},
    })),
    ...overrides,
  };
}

describe('flattenConnection', () => {
  it('closes each open position the other way, on the venue step, through the audited path', async () => {
    const d = deps();
    const result = await flattenConnection(d, connection, 'paper', 'killswitch');

    expect(result).toEqual({
      closed: [
        { symbol: 'EURUSD.a', action: 'SELL', quantity: 0.37, audit_id: 101 },
        { symbol: 'XAUUSD.a', action: 'BUY', quantity: 2, audit_id: 102 },
      ],
      failed: [],
      error: null,
    });
    expect(d.submitOrder).toHaveBeenCalledTimes(2);
    expect(d.submitOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'EURUSD.a',
        action: 'SELL',
        quantity: 0.37,
        order_type: 'MKT',
        account_mode: 'paper',
        broker: 'mt5',
        broker_account: 'ftmo',
      }),
      'killswitch:flatten:EURUSD.a'
    );
    expect(flattenSucceeded(result)).toBe(true);
    expect(describeFlatten(result)).toBe('Closed at market: EURUSD.a SELL 0.37, XAUUSD.a BUY 2.');
  });

  it('sends nothing when the positions cannot be read', async () => {
    const d = deps({ positions: jest.fn().mockRejectedValue(new Error('venue down')) });
    const result = await flattenConnection(d, connection, 'paper', 'killswitch');
    expect(d.submitOrder).not.toHaveBeenCalled();
    expect(result.error).toMatch(/venue down/);
    expect(flattenSucceeded(result)).toBe(false);
    expect(describeFlatten(result)).toMatch(/Nothing was closed.*by hand/);
  });

  it('keeps going past a close that fails, and reports it', async () => {
    const d = deps({
      submitOrder: jest
        .fn()
        .mockResolvedValueOnce({ ok: false, kind: 'live_disabled' })
        .mockResolvedValueOnce({ ok: true, auditId: 7, ibBody: {} }),
    });
    const result = await flattenConnection(d, connection, 'live', 'operator');
    expect(result.failed).toEqual([{ symbol: 'EURUSD.a', error: 'not placed (live_disabled)' }]);
    expect(result.closed).toEqual([
      { symbol: 'XAUUSD.a', action: 'BUY', quantity: 2, audit_id: 7 },
    ]);
    expect(flattenSucceeded(result)).toBe(false);
    expect(describeFlatten(result)).toMatch(/NOT closed, close by hand: EURUSD.a/);
  });

  it('says so when nothing was open', async () => {
    const d = deps({ positions: jest.fn().mockResolvedValue([]) });
    const result = await flattenConnection(d, connection, 'paper', 'killswitch');
    expect(flattenSucceeded(result)).toBe(true);
    expect(describeFlatten(result)).toBe('No positions were open.');
  });
});
