/**
 * Bar storage against a real TimescaleDB.
 *
 * The rest of the suite fakes the database, which is how contract storage
 * stayed broken unnoticed: the SQL never met Postgres. These tests run only
 * with DB_TESTS=1 and the POSTGRES_* variables pointing at a scratch database
 * that already has `timescaledb-schema.sql` applied (CI applies it with psql,
 * because its continuous aggregate cannot be created inside the single
 * transaction a multi-statement query from `pg` runs in). Otherwise they are
 * skipped.
 */
import { dbService } from '../src/services/database.js';
import { marketDataService, type CandlestickBar } from '../src/services/marketDataService.js';

const run = process.env.DB_TESTS === '1' ? describe : describe.skip;

// Unique per run, so a reused database never hands back an earlier run's rows.
const tag = Date.now().toString(36).slice(-6).toUpperCase();
const sym = (s: string) => `${s}${tag}`;

function bars(...hours: number[]): CandlestickBar[] {
  return hours.map((h) => ({
    timestamp: new Date(Date.UTC(2026, 0, 5, h)),
    open: 1.1,
    high: 1.2,
    low: 1.0,
    close: 1.15,
    volume: 100,
  }));
}

run('bar storage (real database)', () => {
  jest.setTimeout(60000);

  afterAll(async () => {
    await dbService.close();
  });

  it('finds the same contract again when expiry, strike and right are empty', async () => {
    const contract = { broker: 'oanda', symbol: sym('EU'), secType: 'CASH', currency: 'USD' };
    const first = await marketDataService.getOrCreateContract(contract);
    const second = await marketDataService.getOrCreateContract(contract);
    expect(second).toBe(first);

    const rows = await dbService.query(
      'SELECT count(*)::int AS n FROM contracts WHERE symbol = $1',
      [contract.symbol]
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('creates one contract when two first stores race', async () => {
    const contract = { broker: 'ib', symbol: sym('RACE'), secType: 'STK', exchange: 'SMART' };
    const ids = await Promise.all(
      Array.from({ length: 5 }, () => marketDataService.getOrCreateContract(contract))
    );
    expect(new Set(ids).size).toBe(1);
  });

  it('keeps the same symbol at two brokers apart', async () => {
    const symbol = sym('MSFT');
    const ib = await marketDataService.getOrCreateContract({
      broker: 'ib',
      symbol,
      secType: 'STK',
    });
    const alpaca = await marketDataService.getOrCreateContract({
      broker: 'alpaca',
      symbol,
      secType: 'STK',
    });
    expect(alpaca).not.toBe(ib);
  });

  it('stores bars, counts re-stores as updates, and reads back per broker', async () => {
    const symbol = sym('GBP');
    const oanda = await marketDataService.getOrCreateContract({
      broker: 'oanda',
      symbol,
      secType: 'CASH',
    });
    const mt5 = await marketDataService.getOrCreateContract({
      broker: 'mt5',
      symbol,
      secType: 'CASH',
    });

    expect(await marketDataService.storeCandlestickData(oanda, '1hour', bars(1, 2, 3))).toEqual({
      inserted: 3,
      updated: 0,
      errors: 0,
    });
    expect(await marketDataService.storeCandlestickData(oanda, '1hour', bars(3, 4))).toEqual({
      inserted: 1,
      updated: 1,
      errors: 0,
    });
    await marketDataService.storeCandlestickData(mt5, '1hour', bars(1));

    const from = new Date(Date.UTC(2026, 0, 5));
    const to = new Date(Date.UTC(2026, 0, 6));
    const fromOanda = await marketDataService.getHistoricalData(symbol, '1hour', from, to, 'oanda');
    expect(fromOanda.map((b) => b.timestamp.getUTCHours())).toEqual([1, 2, 3, 4]);
    const fromMt5 = await marketDataService.getHistoricalData(symbol, '1hour', from, to, 'mt5');
    expect(fromMt5).toHaveLength(1);
  });

  it('stores the good bars when one bar in the batch is bad', async () => {
    const id = await marketDataService.getOrCreateContract({
      broker: 'oanda',
      symbol: sym('BAD'),
      secType: 'CASH',
    });
    const batch = bars(1, 2, 3);
    batch[1] = { ...batch[1], open: null as unknown as number };

    expect(await marketDataService.storeCandlestickData(id, '1hour', batch)).toEqual({
      inserted: 2,
      updated: 0,
      errors: 1,
    });
  });

  it('uploads under the broker it is given', async () => {
    const symbol = sym('UP');
    await marketDataService.uploadHistoricalData({
      broker: 'oanda',
      symbol,
      timeframe: '1day',
      bars: [
        {
          timestamp: Date.UTC(2026, 0, 5) / 1000,
          open: 1,
          high: 2,
          low: 0.5,
          close: 1.5,
          volume: 0,
        },
      ],
      account_mode: 'paper',
      secType: 'CASH',
      exchange: 'OANDA',
      currency: 'USD',
    });
    const rows = await dbService.query('SELECT broker FROM contracts WHERE symbol = $1', [symbol]);
    expect(rows.rows).toEqual([{ broker: 'oanda' }]);
  });

  it("lists collection configs with the contract's broker and account", async () => {
    const id = await marketDataService.getOrCreateContract({
      broker: 'oanda',
      brokerAccount: 'practice-1',
      symbol: sym('CFG'),
      secType: 'CASH',
    });
    await dbService.query(
      `INSERT INTO data_collection_config (contract_id, timeframe, enabled, auto_collect)
       VALUES ($1, '1hour', true, true)`,
      [id]
    );
    const configs = await marketDataService.getActiveCollectionConfigs({ autoCollectOnly: true });
    expect(configs.find((c) => c.contractId === id)).toMatchObject({
      broker: 'oanda',
      brokerAccount: 'practice-1',
    });
  });
});
