/**
 * The symbol catalogue: when it goes to the broker, what it stores, and what
 * it serves when the broker cannot be reached. The database is an in-memory
 * stand-in that answers the catalogue's own statements; the SQL itself is
 * run against Postgres in symbolCatalogue.db.test.ts.
 */
import express from 'express';
import request from 'supertest';

import {
  SymbolCatalogue,
  toRows,
  type CatalogueDb,
  type FetchParams,
  type FetchedCatalogue,
} from '../src/services/symbolCatalogue.js';
import { createSymbolsRouter } from '../src/routes/marketData/symbols.js';

type Row = Record<string, any>;
const bare = (s: string) => s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

/** Just enough of Postgres for the catalogue's statements. */
function memoryDb() {
  const symbols: Row[] = [];
  const lists: Row[] = [];
  const db: CatalogueDb = {
    async query(text: string, p: any[] = []) {
      const sql = text.replace(/\s+/g, ' ');
      const mine = (r: Row) => r.platform === p[0] && r.account === p[1];
      if (sql.startsWith('SELECT complete, refreshed_at')) {
        return { rows: lists.filter(mine) };
      }
      if (sql.startsWith('SELECT 1 FROM broker_symbols')) {
        const [, , market, q] = p;
        const hit = symbols.some(
          (r) => mine(r) && (!market || r.market === market) && bare(r.symbol).startsWith(bare(q))
        );
        return { rows: hit ? [{}] : [] };
      }
      if (sql.startsWith('DELETE FROM broker_symbols')) {
        for (let i = symbols.length - 1; i >= 0; i--) if (mine(symbols[i])) symbols.splice(i, 1);
        return { rows: [] };
      }
      if (sql.startsWith('INSERT INTO broker_symbols')) {
        const [platform, account, s, n, m, t, c, e, v] = p;
        s.forEach((symbol: string, i: number) => {
          const row = {
            platform,
            account,
            symbol,
            name: n[i],
            market: m[i],
            sec_type: t[i],
            currency: c[i],
            exchange: e[i],
            venue_id: v[i],
          };
          const at = symbols.findIndex(
            (r) => mine(r) && r.symbol === symbol && r.sec_type === t[i]
          );
          if (at >= 0) symbols[at] = row;
          else symbols.push(row);
        });
        return { rows: [] };
      }
      if (sql.startsWith('INSERT INTO broker_symbol_lists')) {
        const row = {
          platform: p[0],
          account: p[1],
          complete: p[2],
          symbol_count: symbols.filter(mine).length,
          refreshed_at: new Date(clock.now),
        };
        const at = lists.findIndex(mine);
        if (at >= 0) lists[at] = row;
        else lists.push(row);
        return { rows: [] };
      }
      if (sql.startsWith('SELECT symbol, name, market')) {
        const [, , market, q, limit] = p;
        const rows = symbols
          .filter(
            (r) =>
              mine(r) &&
              (!market || r.market === market) &&
              (!q ||
                bare(r.symbol).startsWith(bare(q)) ||
                r.name.toUpperCase().includes(q.toUpperCase()))
          )
          .sort((a, b) => a.symbol.localeCompare(b.symbol))
          .slice(0, limit)
          .map(({ platform: _p, account: _a, ...rest }) => rest);
        return { rows };
      }
      if (sql.startsWith('SELECT market, COUNT(*)')) {
        const counts = new Map<string, number>();
        for (const r of symbols.filter(mine)) counts.set(r.market, (counts.get(r.market) ?? 0) + 1);
        return { rows: [...counts].map(([market, count]) => ({ market, count })) };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    async transaction(cb) {
      return cb(db);
    },
  };
  return { db, symbols, lists };
}

const clock = { now: Date.parse('2026-11-18T00:00:00Z') };

const OANDA: FetchedCatalogue = {
  complete: true,
  instruments: [
    { symbol: 'EUR.USD', name: 'EUR/USD', market: 'FX', secType: 'CASH', currency: 'USD' },
    { symbol: 'AU200.AUD', name: 'Australia 200', market: 'INDEX', secType: 'CFD' },
    { symbol: 'XAU.USD', name: 'Gold', market: 'METAL', secType: 'CFD' },
  ],
};

function setup(fetched: FetchedCatalogue | Error = OANDA) {
  const store = memoryDb();
  const calls: FetchParams[] = [];
  let next: FetchedCatalogue | Error = fetched;
  const fetch = jest.fn(async (params: FetchParams) => {
    calls.push(params);
    if (next instanceof Error) throw next;
    return next;
  });
  const catalogue = new SymbolCatalogue(store.db, fetch, () => clock.now);
  return {
    ...store,
    calls,
    catalogue,
    answerWith: (f: FetchedCatalogue | Error) => {
      next = f;
    },
  };
}

beforeEach(() => {
  clock.now = Date.parse('2026-11-18T00:00:00Z');
});

describe('a listable broker', () => {
  it('fetches the whole list once, stores it and serves it grouped by market', async () => {
    const t = setup();
    const first = await t.catalogue.list({ platform: 'oanda', account: '' });
    expect(first.complete).toBe(true);
    expect(first.symbols.map((s) => s.symbol)).toEqual(['AU200.AUD', 'EUR.USD', 'XAU.USD']);
    expect(first.markets).toEqual([
      { market: 'FX', count: 1 },
      { market: 'INDEX', count: 1 },
      { market: 'METAL', count: 1 },
    ]);
    expect(t.calls).toEqual([expect.objectContaining({ source: 'oanda', account: undefined })]);

    const indices = await t.catalogue.list({ platform: 'oanda', account: '', market: 'INDEX' });
    expect(indices.symbols).toEqual([
      expect.objectContaining({ symbol: 'AU200.AUD', sec_type: 'CFD', market: 'INDEX' }),
    ]);
    expect(t.calls).toHaveLength(1);
  });

  it('finds EUR.USD when EURUSD is typed', async () => {
    const t = setup();
    const found = await t.catalogue.list({ platform: 'oanda', account: '', q: 'eurusd' });
    expect(found.symbols.map((s) => s.symbol)).toEqual(['EUR.USD']);
  });

  it('fetches again once a day old, and replaces what it had', async () => {
    const t = setup();
    await t.catalogue.list({ platform: 'oanda', account: '' });
    t.answerWith({ complete: true, instruments: [OANDA.instruments[0]] });
    clock.now += 23 * 3_600_000;
    await t.catalogue.list({ platform: 'oanda', account: '' });
    expect(t.calls).toHaveLength(1);
    clock.now += 2 * 3_600_000;
    const later = await t.catalogue.list({ platform: 'oanda', account: '' });
    expect(t.calls).toHaveLength(2);
    expect(later.symbols.map((s) => s.symbol)).toEqual(['EUR.USD']);
  });

  it('serves what it has, marked stale, when the broker is down', async () => {
    const t = setup();
    await t.catalogue.list({ platform: 'oanda', account: '' });
    t.answerWith(Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }));
    const stale = await t.catalogue.list({ platform: 'oanda', account: '', refresh: true });
    expect(stale.stale).toBe(true);
    expect(stale.error).toMatch(/not reachable/);
    expect(stale.symbols).toHaveLength(3);
  });

  it('keeps each account its own list', async () => {
    const t = setup();
    await t.catalogue.list({ platform: 'oanda', account: 'live' });
    const other = await t.catalogue.list({ platform: 'oanda', account: '' });
    expect(t.calls.map((c) => c.account)).toEqual(['live', undefined]);
    expect(other.symbols).toHaveLength(3);
  });
});

