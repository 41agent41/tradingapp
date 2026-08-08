/**
 * OrderAuditRepository tests — focused on the broker dimension added in B1.
 * A fake Querier records SQL + params, so the SQL generation is verified
 * without Postgres (mirrors strategyRepository.test.ts).
 */
import { OrderAuditRepository } from '../src/services/orderAuditRepository.js';
import type { Querier } from '../src/services/backtestRunRepository.js';
import type { ValidatedOrder } from '../src/services/orderTypes.js';

interface Call {
  text: string;
  params: unknown[];
}

function fakeDb(rowsFor: (call: Call) => any[]) {
  const calls: Call[] = [];
  const db: Querier = {
    query: async (text: string, params: unknown[] = []) => {
      const call = { text, params };
      calls.push(call);
      return { rows: rowsFor(call) };
    },
  };
  return { db, calls };
}

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
    stop_loss: null,
    take_profit: null,
    stop_price: null,
    sec_type: 'STK',
    exchange: 'SMART',
    currency: 'USD',
    ...overrides,
  };
}

describe('OrderAuditRepository.create', () => {
  it('inserts the connection columns (defaults handled upstream)', async () => {
    const { db, calls } = fakeDb(() => [{ id: 1 }]);
    const repo = new OrderAuditRepository(db);
    await repo.create({
      ...order({ broker: 'mt5', broker_account: 'pepperstone-live' }),
      operation: 'CREATE',
      request_id: 'r1',
    });
    expect(calls[0].text).toMatch(/INSERT INTO order_audit/);
    expect(calls[0].text).toMatch(/account_mode, broker, broker_account, action/);
    // account_mode is param $1, broker $2, broker_account $15.
    expect(calls[0].params[0]).toBe('paper');
    expect(calls[0].params[1]).toBe('mt5');
    expect(calls[0].params[14]).toBe('pepperstone-live');
  });

  it('defaults broker to ib and account to default when absent', async () => {
    const { db, calls } = fakeDb(() => [{ id: 1 }]);
    const repo = new OrderAuditRepository(db);
    const o = order();
    delete (o as { broker?: string }).broker;
    delete (o as { broker_account?: string }).broker_account;
    await repo.create({ ...o, operation: 'CREATE' });
    expect(calls[0].params[1]).toBe('ib');
    expect(calls[0].params[14]).toBe('default');
  });
});

describe('OrderAuditRepository.netExposure', () => {
  it('keys the net query on connection + symbol + account_mode', async () => {
    const { db, calls } = fakeDb(() => [{ net: 250 }]);
    const repo = new OrderAuditRepository(db);
    const net = await repo.netExposure('msft', 'paper', 24, 'mt5', 'pepperstone-live');
    expect(calls[0].text).toMatch(/AND broker = \$4/);
    expect(calls[0].text).toMatch(/AND broker_account = \$5/);
    expect(calls[0].params).toEqual(['MSFT', 'paper', 24, 'mt5', 'pepperstone-live']);
    expect(net).toBe(250);
  });

  it('defaults the broker to ib and the account to default', async () => {
    const { db, calls } = fakeDb(() => [{ net: 0 }]);
    const repo = new OrderAuditRepository(db);
    await repo.netExposure('MSFT', 'paper', 24);
    expect(calls[0].params[3]).toBe('ib');
    expect(calls[0].params[4]).toBe('default');
  });

  // Bug ② from the multi-platform plan: keyed on `broker` alone, three
  // accounts each 1 lot long the same pair summed to 3 lots against a
  // per-account cap. The guard fails closed, so the symptom was entries
  // refused on accounts nowhere near their limit.
  it('does not sum exposure across two accounts on one platform', async () => {
    const { db, calls } = fakeDb(() => [{ net: 1 }]);
    const repo = new OrderAuditRepository(db);
    await repo.netExposure('EURUSD', 'live', 24, 'mt5', 'icmarkets-live');
    await repo.netExposure('EURUSD', 'live', 24, 'mt5', 'pepperstone-live');
    expect(calls[0].params[4]).toBe('icmarkets-live');
    expect(calls[1].params[4]).toBe('pepperstone-live');
  });
});

describe('OrderAuditRepository.list', () => {
  it('filters on broker when provided', async () => {
    const { db, calls } = fakeDb(() => []);
    const repo = new OrderAuditRepository(db);
    await repo.list({ broker: 'mt5' });
    expect(calls[0].text).toMatch(/broker = \$1/);
    expect(calls[0].params[0]).toBe('mt5');
  });
});
