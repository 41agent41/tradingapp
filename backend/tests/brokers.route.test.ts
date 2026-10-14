/**
 * /api/brokers relays the broker service's connection checks.
 */
import express from 'express';
import request from 'supertest';

jest.mock('axios');
jest.mock('../src/services/brokerConnectionsRuntime.js', () => {
  const store = {
    list: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };
  const sync = { sync: jest.fn() };
  return { __esModule: true, brokerConnectionStore: store, brokerSync: sync };
});
jest.mock('../src/config/configService.js', () => {
  const actual = jest.requireActual('../src/config/configService.js');
  return {
    __esModule: true,
    SettingWriteError: actual.SettingWriteError,
    configService: { get: jest.fn(), source: jest.fn(() => 'unset'), set: jest.fn() },
  };
});

import axios from 'axios';
import brokersRouter from '../src/routes/brokers.js';

const axiosMock = axios as jest.Mocked<typeof axios>;
const runtime = jest.requireMock('../src/services/brokerConnectionsRuntime.js') as {
  brokerConnectionStore: Record<string, jest.Mock>;
  brokerSync: { sync: jest.Mock };
};
const config = jest.requireMock('../src/config/configService.js') as {
  configService: Record<string, jest.Mock>;
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/brokers', brokersRouter);
  return app;
}

describe('/api/brokers', () => {
  it('relays the status list', async () => {
    axiosMock.get.mockResolvedValue({ data: { default: 'oanda', connections: [] } });
    const res = await request(buildApp()).get('/api/brokers/status');
    expect(res.status).toBe(200);
    expect(res.body.default).toBe('oanda');
    expect(axiosMock.get.mock.calls[0][0]).toMatch(/\/connections\/status$/);
  });

  it('tests one connection', async () => {
    axiosMock.post.mockResolvedValue({
      data: { label: 'oanda:default', check: { status: 'connected' } },
    });
    const res = await request(buildApp()).post('/api/brokers/oanda:default/test');
    expect(res.status).toBe(200);
    expect(res.body.check.status).toBe('connected');
    expect(axiosMock.post.mock.calls[0][0]).toMatch(/\/connections\/oanda%3Adefault\/test$/);
  });

  it('refuses a label that is not platform:account', async () => {
    const res = await request(buildApp()).post('/api/brokers/..%2Fhealth/test');
    expect(res.status).toBe(400);
    expect(axiosMock.post).not.toHaveBeenCalled();
  });

  it("relays the broker service's error status", async () => {
    axiosMock.post.mockRejectedValue({
      response: { status: 404, data: { detail: 'No connection' } },
    });
    const res = await request(buildApp()).post('/api/brokers/mt5:nope/test');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No connection');
  });
});

describe('/api/brokers/connections', () => {
  const store = runtime.brokerConnectionStore;
  const ORIGINAL = process.env.TRADING_TOKENS;

  beforeEach(() => {
    jest.clearAllMocks();
    runtime.brokerSync.sync.mockResolvedValue({});
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.TRADING_TOKENS;
    else process.env.TRADING_TOKENS = ORIGINAL;
  });

  it('lists the app-added connections', async () => {
    store.list.mockResolvedValue([{ id: 1, label: 'oanda:practice' }]);
    const res = await request(buildApp()).get('/api/brokers/connections');
    expect(res.status).toBe(200);
    expect(res.body.connections[0].label).toBe('oanda:practice');
    expect(res.body.platforms).toEqual(['oanda', 'mt5', 'ib', 'alpaca']);
  });

  it('adds one and sends the set to the broker service', async () => {
    store.create.mockResolvedValue({ id: 1, label: 'oanda:practice' });
    const res = await request(buildApp())
      .post('/api/brokers/connections')
      .send({ platform: 'oanda', secrets: { token: 't' } });
    expect(res.status).toBe(201);
    expect(res.body.sync_error).toBeNull();
    expect(runtime.brokerSync.sync).toHaveBeenCalledWith(true);
  });

  it('reports a failed send with the save', async () => {
    store.update.mockResolvedValue({ id: 2, label: 'mt5:default' });
    runtime.brokerSync.sync.mockRejectedValue({ response: { data: { detail: 'bad entry' } } });
    const res = await request(buildApp()).put('/api/brokers/connections/2').send({});
    expect(res.status).toBe(200);
    expect(res.body.sync_error).toBe('bad entry');
  });

  it('needs the trader role to change connections', async () => {
    process.env.TRADING_TOKENS = 'secret-token';
    const res = await request(buildApp()).delete('/api/brokers/connections/2');
    expect(res.status).toBe(403);
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('rejects a bad id', async () => {
    const res = await request(buildApp()).delete('/api/brokers/connections/abc');
    expect(res.status).toBe(400);
  });

  it('saves the broker priority, completing the list', async () => {
    const res = await request(buildApp())
      .put('/api/brokers/priority')
      .send({ priority: ['alpaca', 'oanda'] });
    expect(res.status).toBe(200);
    expect(res.body.priority).toEqual(['alpaca', 'oanda', 'mt5', 'ib']);
    expect(config.configService.set).toHaveBeenCalledWith(
      'BROKER_PRIORITY',
      'alpaca,oanda,mt5,ib',
      expect.anything()
    );
  });

  it('rejects an unknown broker in the priority', async () => {
    const res = await request(buildApp())
      .put('/api/brokers/priority')
      .send({ priority: ['oanda', 'nope'] });
    expect(res.status).toBe(400);
  });
});
