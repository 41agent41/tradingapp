/**
 * Integration tests for the orders proxy route.
 *
 * Mocks axios (the IB-service hop) and the DB layer so the gate / audit
 * / validation paths are fully exercised without touching either.
 */
import express from 'express';
import request from 'supertest';

jest.mock('axios');
jest.mock('../src/services/database.js', () => ({
  dbService: { query: jest.fn() },
}));
jest.mock('../src/services/orderAuditRepository.js', () => {
  const create = jest.fn();
  // update / list return promises in production; default them to resolved
  // so the route's `audit.update(...).catch(...)` chains don't blow up on a
  // bare jest.fn() returning undefined. (jest.clearAllMocks keeps these.)
  const update = jest.fn().mockResolvedValue(undefined);
  const list = jest.fn().mockResolvedValue([]);
  return {
    __esModule: true,
    OrderAuditRepository: jest.fn().mockImplementation(() => ({ create, update, list })),
    __mocks: { create, update, list },
  };
});

import axios from 'axios';
import ordersRouter from '../src/routes/orders.js';

const axiosMock = axios as jest.Mocked<typeof axios>;
const auditMock = jest.requireMock('../src/services/orderAuditRepository.js') as {
  __mocks: { create: jest.Mock; update: jest.Mock; list: jest.Mock };
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/orders', ordersRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.LIVE_TRADING_ENABLED;
});

describe('POST /api/orders — gate + validation', () => {
  it('returns 400 on a malformed payload (missing required fields)', async () => {
    const res = await request(buildApp()).post('/api/orders').send({ symbol: 'MSFT' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Validation/);
  });

  it('returns 403 when account_mode=live and LIVE_TRADING_ENABLED is false', async () => {
    const res = await request(buildApp()).post('/api/orders').send({
      symbol: 'MSFT', action: 'BUY', quantity: 1, order_type: 'MKT', account_mode: 'live',
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Live trading/);
    expect(auditMock.__mocks.create).not.toHaveBeenCalled();
  });

  it('lets a paper order through when LIVE_TRADING_ENABLED is false', async () => {
    auditMock.__mocks.create.mockResolvedValueOnce({ id: 7 });
    axiosMock.post.mockResolvedValueOnce({ data: { order_id: 42, status: 'submitted' } });

    const res = await request(buildApp()).post('/api/orders').send({
      symbol: 'MSFT', action: 'BUY', quantity: 1, order_type: 'MKT',
    });
    expect(res.status).toBe(201);
    expect(res.body.audit_id).toBe(7);
    expect(res.body.order_id).toBe(42);
    expect(auditMock.__mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'MSFT', operation: 'CREATE' }),
    );
    expect(auditMock.__mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, ib_order_id: 42, status: 'submitted' }),
    );
  });

  it('lets a live order through when LIVE_TRADING_ENABLED=true', async () => {
    process.env.LIVE_TRADING_ENABLED = 'true';
    auditMock.__mocks.create.mockResolvedValueOnce({ id: 8 });
    axiosMock.post.mockResolvedValueOnce({ data: { order_id: 43, status: 'submitted' } });

    const res = await request(buildApp()).post('/api/orders').send({
      symbol: 'MSFT', action: 'SELL', quantity: 1, order_type: 'MKT', account_mode: 'live',
    });
    expect(res.status).toBe(201);
    expect(axiosMock.post).toHaveBeenCalled();
  });

  it('refuses to forward the order if the audit insert fails', async () => {
    auditMock.__mocks.create.mockRejectedValueOnce(new Error('db down'));
    const res = await request(buildApp()).post('/api/orders').send({
      symbol: 'MSFT', action: 'BUY', quantity: 1, order_type: 'MKT',
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/record order attempt/i);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  it('marks the audit row rejected when the IB service errors out', async () => {
    auditMock.__mocks.create.mockResolvedValueOnce({ id: 9 });
    axiosMock.post.mockRejectedValueOnce({
      response: { status: 503, statusText: 'service unavailable', data: { detail: 'no connection' } },
    });
    const res = await request(buildApp()).post('/api/orders').send({
      symbol: 'MSFT', action: 'BUY', quantity: 1, order_type: 'MKT',
    });
    expect(res.status).toBe(503);
    expect(auditMock.__mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 9, status: 'rejected' }),
    );
  });
});

