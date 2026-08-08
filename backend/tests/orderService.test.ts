/**
 * orderService.submitCreateOrder tests — the audited create-order core shared
 * by the HTTP route and the A3 execution engine. Injected audit + IB deps, so
 * each fail-closed branch is asserted without a DB or the IB service.
 */
import { submitCreateOrder } from '../src/services/orderService.js';
import type { ValidatedOrder } from '../src/services/orderTypes.js';

function order(overrides: Partial<ValidatedOrder> = {}): ValidatedOrder {
  return {
    symbol: 'MSFT',
    action: 'BUY',
    quantity: 10,
    order_type: 'MKT',
    tif: 'DAY',
    account_mode: 'paper',
    broker: 'ib',
    broker_account: 'default',
    limit_price: null,
    stop_price: null,
    sec_type: 'STK',
    exchange: 'SMART',
    currency: 'USD',
    ...overrides,
  };
}

function makeDeps() {
  const create = jest.fn().mockResolvedValue({ id: 7 });
  const update = jest.fn().mockResolvedValue(undefined);
  // The account-exposure source for the position guard: fills plus the
  // unfilled remainder of still-working orders, not submitted quantities.
  const netPosition = jest.fn().mockResolvedValue(0);
  const ibPost = jest.fn().mockResolvedValue({ data: { order_id: 42, status: 'submitted' } });
  return {
    create,
    update,
    netPosition,
    ibPost,
    overrides: {
      audit: { create, update },
      netPosition,
      ibPost,
      warn: () => undefined,
      error: () => undefined,
    },
  };
}

beforeEach(() => {
  delete process.env.LIVE_TRADING_ENABLED;
  delete process.env.ORDER_MAX_POSITION;
});

describe('submitCreateOrder', () => {
  it('places a paper order and records the outcome on the audit row', async () => {
    const d = makeDeps();
    const outcome = await submitCreateOrder(order(), 'req-1', d.overrides);
    expect(outcome).toEqual({
      ok: true,
      auditId: 7,
      ibBody: { order_id: 42, status: 'submitted' },
    });
    expect(d.create).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'MSFT', operation: 'CREATE', request_id: 'req-1' })
    );
    expect(d.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, ib_order_id: 42, status: 'submitted' })
    );
    // Broker forwarded to the IB-service payload (B1).
    expect(d.ibPost).toHaveBeenCalledWith(expect.objectContaining({ broker: 'ib' }));
  });

  it('keys the position guard per broker (B1)', async () => {
    process.env.ORDER_MAX_POSITION = '1000';
    const d = makeDeps();
    d.netPosition.mockResolvedValueOnce(100);
    await submitCreateOrder(order({ broker: 'mt5' }), null, d.overrides);
    expect(d.netPosition).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'MSFT', account_mode: 'paper', broker: 'mt5' })
    );
  });

  it('blocks a live order when LIVE_TRADING_ENABLED is false', async () => {
    const d = makeDeps();
    const outcome = await submitCreateOrder(order({ account_mode: 'live' }), null, d.overrides);
    expect(outcome).toEqual({ ok: false, kind: 'live_disabled' });
    expect(d.create).not.toHaveBeenCalled();
    expect(d.ibPost).not.toHaveBeenCalled();
  });

  it('rejects on a position-limit breach without touching IB or the audit log', async () => {
    process.env.ORDER_MAX_POSITION = '1000';
    const d = makeDeps();
    d.netPosition.mockResolvedValueOnce(900);
    const outcome = await submitCreateOrder(order({ quantity: 200 }), null, d.overrides);
    expect(outcome).toMatchObject({
      ok: false,
      kind: 'position_limit',
      projected: 1100,
      cap: 1000,
    });
    expect(d.create).not.toHaveBeenCalled();
    expect(d.ibPost).not.toHaveBeenCalled();
  });

  it('fails closed when the net exposure cannot be computed', async () => {
    process.env.ORDER_MAX_POSITION = '1000';
    const d = makeDeps();
    d.netPosition.mockRejectedValueOnce(new Error('db down'));
    const outcome = await submitCreateOrder(order(), null, d.overrides);
    expect(outcome).toEqual({ ok: false, kind: 'position_check_failed' });
    expect(d.create).not.toHaveBeenCalled();
  });

  it('refuses to forward when the audit insert fails', async () => {
    const d = makeDeps();
    d.create.mockRejectedValueOnce(new Error('db down'));
    const outcome = await submitCreateOrder(order(), null, d.overrides);
    expect(outcome).toEqual({ ok: false, kind: 'audit_failed' });
    expect(d.ibPost).not.toHaveBeenCalled();
  });

  it('marks the audit row rejected and reports ib_error when IB errors out', async () => {
    const d = makeDeps();
    d.ibPost.mockRejectedValueOnce({ response: { data: { detail: 'no connection' } } });
    const outcome = await submitCreateOrder(order(), null, d.overrides);
    expect(outcome).toMatchObject({ ok: false, kind: 'ib_error', auditId: 7 });
    expect(d.update).toHaveBeenCalledWith(expect.objectContaining({ id: 7, status: 'rejected' }));
  });
});
