/**
 * GET /api/market-data/ticks: what it asks the broker service for and how it
 * passes the answer, or the reason there is none, back.
 */
import express from 'express';
import request from 'supertest';

jest.mock('axios');
import axios from 'axios';

import tickRoutes from '../src/routes/marketData/ticks.js';

const get = axios.get as jest.Mock;

function app() {
  const a = express();
  a.use('/api/market-data', tickRoutes);
  return a;
}
const ask = (query: Record<string, string>) =>
  request(app()).get('/api/market-data/ticks').query(query);

describe('GET /api/market-data/ticks', () => {
  beforeEach(() => get.mockReset());

  it('asks the named connection for the window and returns its ticks', async () => {
    const answer = {
      symbol: 'EURUSD',
      broker: 'ctrader',
      ticks: [{ time: 1767571200250, bid: 1.1, ask: 1.1001, last: null }],
      count: 1,
      complete: true,
    };
    get.mockResolvedValue({ data: answer });
    const res = await ask({
      symbol: 'EURUSD',
      source: 'ctrader',
      account: 'demo',
      start: '2026-01-05T00:00:00Z',
      end: '2026-01-05T02:00:00+01:00',
      limit: '200',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(answer);
    expect(get).toHaveBeenCalledWith(
      expect.stringMatching(/\/market-data\/ticks$/),
      expect.objectContaining({
        params: {
          symbol: 'EURUSD',
          start: '2026-01-05T00:00:00.000Z',
          end: '2026-01-05T01:00:00.000Z',
          limit: 200,
          source: 'ctrader',
          account: 'demo',
        },
      })
    );
  });

  it('leaves the end to the broker service and asks for 5000 by default', async () => {
    get.mockResolvedValue({ data: {} });
    await ask({ symbol: 'EURUSD', start: '2026-01-05T00:00:00Z' });
    expect(get.mock.calls[0][1].params).toEqual({
      symbol: 'EURUSD',
      start: '2026-01-05T00:00:00.000Z',
      end: undefined,
      limit: 5000,
      source: undefined,
      account: undefined,
    });
  });

  it('refuses a bad symbol, time, window or limit', async () => {
    const start = '2026-01-05T00:00:00Z';
    expect((await ask({ start })).status).toBe(400);
    expect((await ask({ symbol: 'EURUSD' })).status).toBe(400);
    expect((await ask({ symbol: 'EURUSD', start: 'yesterday' })).status).toBe(400);
    expect((await ask({ symbol: 'EURUSD', start, end: 'later' })).status).toBe(400);
    expect((await ask({ symbol: 'EURUSD', start, end: start })).status).toBe(400);
    expect((await ask({ symbol: 'EURUSD', start, limit: '0' })).status).toBe(400);
    expect((await ask({ symbol: 'EURUSD', start, limit: '50001' })).status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });

  it("passes on the broker service's reason when there are none", async () => {
    get.mockRejectedValue({
      response: { status: 501, data: { detail: 'Tick history is not available from oanda' } },
    });
    const res = await ask({ symbol: 'EURUSD', start: '2026-01-05T00:00:00Z' });
    expect(res.status).toBe(501);
    expect(res.body).toEqual({ error: 'Tick history is not available from oanda' });
  });

  it('answers 502 when the broker service does not answer', async () => {
    get.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await ask({ symbol: 'EURUSD', start: '2026-01-05T00:00:00Z' });
    expect(res.status).toBe(502);
  });
});
