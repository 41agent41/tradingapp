/**
 * GET /api/market-data/depth: what it asks the broker service for and how it
 * passes the answer, or the reason there is none, back.
 */
import express from 'express';
import request from 'supertest';

jest.mock('axios');
import axios from 'axios';

import depthRoutes from '../src/routes/marketData/depth.js';

const get = axios.get as jest.Mock;

function app() {
  const a = express();
  a.use('/api/market-data', depthRoutes);
  return a;
}

describe('GET /api/market-data/depth', () => {
  beforeEach(() => get.mockReset());

  it('asks the named connection for the book and returns it', async () => {
    const book = {
      symbol: 'EURUSD',
      broker: 'ctrader',
      bids: [{ price: 1.1, size: 1000000 }],
      asks: [{ price: 1.1001, size: 500000 }],
    };
    get.mockResolvedValue({ data: book });
    const res = await request(app())
      .get('/api/market-data/depth')
      .query({ symbol: 'EURUSD', source: 'ctrader', account: 'demo', levels: '5' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(book);
    expect(get).toHaveBeenCalledWith(
      expect.stringMatching(/\/market-data\/depth$/),
      expect.objectContaining({
        params: { symbol: 'EURUSD', levels: 5, source: 'ctrader', account: 'demo' },
      })
    );
  });

  it('asks for 10 levels on the default connection when none is named', async () => {
    get.mockResolvedValue({ data: {} });
    await request(app()).get('/api/market-data/depth').query({ symbol: 'EURUSD', source: 'No!' });
    expect(get.mock.calls[0][1].params).toEqual({
      symbol: 'EURUSD',
      levels: 10,
      source: undefined,
      account: undefined,
    });
  });

  it('refuses a missing symbol and a level count out of range', async () => {
    const ask = (query: Record<string, string>) =>
      request(app()).get('/api/market-data/depth').query(query);
    expect((await ask({})).status).toBe(400);
    expect((await ask({ symbol: 'EUR USD' })).status).toBe(400);
    expect((await ask({ symbol: 'EURUSD', levels: '0' })).status).toBe(400);
    expect((await ask({ symbol: 'EURUSD', levels: '51' })).status).toBe(400);
    expect((await ask({ symbol: 'EURUSD', levels: '2.5' })).status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });

  it("passes on the broker service's reason when there is no book", async () => {
    get.mockRejectedValue({
      response: { status: 501, data: { detail: 'Depth of market is not available from oanda' } },
    });
    const res = await request(app()).get('/api/market-data/depth').query({ symbol: 'EURUSD' });
    expect(res.status).toBe(501);
    expect(res.body).toEqual({ error: 'Depth of market is not available from oanda' });
  });

  it('answers 502 when the broker service does not answer', async () => {
    get.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await request(app()).get('/api/market-data/depth').query({ symbol: 'EURUSD' });
    expect(res.status).toBe(502);
  });
});
