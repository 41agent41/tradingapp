/**
 * Integration tests for the /api/watchlist routes.
 *
 * WatchlistRepository (DB) is intercepted via jest.mock so the suite is
 * hermetic (mirrors strategies.route.test.ts).
 */
import express from 'express';
import request from 'supertest';

jest.mock('../src/services/database.js', () => ({
  dbService: { query: jest.fn() },
}));

const repoImpl = {
  list: jest.fn(),
  add: jest.fn(),
  remove: jest.fn(),
};
jest.mock('../src/services/watchlistRepository.js', () => ({
  __esModule: true,
  WatchlistRepository: jest.fn().mockImplementation(() => repoImpl),
}));

import watchlistRouter from '../src/routes/watchlist.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/watchlist', watchlistRouter);
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('GET /api/watchlist', () => {
  it('returns the list with a count', async () => {
    repoImpl.list.mockResolvedValue([{ id: 1, symbol: 'MSFT' }]);
    const res = await request(buildApp()).get('/api/watchlist');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.items[0].symbol).toBe('MSFT');
  });
});

describe('POST /api/watchlist', () => {
  it('400s without a symbol', async () => {
    const res = await request(buildApp()).post('/api/watchlist').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/symbol is required/i);
  });

  it('400s on an invalid broker', async () => {
    const res = await request(buildApp())
      .post('/api/watchlist')
      .send({ symbol: 'MSFT', broker: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid broker/i);
  });

  it('201s when newly added', async () => {
    repoImpl.add.mockResolvedValue({ added: true, row: { id: 1, symbol: 'MSFT' } });
    const res = await request(buildApp()).post('/api/watchlist').send({ symbol: 'msft' });
    expect(res.status).toBe(201);
    expect(res.body.symbol).toBe('MSFT');
    expect(repoImpl.add).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'msft', broker: 'ib' })
    );
  });

  it('200s when already present', async () => {
    repoImpl.add.mockResolvedValue({ added: false, row: { id: 1, symbol: 'MSFT' } });
    const res = await request(buildApp()).post('/api/watchlist').send({ symbol: 'MSFT' });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/watchlist/:id', () => {
  it('400s on a non-numeric id', async () => {
    const res = await request(buildApp()).delete('/api/watchlist/abc');
    expect(res.status).toBe(400);
  });

  it('404s when nothing matched', async () => {
    repoImpl.remove.mockResolvedValue({ removed: false });
    const res = await request(buildApp()).delete('/api/watchlist/999');
    expect(res.status).toBe(404);
  });

  it('204s when removed', async () => {
    repoImpl.remove.mockResolvedValue({ removed: true });
    const res = await request(buildApp()).delete('/api/watchlist/1');
    expect(res.status).toBe(204);
  });
});
