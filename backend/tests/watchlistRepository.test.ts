/**
 * WatchlistRepository tests.
 *
 * A fake `Querier` records the SQL + params and returns canned rows, so the
 * SQL generation is verified without Postgres (mirrors
 * strategyRepository.test.ts).
 */
import { WatchlistRepository, type Querier } from '../src/services/watchlistRepository.js';

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

describe('WatchlistRepository.list', () => {
  it('orders by sort_order then id', async () => {
    const { db, calls } = fakeDb(() => [{ id: 1, symbol: 'MSFT' }]);
    const repo = new WatchlistRepository(db);
    const rows = await repo.list();
    expect(calls[0].text).toMatch(/ORDER BY sort_order ASC, id ASC/);
    expect(rows).toEqual([{ id: 1, symbol: 'MSFT' }]);
  });
});

describe('WatchlistRepository.find', () => {
  it('returns the row when found', async () => {
    const { db, calls } = fakeDb(() => [{ id: 1, symbol: 'MSFT' }]);
    const repo = new WatchlistRepository(db);
    const row = await repo.find(1);
    expect(calls[0].text).toMatch(/WHERE id = \$1/);
    expect(row?.symbol).toBe('MSFT');
  });

  it('returns null when not found', async () => {
    const { db } = fakeDb(() => []);
    const repo = new WatchlistRepository(db);
    const row = await repo.find(999);
    expect(row).toBeNull();
  });
});

describe('WatchlistRepository.add', () => {
  it('uppercases the symbol and defaults broker/sec_type/exchange/currency', async () => {
    const { db, calls } = fakeDb(() => [
      {
        id: 1,
        broker: 'ib',
        symbol: 'MSFT',
        sec_type: 'STK',
        exchange: 'SMART',
        currency: 'USD',
        notes: null,
        sort_order: 0,
        inserted: true,
      },
    ]);
    const repo = new WatchlistRepository(db);
    const { added, row } = await repo.add({ symbol: 'msft' });
    expect(calls[0].text).toMatch(/INSERT INTO watchlist_items/);
    expect(calls[0].params).toEqual(['ib', 'MSFT', 'STK', 'SMART', 'USD', null]);
    expect(added).toBe(true);
    expect(row.symbol).toBe('MSFT');
    expect((row as any).inserted).toBeUndefined();
  });

  it('reports added=false when the row already existed (ON CONFLICT UPDATE)', async () => {
    const { db } = fakeDb(() => [
      {
        id: 1,
        broker: 'ib',
        symbol: 'MSFT',
        sec_type: 'STK',
        exchange: 'SMART',
        currency: 'USD',
        notes: 'already here',
        sort_order: 0,
        inserted: false,
      },
    ]);
    const repo = new WatchlistRepository(db);
    const { added, row } = await repo.add({ symbol: 'MSFT' });
    expect(added).toBe(false);
    expect(row.notes).toBe('already here');
  });
});

describe('WatchlistRepository.remove', () => {
  it('reports removed=true when a row was deleted', async () => {
    const { db } = fakeDb(() => [{ id: 1 }]);
    const repo = new WatchlistRepository(db);
    const { removed } = await repo.remove(1);
    expect(removed).toBe(true);
  });

  it('reports removed=false when nothing matched', async () => {
    const { db } = fakeDb(() => []);
    const repo = new WatchlistRepository(db);
    const { removed } = await repo.remove(999);
    expect(removed).toBe(false);
  });
});