describe('DELETE /api/orders/:id', () => {
  it('400s when the id is not a positive integer', async () => {
    const res = await request(buildApp()).delete('/api/orders/abc');
    expect(res.status).toBe(400);
  });

  it('forwards to the IB service and returns its payload', async () => {
    const { dbService } = jest.requireMock('../src/services/database.js') as { dbService: { query: jest.Mock } };
    dbService.query.mockResolvedValueOnce({ rows: [{ id: 10 }] });
    axiosMock.delete.mockResolvedValueOnce({ data: { order_id: 42, status: 'cancel_requested' } });
    const res = await request(buildApp()).delete('/api/orders/42');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancel_requested');
    expect(auditMock.__mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 10, status: 'cancel_requested' }),
    );
  });
});

describe('PUT /api/orders/:id — modify', () => {
  it('400s when the id is not a positive integer', async () => {
    const res = await request(buildApp()).put('/api/orders/abc').send({
      symbol: 'MSFT', action: 'BUY', quantity: 1, order_type: 'MKT',
    });
    expect(res.status).toBe(400);
  });

  it('400s on a malformed payload', async () => {
    const res = await request(buildApp()).put('/api/orders/42').send({ symbol: 'MSFT' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Validation/);
    expect(auditMock.__mocks.create).not.toHaveBeenCalled();
  });

  it('403s for a live modify when LIVE_TRADING_ENABLED is false', async () => {
    const res = await request(buildApp()).put('/api/orders/42').send({
      symbol: 'MSFT', action: 'BUY', quantity: 1, order_type: 'MKT', account_mode: 'live',
    });
    expect(res.status).toBe(403);
    expect(auditMock.__mocks.create).not.toHaveBeenCalled();
  });

  it('writes a MODIFY audit row tied to the ib_order_id, then forwards', async () => {
    auditMock.__mocks.create.mockResolvedValueOnce({ id: 11 });
    axiosMock.put.mockResolvedValueOnce({ data: { order_id: 42, status: 'modify_requested' } });

    const res = await request(buildApp()).put('/api/orders/42').send({
      symbol: 'MSFT', action: 'BUY', quantity: 5, order_type: 'LMT', limit_price: 100,
    });

    expect(res.status).toBe(200);
    expect(res.body.audit_id).toBe(11);
    expect(auditMock.__mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'MSFT', operation: 'MODIFY', quantity: 5 }),
    );
    expect(auditMock.__mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 11, ib_order_id: 42 }),
    );
    expect(auditMock.__mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 11, status: 'modify_requested' }),
    );
  });

  it('refuses to forward the modify if the audit insert fails', async () => {
    auditMock.__mocks.create.mockRejectedValueOnce(new Error('db down'));
    const res = await request(buildApp()).put('/api/orders/42').send({
      symbol: 'MSFT', action: 'BUY', quantity: 1, order_type: 'MKT',
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/record order modification/i);
    expect(axiosMock.put).not.toHaveBeenCalled();
  });

  it('marks the audit row rejected when the IB service errors out', async () => {
    auditMock.__mocks.create.mockResolvedValueOnce({ id: 12 });
    axiosMock.put.mockRejectedValueOnce({
      response: { status: 503, statusText: 'service unavailable', data: { detail: 'no connection' } },
    });
    const res = await request(buildApp()).put('/api/orders/42').send({
      symbol: 'MSFT', action: 'BUY', quantity: 1, order_type: 'MKT',
    });
    expect(res.status).toBe(503);
    expect(auditMock.__mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 12, status: 'rejected' }),
    );
  });
});

describe('GET /api/orders/audit', () => {
  it('returns the repository rows as { orders, count }', async () => {
    auditMock.__mocks.list.mockResolvedValueOnce([
      { id: 1, symbol: 'MSFT' },
      { id: 2, symbol: 'AAPL' },
    ]);
    const res = await request(buildApp()).get('/api/orders/audit');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.orders).toHaveLength(2);
  });
});
