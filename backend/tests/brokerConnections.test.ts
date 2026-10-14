/**
 * Broker connections added on the Settings page: validation, secrets sealed
 * and never returned, defaults, audit, and the set sent to the broker service.
 */
import { BrokerConnectionError, BrokerConnectionStore } from '../src/services/brokerConnections.js';
import { BrokerSync, buildPayload } from '../src/services/brokerSync.js';

const KEY = 'a'.repeat(64);

/** Just enough of Postgres for the store's statements. */
function fakeDb() {
  let nextId = 1;
  const rows: any[] = [];
  const audit: any[] = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('CREATE TABLE')) return { rows: [] };
    if (s.startsWith('INSERT INTO settings_audit')) {
      audit.push(params);
      return { rows: [] };
    }
    if (s.startsWith('INSERT INTO broker_connections')) {
      const [platform, account, account_mode, currency, is_default, settings, ciphertext, by] =
        params;
      if (rows.some((r) => r.platform === platform && r.account === account)) {
        throw Object.assign(new Error('duplicate'), { code: '23505' });
      }
      const row = {
        id: nextId++,
        platform,
        account,
        account_mode,
        currency,
        is_default,
        settings: JSON.parse(settings),
        ciphertext,
        updated_at: new Date(),
        updated_by: by,
      };
      rows.push(row);
      return { rows: [row] };
    }
    if (s.startsWith('UPDATE broker_connections SET is_default = FALSE')) {
      rows.forEach((r) => {
        if (r.platform === params[0] && r.id !== params[1]) r.is_default = false;
      });
      return { rows: [] };
    }
    if (s.startsWith('UPDATE broker_connections')) {
      const row = rows.find((r) => r.id === params[0]);
      Object.assign(row, {
        account_mode: params[1],
        currency: params[2],
        is_default: params[3],
        settings: JSON.parse(params[4]),
        ciphertext: params[5],
        updated_by: params[6],
      });
      return { rows: [row] };
    }
    if (s.startsWith('DELETE FROM broker_connections')) {
      rows.splice(
        rows.findIndex((r) => r.id === params[0]),
        1
      );
      return { rows: [] };
    }
    if (s.includes('WHERE id = $1')) return { rows: rows.filter((r) => r.id === params[0]) };
    if (s.startsWith('SELECT')) return { rows: [...rows] };
    throw new Error(`unexpected SQL: ${s}`);
  });
  return { db: { query }, rows, audit };
}

const ctx = { actor: 'browser', ip: '10.0.0.1' };
const OANDA = {
  platform: 'oanda',
  account: 'practice',
  settings: { account_id: '101-001' },
  secrets: { token: 'tok-123' },
};