describe('a search-only broker', () => {
  const IB_FIRST: FetchedCatalogue = { complete: false, instruments: [] };

  it('searches the broker only for what it has not found before', async () => {
    const t = setup(IB_FIRST);
    const empty = await t.catalogue.list({ platform: 'ib', account: '' });
    expect(empty.complete).toBe(false);
    expect(empty.symbols).toEqual([]);

    t.answerWith({
      complete: false,
      instruments: [{ symbol: 'AAPL', name: 'Apple', market: 'STOCK', secType: 'STK' }],
    });
    const found = await t.catalogue.list({
      platform: 'ib',
      account: '',
      q: 'AAP',
      market: 'STOCK',
    });
    expect(t.calls[1]).toMatchObject({ source: 'ib', q: 'AAP', market: 'STOCK' });
    expect(found.symbols.map((s) => s.symbol)).toEqual(['AAPL']);

    // Typed again: already found, so the broker is not asked.
    await t.catalogue.list({ platform: 'ib', account: '', q: 'AAPL', market: 'STOCK' });
    // One letter is too little to search on.
    await t.catalogue.list({ platform: 'ib', account: '', q: 'M' });
    expect(t.calls).toHaveLength(2);

    // A search adds to the list; it never replaces it.
    t.answerWith({
      complete: false,
      instruments: [{ symbol: 'MSFT', name: 'Microsoft', market: 'STOCK', secType: 'STK' }],
    });
    await t.catalogue.list({ platform: 'ib', account: '', q: 'MS' });
    const all = await t.catalogue.list({ platform: 'ib', account: '' });
    expect(all.symbols.map((s) => s.symbol)).toEqual(['AAPL', 'MSFT']);
  });
});

describe('toRows', () => {
  it('drops blank symbols, folds unknown markets into OTHER and keeps one row per symbol', () => {
    const rows = toRows([
      { symbol: '', market: 'FX' },
      { symbol: 'X', market: 'WEIRD', secType: 'cfd' },
      { symbol: 'X', market: 'INDEX', secType: 'CFD' },
    ]);
    expect(rows).toEqual([
      expect.objectContaining({ symbol: 'X', market: 'INDEX', sec_type: 'CFD' }),
    ]);
  });
});

describe('routes', () => {
  function app(t: ReturnType<typeof setup>) {
    const a = express();
    a.use(express.json());
    a.use('/api/market-data', createSymbolsRouter(t.catalogue));
    return a;
  }

  it('GET /symbols answers from the catalogue for the connection asked for', async () => {
    const t = setup();
    const res = await request(app(t)).get(
      '/api/market-data/symbols?source=oanda&account=demo&market=FX'
    );
    expect(res.status).toBe(200);
    expect(res.body.platform).toBe('oanda');
    expect(res.body.account).toBe('demo');
    expect(res.body.symbols.map((s: any) => s.symbol)).toEqual(['EUR.USD']);
  });

  it('rejects an account name that is not one', async () => {
    const res = await request(app(setup())).get(
      '/api/market-data/symbols?source=oanda&account=../x'
    );
    expect(res.status).toBe(400);
  });

  it('is a 502 with the reason when there is nothing stored and the broker is down', async () => {
    const t = setup(
      Object.assign(new Error('x'), { response: { data: { detail: 'OANDA unreachable' } } })
    );
    const res = await request(app(t)).get('/api/market-data/symbols?source=oanda');
    expect(res.status).toBe(502);
    expect(res.body.message).toBe('OANDA unreachable');
  });

  it('POST /symbols/refresh fetches the list again', async () => {
    const t = setup();
    await request(app(t)).get('/api/market-data/symbols?source=oanda');
    const res = await request(app(t))
      .post('/api/market-data/symbols/refresh')
      .send({ source: 'oanda' });
    expect(res.status).toBe(200);
    expect(t.calls).toHaveLength(2);
  });
});
