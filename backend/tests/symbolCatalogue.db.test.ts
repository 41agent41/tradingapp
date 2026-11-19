/**
 * The symbol catalogue's SQL against a real database: a list is stored,
 * replaced and searched as the in-memory tests expect. Runs only with
 * DB_TESTS=1.
 */
import fs from 'fs';
import path from 'path';

import { Pool } from 'pg';

import { SymbolCatalogue, type CatalogueDb } from '../src/services/symbolCatalogue.js';

const run = process.env.DB_TESTS === '1' ? describe : describe.skip;

run('SymbolCatalogue with a database', () => {
  let pool: Pool;
  let db: CatalogueDb;

  beforeAll(async () => {
    pool = new Pool({
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
    });
    const migration = path.join(__dirname, '../src/database/migrations/011_broker_symbols.sql');
    await pool.query(fs.readFileSync(migration, 'utf8'));
    await pool.query(`DELETE FROM broker_symbols WHERE platform = 'test'`);
    await pool.query(`DELETE FROM broker_symbol_lists WHERE platform = 'test'`);
    db = {
      query: (text, params) => pool.query(text, params as any[]),
      async transaction(cb) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const out = await cb({ query: (t, p) => client.query(t, p as any[]) });
          await client.query('COMMIT');
          return out;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      },
    };
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM broker_symbols WHERE platform = 'test'`);
    await pool.query(`DELETE FROM broker_symbol_lists WHERE platform = 'test'`);
    await pool.end();
  });

  it('stores a whole list, searches it and replaces it', async () => {
    const instruments = [
      { symbol: 'EUR.USD', name: 'EUR/USD', market: 'FX', secType: 'CASH', currency: 'USD' },
      { symbol: 'AU200.AUD', name: 'Australia 200', market: 'INDEX', secType: 'CFD' },
      { symbol: 'XAU.USD', name: 'Gold', market: 'METAL', secType: 'CFD' },
    ];
    // Enough rows to need more than one insert batch.
    for (let i = 0; i < 1200; i++) {
      instruments.push({
        symbol: `S${i}`,
        name: `Stock ${i}`,
        market: 'STOCK',
        secType: 'STK',
      } as any);
    }
    let answer: any = { complete: true, instruments };
    const catalogue = new SymbolCatalogue(db, async () => answer);

    const all = await catalogue.list({ platform: 'test', account: '', limit: 1000 });
    expect(all.complete).toBe(true);
    expect(all.markets).toEqual([
      { market: 'FX', count: 1 },
      { market: 'INDEX', count: 1 },
      { market: 'METAL', count: 1 },
      { market: 'STOCK', count: 1200 },
    ]);
    expect(all.symbols).toHaveLength(1000);

    const fx = await catalogue.list({ platform: 'test', account: '', q: 'eurusd' });
    expect(fx.symbols.map((s) => s.symbol)).toEqual(['EUR.USD']);
    const byName = await catalogue.list({ platform: 'test', account: '', q: 'austral' });
    expect(byName.symbols.map((s) => s.symbol)).toEqual(['AU200.AUD']);
    const exactFirst = await catalogue.list({ platform: 'test', account: '', q: 'S1', limit: 3 });
    expect(exactFirst.symbols[0].symbol).toBe('S1');

    answer = { complete: true, instruments: instruments.slice(0, 1) };
    const replaced = await catalogue.list({ platform: 'test', account: '', refresh: true });
    expect(replaced.symbols.map((s) => s.symbol)).toEqual(['EUR.USD']);
  });

  it('adds what a search-only broker finds', async () => {
    let answer: any = { complete: false, instruments: [] };
    const catalogue = new SymbolCatalogue(db, async () => answer);
    await catalogue.list({ platform: 'test', account: 'ib1' });
    answer = {
      complete: false,
      instruments: [{ symbol: 'AAPL', name: 'Apple', market: 'STOCK', secType: 'STK' }],
    };
    const found = await catalogue.list({
      platform: 'test',
      account: 'ib1',
      q: 'AA',
      market: 'STOCK',
    });
    expect(found.complete).toBe(false);
    expect(found.symbols.map((s) => s.symbol)).toEqual(['AAPL']);
  });
});
