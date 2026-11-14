/**
 * GET /api/market-data/sentiment: what it asks the broker service for and how
 * it passes the answer, or the reason there is none, back.
 */
import express from 'express';
import request from 'supertest';

jest.mock('axios');
import axios from 'axios';

import sentimentRoutes from '../src/routes/marketData/sentiment.js';

const get = axios.get as jest.Mock;

function app() {
  const a = express();
  a.use('/api/market-data', sentimentRoutes);
  return a;
}

describe('GET /api/market-data/sentiment', () => {
  beforeEach(() => get.mockReset());

  it('asks the named connection and returns its answer', async () => {
    const answer = { symbol: 'EUR.USD', broker: 'ig', long_pct: 62, short_pct: 38 };
    get.mockResolvedValue({ data: answer });
    const res = await request(app())
      .get('/api/market-data/sentiment')
      .query({ symbol: 'EUR.USD', source: 'ig', account: 'demo' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(answer);
    expect(get).toHaveBeenCalledWith(
      expect.stringMatching(/\/market-data\/sentiment$/),
      expect.objectContaining({ params: { symbol: 'EUR.USD', source: 'ig', account: 'demo' } })
    );
  });

  it('refuses a missing or malformed symbol', async () => {
    const ask = (query: Record<string, string>) =>
      request(app()).get('/api/market-data/sentiment').query(query);
    expect((await ask({})).status).toBe(400);
    expect((await ask({ symbol: 'EUR USD' })).status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });

  it("passes on the broker service's reason when there is none", async () => {
    get.mockRejectedValue({
      response: { status: 501, data: { detail: 'Client sentiment is not available from oanda' } },
    });
    const res = await request(app())
      .get('/api/market-data/sentiment')
      .query({ symbol: 'EUR.USD', source: 'Not valid' });
    expect(res.status).toBe(501);
    expect(res.body).toEqual({ error: 'Client sentiment is not available from oanda' });
    expect(get.mock.calls[0][1].params.source).toBeUndefined();
  });

  it('answers 502 when the broker service does not answer', async () => {
    get.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await request(app()).get('/api/market-data/sentiment').query({ symbol: 'EURUSD' });
    expect(res.status).toBe(502);
  });
});