describe('BrokerConnectionStore', () => {
  it('stores secrets sealed and never returns them', async () => {
    const { db, rows, audit } = fakeDb();
    const store = new BrokerConnectionStore(db, { SETTINGS_ENCRYPTION_KEY: KEY });
    const view = await store.create(OANDA, ctx);

    expect(view.label).toBe('oanda:practice');
    expect(view.secrets_set).toEqual({ token: true });
    expect(JSON.stringify(view)).not.toContain('tok-123');
    expect(rows[0].ciphertext).toMatch(/^v1:/);
    expect(rows[0].ciphertext).not.toContain('tok-123');
    expect(audit[0][0]).toBe('broker_connection:oanda:practice');
    expect(JSON.stringify(audit)).not.toContain('tok-123');

    const [entry] = await store.managedEntries();
    expect(entry).toMatchObject({
      id: 'practice',
      platform: 'oanda',
      token: 'tok-123',
      account_id: '101-001',
      environment: 'practice',
    });
  });

  it('refuses credentials without an encryption key', async () => {
    const { db } = fakeDb();
    const store = new BrokerConnectionStore(db, {});
    await expect(store.create(OANDA, ctx)).rejects.toMatchObject({ status: 409 });
  });

  it('allows a connection with no secrets without a key (IB)', async () => {
    const { db } = fakeDb();
    const store = new BrokerConnectionStore(db, {});
    const view = await store.create(
      { platform: 'ib', settings: { host: '10.0.0.5', port: '4002' } },
      ctx
    );
    expect(view.label).toBe('ib:default');
    expect(view.settings).toEqual({ host: '10.0.0.5', port: '4002' });
  });

  it.each([
    [{ platform: 'nope' }, /Broker must be one of/],
    [{ platform: 'oanda', account: 'Bad Name' }, /Name must be/],
    [{ ...OANDA, account_mode: 'demo' }, /paper or live/],
    [{ platform: 'oanda', settings: { account_id: '1' } }, /needs: token/],
    [{ platform: 'mt5', settings: { url: 'ftp://x' } }, /http/],
    [{ platform: 'ib', settings: { host: 'h', port: 'abc' } }, /whole number/],
  ])('rejects %j', async (input, message) => {
    const { db } = fakeDb();
    const store = new BrokerConnectionStore(db, { SETTINGS_ENCRYPTION_KEY: KEY });
    await expect(store.create(input as any, ctx)).rejects.toThrow(message);
    await expect(store.create(input as any, ctx)).rejects.toBeInstanceOf(BrokerConnectionError);
  });

  it('keeps stored secrets when an update leaves them blank', async () => {
    const { db } = fakeDb();
    const store = new BrokerConnectionStore(db, { SETTINGS_ENCRYPTION_KEY: KEY });
    const created = await store.create(OANDA, ctx);
    await store.update(
      created.id,
      { account_mode: 'live', settings: { account_id: '101-002' }, secrets: { token: '' } },
      ctx
    );
    const [entry] = await store.managedEntries();
    expect(entry).toMatchObject({
      token: 'tok-123',
      account_id: '101-002',
      account_mode: 'live',
      environment: 'live',
    });
  });

  it('keeps one default per platform', async () => {
    const { db } = fakeDb();
    const store = new BrokerConnectionStore(db, { SETTINGS_ENCRYPTION_KEY: KEY });
    await store.create({ ...OANDA, is_default: true }, ctx);
    await store.create({ ...OANDA, account: 'live', is_default: true }, ctx);
    const list = await store.list();
    expect(list.filter((c) => c.is_default).map((c) => c.account)).toEqual(['live']);
  });

  it('refuses a duplicate and removes one', async () => {
    const { db } = fakeDb();
    const store = new BrokerConnectionStore(db, { SETTINGS_ENCRYPTION_KEY: KEY });
    const created = await store.create(OANDA, ctx);
    await expect(store.create(OANDA, ctx)).rejects.toMatchObject({ status: 409 });
    await store.remove(created.id, ctx);
    expect(await store.list()).toEqual([]);
    await expect(store.remove(created.id, ctx)).rejects.toMatchObject({ status: 404 });
  });

  it('leaves out a row whose secrets cannot be decrypted', async () => {
    const { db } = fakeDb();
    await new BrokerConnectionStore(db, { SETTINGS_ENCRYPTION_KEY: KEY }).create(OANDA, ctx);
    const other = new BrokerConnectionStore(db, { SETTINGS_ENCRYPTION_KEY: 'b'.repeat(64) });
    expect(await other.managedEntries()).toEqual([]);
    expect((await other.list())[0].secret_error).toMatch(/could not be decrypted/);
  });
});

describe('BrokerSync', () => {
  it('sends the set only when the broker service has another revision', async () => {
    const { db } = fakeDb();
    const store = new BrokerConnectionStore(db, { SETTINGS_ENCRYPTION_KEY: KEY });
    await store.create(OANDA, ctx);
    const { revision } = await buildPayload(store);

    const http = {
      get: jest.fn().mockResolvedValue({ data: { providers: { managed: { revision } } } }),
      put: jest.fn().mockResolvedValue({ data: { connections: ['oanda:practice'] } }),
    };
    const sync = new BrokerSync(store, 'http://broker', http);
    expect(await sync.sync()).toBeNull();
    expect(http.put).not.toHaveBeenCalled();

    http.get.mockResolvedValue({ data: { providers: { managed: { revision: null } } } });
    await sync.sync();
    expect(http.put).toHaveBeenCalledWith(
      'http://broker/connections/managed',
      expect.objectContaining({
        revision,
        connections: [expect.objectContaining({ token: 'tok-123' })],
      }),
      expect.anything()
    );
  });

  it('changes the revision when the set changes', async () => {
    const { db } = fakeDb();
    const store = new BrokerConnectionStore(db, { SETTINGS_ENCRYPTION_KEY: KEY });
    const empty = await buildPayload(store);
    await store.create(OANDA, ctx);
    expect((await buildPayload(store)).revision).not.toBe(empty.revision);
  });

  it('check() never throws', async () => {
    const { db } = fakeDb();
    const store = new BrokerConnectionStore(db, {});
    const http = { get: jest.fn().mockRejectedValue(new Error('down')), put: jest.fn() };
    await expect(new BrokerSync(store, 'http://broker', http).check()).resolves.toBeUndefined();
  });
});
