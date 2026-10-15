/**
 * MarketDataService — broker-scoped contract catalogue (B1 leftover).
 *
 * Mocks the shared dbService so getOrCreateContract's flow and
 * getDataCollectionStats' SQL can be asserted without Postgres.
 */
jest.mock('../src/services/database.js', () => {
  const client = { query: jest.fn() };
  return {
    client,
    dbService: {
      query: jest.fn(),
      transaction: jest.fn(async (fn: (c: typeof client) => unknown) => fn(client)),
    },
  };
});

import { MarketDataService } from '../src/services/marketDataService.js';

const dbMock = jest.requireMock('../src/services/database.js') as {
  client: { query: jest.Mock };
  dbService: { query: jest.Mock; transaction: jest.Mock };
};

beforeEach(() => jest.clearAllMocks());

// The SQL itself runs against Postgres in marketDataStorage.db.test.ts.
describe('getOrCreateContract', () => {
  it('looks the contract up by broker first and inserts it when missing', async () => {
    dbMock.client.query
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [] }) // lookup: not there
      .mockResolvedValueOnce({ rows: [{ id: 5 }] }); // insert
    const svc = new MarketDataService();
    const id = await svc.getOrCreateContract({ broker: 'mt5', symbol: 'EURUSD', secType: 'CASH' });
    expect(id).toBe(5);

    const [lookupSql, lookupParams] = dbMock.client.query.mock.calls[1];
    expect(lookupSql).toMatch(/expiry IS NOT DISTINCT FROM/);
    expect(lookupParams.slice(0, 3)).toEqual(['mt5', 'default', 'EURUSD']);
    const [insertSql] = dbMock.client.query.mock.calls[2];
    expect(insertSql).toMatch(/INSERT INTO contracts \(broker, broker_account, symbol/);
  });

  it('returns the existing contract without inserting', async () => {
    dbMock.client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 9 }] })
      .mockResolvedValueOnce({ rows: [] }); // detail update
    const id = await new MarketDataService().getOrCreateContract({
      broker: 'ib',
      symbol: 'MSFT',
      secType: 'STK',
    });
    expect(id).toBe(9);
    expect(dbMock.client.query.mock.calls.some(([sql]) => /INSERT/.test(sql))).toBe(false);
  });

  it('defaults broker to the priority default when unspecified', async () => {
    dbMock.client.query.mockResolvedValue({ rows: [{ id: 1 }] });
    await new MarketDataService().getOrCreateContract({ symbol: 'MSFT', secType: 'STK' });
    expect(dbMock.client.query.mock.calls[1][1][0]).toBe('oanda');
  });
});

describe('getDataCollectionStats', () => {
  it('selects + groups by broker and filters on it when given', async () => {
    dbMock.dbService.query.mockResolvedValueOnce({ rows: [] });
    await new MarketDataService().getDataCollectionStats('MSFT', 'mt5');
    const [sql, params] = dbMock.dbService.query.mock.calls[0];
    expect(sql).toMatch(/c\.broker/);
    expect(sql).toMatch(/GROUP BY c\.broker, c\.symbol, cd\.timeframe/);
    expect(sql).toMatch(/c\.broker = \$2/);
    expect(params).toEqual(['MSFT', 'mt5']);
  });

  it('omits the broker filter when not given', async () => {
    dbMock.dbService.query.mockResolvedValueOnce({ rows: [] });
    await new MarketDataService().getDataCollectionStats();
    const [sql, params] = dbMock.dbService.query.mock.calls[0];
    expect(sql).not.toMatch(/WHERE/);
    expect(params).toEqual([]);
  });
});
