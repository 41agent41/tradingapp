/**
 * PriceAlertRepository tests.
 *
 * A fake `Querier` records the SQL + params and returns canned rows, so the
 * SQL generation is verified without Postgres (mirrors
 * watchlistRepository.test.ts).
 */
import { PriceAlertRepository, type Querier } from '../src/services/priceAlertRepository.js';

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

describe('PriceAlertRepository.create', () => {
  it('inserts the watchlist_item_id/condition/target_price', async () => {
    const { db, calls } = fakeDb(() => [
      { id: 1, watchlist_item_id: 5, condition: 'above', target_price: '210.00', status: 'active' },
    ]);
    const repo = new PriceAlertRepository(db);
    const row = await repo.create({ watchlist_item_id: 5, condition: 'above', target_price: 210 });
    expect(calls[0].text).toMatch(/INSERT INTO price_alerts/);
    expect(calls[0].params).toEqual([5, 'above', 210]);
    expect(row.status).toBe('active');
  });
});

describe('PriceAlertRepository.list', () => {
  it('filters by watchlist_item_id and status', async () => {
    const { db, calls } = fakeDb(() => [{ id: 1 }]);
    const repo = new PriceAlertRepository(db);
    await repo.list({ watchlist_item_id: 5, status: 'active' });
    expect(calls[0].text).toMatch(/WHERE watchlist_item_id = \$1 AND status = \$2/);
    expect(calls[0].params).toEqual([5, 'active']);
  });

  it('lists everything when no filter is given', async () => {
    const { db, calls } = fakeDb(() => []);
    const repo = new PriceAlertRepository(db);
    await repo.list();
    expect(calls[0].text).not.toMatch(/WHERE/);
    expect(calls[0].params).toEqual([]);
  });
});

describe('PriceAlertRepository.trigger', () => {
  it('only transitions an active alert (WHERE status = active guard)', async () => {
    const { db, calls } = fakeDb(() => [{ id: 1, status: 'triggered', triggered_price: '215.50' }]);
    const repo = new PriceAlertRepository(db);
    const row = await repo.trigger(1, 215.5);
    expect(calls[0].text).toMatch(/WHERE id = \$1 AND status = 'active'/);
    expect(calls[0].params).toEqual([1, 215.5]);
    expect(row?.status).toBe('triggered');
  });

  it('returns null when nothing matched (already triggered/dismissed)', async () => {
    const { db } = fakeDb(() => []);
    const repo = new PriceAlertRepository(db);
    const row = await repo.trigger(1, 215.5);
    expect(row).toBeNull();
  });
});

describe('PriceAlertRepository.dismiss', () => {
  it('sets status to dismissed', async () => {
    const { db, calls } = fakeDb(() => [{ id: 1, status: 'dismissed' }]);
    const repo = new PriceAlertRepository(db);
    const row = await repo.dismiss(1);
    expect(calls[0].text).toMatch(/SET status = 'dismissed'/);
    expect(row?.status).toBe('dismissed');
  });
});

describe('PriceAlertRepository.remove', () => {
  it('reports removed=true when a row was deleted', async () => {
    const { db } = fakeDb(() => [{ id: 1 }]);
    const repo = new PriceAlertRepository(db);
    const { removed } = await repo.remove(1);
    expect(removed).toBe(true);
  });

  it('reports removed=false when nothing matched', async () => {
    const { db } = fakeDb(() => []);
    const repo = new PriceAlertRepository(db);
    const { removed } = await repo.remove(999);
    expect(removed).toBe(false);
  });
});
