/**
 * The startup gate: nothing that needs the database starts before it is
 * reachable, migrated and opened by the encryption key.
 *
 * Migrations and the key check are mocked here; both run against a real
 * TimescaleDB in startup.db.test.ts.
 */
jest.mock('../src/services/migrations.js', () => ({
  runMigrations: jest.fn(),
}));
jest.mock('../src/services/keyCheck.js', () => ({
  checkEncryptionKey: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import { StartupGate } from '../src/services/startupGate.js';

const migrations = jest.requireMock('../src/services/migrations.js') as {
  runMigrations: jest.Mock;
};
const keyCheck = jest.requireMock('../src/services/keyCheck.js') as {
  checkEncryptionKey: jest.Mock;
};

function fakeDb(connectAfter = 0) {
  let calls = 0;
  const release = jest.fn();
  return {
    release,
    testConnection: jest.fn(async () => ++calls > connectAfter),
    getClient: jest.fn(async () => ({ release }) as any),
    query: jest.fn(),
  };
}

beforeEach(() => {
  migrations.runMigrations.mockResolvedValue({ applied: [], current: ['000_baseline'] });
  keyCheck.checkEncryptionKey.mockResolvedValue({ ok: true });
});

describe('StartupGate.run', () => {
  it('waits for the database with growing delays, then migrates and becomes ready', async () => {
    const db = fakeDb(3);
    const sleeps: number[] = [];
    const gate = new StartupGate(db, {
      initialDelayMs: 100,
      maxDelayMs: 300,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const ready = jest.fn();
    gate.onReady(ready);

    const status = await gate.run();

    expect(sleeps).toEqual([100, 200, 300]);
    expect(status).toMatchObject({ state: 'ready', ready: true, attempts: 4 });
    expect(migrations.runMigrations).toHaveBeenCalledTimes(1);
    expect(db.release).toHaveBeenCalled();
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('stays not ready, with the reason, when a migration fails', async () => {
    migrations.runMigrations.mockRejectedValue(new Error('relation "x" does not exist'));
    const gate = new StartupGate(fakeDb(), { sleep: async () => undefined });
    const ready = jest.fn();
    gate.onReady(ready);

    const status = await gate.run();

    expect(status.state).toBe('migration_failed');
    expect(status.detail).toMatch(/relation "x" does not exist/);
    expect(ready).not.toHaveBeenCalled();
    expect(keyCheck.checkEncryptionKey).not.toHaveBeenCalled();
  });

  it('stays not ready when the encryption key does not open the database', async () => {
    keyCheck.checkEncryptionKey.mockResolvedValue({ ok: false, reason: 'wrong key' });
    const gate = new StartupGate(fakeDb(), { sleep: async () => undefined });

    const status = await gate.run();

    expect(status).toMatchObject({ state: 'key_mismatch', ready: false, detail: 'wrong key' });
  });

  it('runs a listener added after it is ready straight away', async () => {
    const gate = new StartupGate(fakeDb(), { sleep: async () => undefined });
    await gate.run();
    const late = jest.fn();
    gate.onReady(late);
    expect(late).toHaveBeenCalledTimes(1);
  });
});

describe('StartupGate.middleware', () => {
  function appWith(gate: StartupGate) {
    const app = express();
    app.use(gate.middleware());
    app.get('/api/health', (_req, res) => res.json({ ok: true }));
    app.get('/api/health/ready', (_req, res) => res.json({ ok: true }));
    app.get('/api/settings', (_req, res) => res.json({ ok: true }));
    app.get('/metrics', (_req, res) => res.send('ok'));
    return app;
  }

  it('answers 503 with the reason for API routes until ready, but not for health', async () => {
    const gate = new StartupGate(fakeDb(Infinity), { sleep: async () => undefined });
    const app = appWith(gate);

    const blocked = await request(app).get('/api/settings');
    expect(blocked.status).toBe(503);
    expect(blocked.body.startup.state).toBe('waiting_for_database');

    expect((await request(app).get('/api/health')).status).toBe(200);
    expect((await request(app).get('/api/health/ready')).status).toBe(200);
    expect((await request(app).get('/metrics')).status).toBe(200);
  });

  it('lets everything through once ready', async () => {
    const gate = new StartupGate(fakeDb(), { sleep: async () => undefined });
    await gate.run();
    expect((await request(appWith(gate)).get('/api/settings')).status).toBe(200);
  });
});
