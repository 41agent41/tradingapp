/**
 * Contract search, advanced search and symbol discovery proxy to the broker
 * service's real paths, and the contracts found are saved to the catalogue.
 */
import express from 'express';
import request from 'supertest';

jest.mock('axios');
jest.mock('../src/services/marketDataService.js', () => {
  const getOrCreateContract = jest.fn().mockResolvedValue(1);
  return {
    __esModule: true,
    marketDataService: { getOrCreateContract },
    __getOrCreateContract: getOrCreateContract,
  };
});

import axios from 'axios';
import searchRouter from '../src/routes/marketData/search.js';

const axiosMock = axios as jest.Mocked<typeof axios>;
const serviceMock = jest.requireMock('../src/services/marketDataService.js') as {
  __getOrCreateContract: jest.Mock;
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/market-data', searchRouter);
  return app;
}

const RESULTS = {
  results: [
    { conid: '265598', symbol: 'AAPL', secType: 'STK', exchange: 'SMART', currency: 'USD' },
    { conid: 'EUR_USD', symbol: 'EUR.USD', secType: 'CASH', exchange: '', currency: 'USD' },
  ],
  count: 2,
};

beforeEach(() => {
  axiosMock.post.mockReset();
  serviceMock.__getOrCreateContract.mockClear();
});

describe('market-data search routes', () => {
  it('basic search calls /contract/search and saves the results', async () => {
    axiosMock.post.mockResolvedValue({ data: RESULTS });
    const res = await request(buildApp())
      .post('/api/market-data/search')
      .set('x-data-query-enabled', 'true')
      .send({ symbol: 'AAPL', secType: 'STK', searchByName: true, broker: 'ib' });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    const [url, body] = axiosMock.post.mock.calls[0];
    expect(url).toMatch(/\/contract\/search$/);
    expect(body).toMatchObject({ symbol: 'AAPL', name: true, source: 'ib' });
    expect(serviceMock.__getOrCreateContract).toHaveBeenCalledTimes(2);
    expect(serviceMock.__getOrCreateContract.mock.calls[0][0]).toMatchObject({
      broker: 'ib',
      symbol: 'AAPL',
      contractId: 265598,
    });
    // A venue's instrument name is not a numeric contract id.
    expect(serviceMock.__getOrCreateContract.mock.calls[1][0].contractId).toBeUndefined();
  });

  it('advanced search calls /contract/advanced-search', async () => {
    axiosMock.post.mockResolvedValue({ data: RESULTS });
    const res = await request(buildApp())
      .post('/api/market-data/search/advanced')
      .set('x-data-query-enabled', 'true')
      .send({ symbol: 'ES', secType: 'FUT', expiry: '202612', broker: 'ib' });

    expect(res.status).toBe(200);
    const [url, body] = axiosMock.post.mock.calls[0];
    expect(url).toMatch(/\/contract\/advanced-search$/);
    expect(body).toMatchObject({ symbol: 'ES', secType: 'FUT', expiry: '202612', source: 'ib' });
  });

  it('symbol discovery calls /symbols/discover with the venue', async () => {
    axiosMock.post.mockResolvedValue({
      data: { results: RESULTS.results, method: 'venue_search', cached: false, count: 2 },
    });
    const res = await request(buildApp())
      .post('/api/market-data/symbols/discover')
      .set('x-data-query-enabled', 'true')
      .send({ pattern: 'aa', secType: 'STK', max_results: 20, broker: 'oanda' });

    expect(res.status).toBe(200);
    expect(res.body.method).toBe('venue_search');
    const [url, body] = axiosMock.post.mock.calls[0];
    expect(url).toMatch(/\/symbols\/discover$/);
    expect(body).toMatchObject({ pattern: 'aa', max_results: 20, source: 'oanda' });
  });

  it('symbol discovery with no pattern answers empty without calling out', async () => {
    const res = await request(buildApp())
      .post('/api/market-data/symbols/discover')
      .set('x-data-query-enabled', 'true')
      .send({ pattern: '  ' });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  it('symbol discovery passes the broker service status through', async () => {
    axiosMock.post.mockRejectedValue({
      response: { status: 503, data: { detail: 'IB Gateway connection is not available' } },
    });
    const res = await request(buildApp())
      .post('/api/market-data/symbols/discover')
      .set('x-data-query-enabled', 'true')
      .send({ pattern: 'aa' });
    expect(res.status).toBe(503);
    expect(res.body.message).toBe('IB Gateway connection is not available');
  });
});
