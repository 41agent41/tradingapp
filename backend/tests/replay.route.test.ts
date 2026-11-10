/**
 * GET /api/market-data/replay: what it asks the stored-bars reader for and
 * how it answers. The reader itself is tested against a real database in
 * backtestData.db.test.ts.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../src/services/storedBars.js', () => ({
  storedBars: { replay: jest.fn() },
}));
jest.mock('../src/services/orderTypes.js', () => ({
  ...jest.requireActual('../src/services/orderTypes.js'),
  defaultBroker: () => 'oanda',
}));

import replayRoutes from '../src/routes/marketData/replay.js';
import { storedBars } from '../src/services/storedBars.js';
import { BacktestDataError } from '../src/services/backtestData.js';

const replay = storedBars.replay as jest.Mock;

function app() {
  const a = express();
  a.use('/api/market-data', replayRoutes);
  return a;
}

describe('GET /api/market-data/replay', () => {
  beforeEach(() => replay.mockReset());

  it('asks for the instrument, timeframe and start, and returns the bars', async () => {
    const bars = { contract_id: 7, minutes: { t: [1] }, history: { t: [] }, more: false };
    replay.mockResolvedValue(bars);
    const res = await request(app()).get('/api/market-data/replay').query({
      symbol: 'eurusd',
      source: 'mt5',
      account: 'Demo',
      secType: 'cash',
      timeframe: '1hour',
      start: '2026-01-05T08:00:00Z',
      limit: '500',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(bars);
    expect(replay).toHaveBeenCalledWith(
      { broker: 'mt5', account: 'demo', symbol: 'EURUSD', secType: 'CASH' },
      '1hour',
      new Date('2026-01-05T08:00:00Z'),
      500
    );
  });

  it('refuses a request without a symbol, a start or a sensible limit', async () => {
    const get = (query: Record<string, string>) =>
      request(app()).get('/api/market-data/replay').query(query);
    expect((await get({ start: '2026-01-05' })).status).toBe(400);
    expect((await get({ symbol: 'EURUSD' })).status).toBe(400);
    expect((await get({ symbol: 'EURUSD', start: 'yesterday-ish' })).status).toBe(400);
    expect((await get({ symbol: 'EURUSD', start: '2026-01-05', limit: '0' })).status).toBe(400);
    expect(replay).not.toHaveBeenCalled();
  });

  it("answers with the reader's own message when nothing is stored", async () => {
    replay.mockRejectedValue(new BacktestDataError('No 1 minute bars are stored for X.', 404));
    const res = await request(app())
      .get('/api/market-data/replay')
      .query({ symbol: 'X', start: '2026-01-05' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No 1 minute bars are stored for X.');
  });
});
