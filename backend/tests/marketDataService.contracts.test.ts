/**
 * MarketDataService — broker-scoped contract catalogue (B1 leftover).
 *
 * Mocks the shared dbService so the SQL for getOrCreateContract +
 * getDataCollectionStats can be asserted without Postgres.
 */
jest.mock('../src/services/database.js', () => ({
  dbService: { query: jest.fn() },
}));

import { MarketDataService } from '../src/services/marketDataService.js';

const dbMock = jest.requireMock('../src/services/database.js') as {
  dbService: { query: jest.Mock };
};

beforeEach(() => jest.clearAllMocks());

describe('getOrCreateContract', () => {
  it('inserts broker as the first column and keys the conflict on broker', async () => {
    dbMock.dbService.query.mockResolvedValueOnce({ rows: [{ id: 5 }] });
    const svc = new MarketDataService();
    const id = await svc.getOrCreateContract({ broker: 'mt5', symbol: 'EURUSD', secType: 'CASH' });
    expect(id).toBe(5);

    const [sql, params] = dbMock.dbService.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO contracts \(broker, symbol/);
    expect(sql).toMatch(
      /ON CONFLICT \(broker, symbol, sec_type, exchange, currency, expiry, strike, right\)/
    );
    expect(params[0]).toBe('mt5'); // broker is $1
    expect(params[1]).toBe('EURUSD'); // symbol is $2
  });

  it('defaults broker to ib when unspecified', async () => {
    dbMock.dbService.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    await new MarketDataService().getOrCreateContract({ symbol: 'MSFT', secType: 'STK' });
    expect(dbMock.dbService.query.mock.calls[0][1][0]).toBe('ib');
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
