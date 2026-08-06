/**
 * Integration tests for the /api/alerts routes.
 *
 * PriceAlertRepository and WatchlistRepository (DB) are intercepted via
 * jest.mock so the suite is hermetic (mirrors watchlist.route.test.ts).
 */
import express from 'express';
import request from 'supertest';

jest.mock('../src/services/database.js', () => ({
  dbService: { query: jest.fn() },
}));

const alertsImpl = {
  list: jest.fn(),
  create: jest.fn(),
  find: jest.fn(),
  trigger: jest.fn(),
  dismiss: jest.fn(),
  remove: jest.fn(),
};
jest.mock('../src/services/priceAlertRepository.js', () => {
  const actual = jest.requireActual('../src/services/priceAlertRepository.js');
  return {
    __esModule: true,
    ...actual,
    PriceAlertRepository: jest.fn().mockImplementation(() => alertsImpl),
  };
});

const watchlistImpl = {
  find: jest.fn(),
};
jest.mock('../src/services/watchlistRepository.js', () => ({
  __esModule: true,
  WatchlistRepository: jest.fn().mockImplementation(() => watchlistImpl),
}));

import priceAlertsRouter from '../src/routes/priceAlerts.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/alerts', priceAlertsRouter);
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('GET /api/alerts', () => {
  it('400s on a non-numeric watchlist_item_id', async () => {
    const res = await request(buildApp()).get('/api/alerts?watchlist_item_id=abc');
    expect(res.status).toBe(400);
  });

  it('400s on an invalid status', async () => {
    const res = await request(buildApp()).get('/api/alerts?status=nope');
    expect(res.status).toBe(400);
  });

  it('lists alerts with a count', async () => {
    alertsImpl.list.mockResolvedValue([{ id: 1, status: 'active' }]);
    const res = await request(buildApp()).get('/api/alerts?watchlist_item_id=5&status=active');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(alertsImpl.list).toHaveBeenCalledWith({ watchlist_item_id: 5, status: 'active' });
  });
});

describe('POST /api/alerts', () => {
  it('400s without a watchlist_item_id', async () => {
    const res = await request(buildApp())
      .post('/api/alerts')
      .send({ condition: 'above', target_price: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/watchlist_item_id/i);
  });

  it('400s on an invalid condition', async () => {
    const res = await request(buildApp())
      .post('/api/alerts')
      .send({ watchlist_item_id: 1, condition: 'sideways', target_price: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid condition/i);
  });

  it('400s on a non-positive target_price', async () => {
    const res = await request(buildApp())
      .post('/api/alerts')
      .send({ watchlist_item_id: 1, condition: 'above', target_price: -5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/target_price/i);
  });

  it('404s when the watchlist item does not exist', async () => {
    watchlistImpl.find.mockResolvedValue(null);
    const res = await request(buildApp())
      .post('/api/alerts')
      .send({ watchlist_item_id: 999, condition: 'above', target_price: 100 });
    expect(res.status).toBe(404);
  });

  it('201s and creates the alert', async () => {
    watchlistImpl.find.mockResolvedValue({ id: 1, symbol: 'MSFT' });
    alertsImpl.create.mockResolvedValue({ id: 10, watchlist_item_id: 1, status: 'active' });
    const res = await request(buildApp())
      .post('/api/alerts')
      .send({ watchlist_item_id: 1, condition: 'above', target_price: 210 });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(10);
    expect(alertsImpl.create).toHaveBeenCalledWith({
      watchlist_item_id: 1,
      condition: 'above',
      target_price: 210,
    });
  });
});

describe('POST /api/alerts/:id/trigger', () => {
  it('400s without a numeric triggered_price', async () => {
    const res = await request(buildApp()).post('/api/alerts/1/trigger').send({});
    expect(res.status).toBe(400);
  });

  it('404s when the alert does not exist at all', async () => {
    alertsImpl.trigger.mockResolvedValue(null);
    alertsImpl.find.mockResolvedValue(null);
    const res = await request(buildApp())
      .post('/api/alerts/999/trigger')
      .send({ triggered_price: 210 });
    expect(res.status).toBe(404);
  });

  it('200s idempotently when already triggered', async () => {
    alertsImpl.trigger.mockResolvedValue(null);
    alertsImpl.find.mockResolvedValue({ id: 1, status: 'triggered' });
    const res = await request(buildApp())
      .post('/api/alerts/1/trigger')
      .send({ triggered_price: 210 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('triggered');
  });

  it('200s and returns the triggered row', async () => {
    alertsImpl.trigger.mockResolvedValue({ id: 1, status: 'triggered', triggered_price: '210' });
    const res = await request(buildApp())
      .post('/api/alerts/1/trigger')
      .send({ triggered_price: 210 });
    expect(res.status).toBe(200);
    expect(alertsImpl.trigger).toHaveBeenCalledWith(1, 210);
  });
});

describe('POST /api/alerts/:id/dismiss', () => {
  it('404s when missing', async () => {
    alertsImpl.dismiss.mockResolvedValue(null);
    const res = await request(buildApp()).post('/api/alerts/999/dismiss');
    expect(res.status).toBe(404);
  });

  it('200s and dismisses', async () => {
    alertsImpl.dismiss.mockResolvedValue({ id: 1, status: 'dismissed' });
    const res = await request(buildApp()).post('/api/alerts/1/dismiss');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('dismissed');
  });
});

describe('DELETE /api/alerts/:id', () => {
  it('400s on a non-numeric id', async () => {
    const res = await request(buildApp()).delete('/api/alerts/abc');
    expect(res.status).toBe(400);
  });

  it('404s when nothing matched', async () => {
    alertsImpl.remove.mockResolvedValue({ removed: false });
    const res = await request(buildApp()).delete('/api/alerts/999');
    expect(res.status).toBe(404);
  });

  it('204s when removed', async () => {
    alertsImpl.remove.mockResolvedValue({ removed: true });
    const res = await request(buildApp()).delete('/api/alerts/1');
    expect(res.status).toBe(204);
  });
});
