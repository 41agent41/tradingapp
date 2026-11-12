/**
 * The login sessions in force (S-05): what the store keeps, and that it
 * carries on when the database does not answer.
 */
import { SessionStore } from '../src/services/sessionStore.js';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 0, 5, 12);

function fakeDb(rows: Array<Record<string, unknown>> = []) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    calls,
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: /^\s*SELECT/i.test(sql) ? rows : [] };
    }),
  };
}

describe('SessionStore', () => {
  it('keeps a session in force until it expires', () => {
    const store = new SessionStore();
    const id = store.create(NOW + HOUR, {}, NOW);
    expect(id).toMatch(/^[0-9a-f]{48}$/);
    expect(store.isActive(id, NOW)).toBe(true);
    expect(store.isActive(id, NOW + HOUR)).toBe(false);
    expect(store.isActive('nope', NOW)).toBe(false);
    // Once seen expired it is gone for good.
    expect(store.list(null, NOW)).toEqual([]);
  });

  it('ends one session, or all of them', () => {
    const store = new SessionStore();
    const a = store.create(NOW + HOUR, {}, NOW);
    const b = store.create(NOW + HOUR, {}, NOW);
    expect(store.revoke(a)).toBe(true);
    expect(store.revoke(a)).toBe(false);
    expect(store.isActive(a, NOW)).toBe(false);
    expect(store.isActive(b, NOW)).toBe(true);

    store.create(NOW + HOUR, {}, NOW);
    expect(store.revokeAll()).toBe(2);
    expect(store.isActive(b, NOW)).toBe(false);
    expect(store.revokeAll()).toBe(0);
  });

  it('ends a session by its shown id only when given exactly that', () => {
    const store = new SessionStore();
    const id = store.create(NOW + HOUR, {}, NOW);
    expect(store.revokeByPublicId(id.slice(0, 4))).toBe(false);
    expect(store.revokeByPublicId('')).toBe(false);
    expect(store.revokeByPublicId(id)).toBe(false);
    expect(store.isActive(id, NOW)).toBe(true);
    expect(store.revokeByPublicId(id.slice(0, 12))).toBe(true);
    expect(store.isActive(id, NOW)).toBe(false);
  });

  it('lists sessions newest first without their full ids', () => {
    const store = new SessionStore();
    const old = store.create(NOW + HOUR, { ip: '10.0.0.5', userAgent: 'Firefox' }, NOW - 1000);
    const recent = store.create(NOW + HOUR, { ip: ' ', userAgent: 'x'.repeat(400) }, NOW);
    store.create(NOW - 1, {}, NOW - 5000); // already expired

    const list = store.list(old, NOW);
    expect(list.map((s) => s.id)).toEqual([recent.slice(0, 12), old.slice(0, 12)]);
    expect(list[1]).toEqual({
      id: old.slice(0, 12),
      created_at: new Date(NOW - 1000).toISOString(),
      expires_at: new Date(NOW + HOUR).toISOString(),
      ip: '10.0.0.5',
      user_agent: 'Firefox',
      current: true,
    });
    expect(list[0].current).toBe(false);
    expect(list[0].ip).toBeNull();
    expect(list[0].user_agent).toHaveLength(256);
  });

  it('writes each change through to the database', () => {
    const db = fakeDb();
    const store = new SessionStore();
    store.attach(db);
    const id = store.create(NOW + HOUR, { ip: '10.0.0.5' }, NOW);
    // Expired rows are cleared as a new one is stored.
    expect(db.calls[0].sql).toMatch(/DELETE FROM auth_sessions WHERE expires_at/);
    expect(db.calls[1].sql).toContain('INSERT INTO auth_sessions');
    expect(db.calls[1].params?.[0]).toBe(id);
    store.revoke(id);
    expect(db.calls[2]).toEqual({
      sql: 'DELETE FROM auth_sessions WHERE id = $1',
      params: [id],
    });
    store.revokeAll();
    expect(db.calls[3].sql).toBe('DELETE FROM auth_sessions');
  });

  it('reads the stored sessions at startup, leaving out expired ones', async () => {
    const db = fakeDb([
      {
        id: 'a'.repeat(48),
        created_at: new Date(NOW - HOUR),
        expires_at: new Date(NOW + HOUR),
        ip: '10.0.0.5',
        user_agent: 'Firefox',
      },
      {
        id: 'b'.repeat(48),
        created_at: new Date(NOW - 2 * HOUR),
        expires_at: new Date(NOW - 1),
        ip: null,
        user_agent: null,
      },
    ]);
    const store = new SessionStore();
    store.attach(db);
    const made = store.create(NOW + HOUR, {}, NOW);
    await store.start(NOW);

    expect(db.calls.some((c) => /DELETE FROM auth_sessions WHERE expires_at/.test(c.sql))).toBe(
      true
    );
    expect(store.isActive('a'.repeat(48), NOW)).toBe(true);
    expect(store.isActive('b'.repeat(48), NOW)).toBe(false);
    expect(store.isActive(made, NOW)).toBe(true);
    expect(store.list(null, NOW)).toHaveLength(2);
  });

  it('carries on in memory when the database does not answer', async () => {
    const store = new SessionStore();
    store.attach({ query: jest.fn().mockRejectedValue(new Error('down')) });
    await expect(store.start(NOW)).resolves.toBeUndefined();
    const id = store.create(NOW + HOUR, {}, NOW);
    expect(store.isActive(id, NOW)).toBe(true);
    expect(store.revoke(id)).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('tells listeners which sessions ended', () => {
    const store = new SessionStore();
    const seen: Array<string[] | 'all'> = [];
    const stop = store.onEnd((ended) => seen.push(ended));
    const a = store.create(NOW + HOUR, {}, NOW);
    const b = store.create(NOW + HOUR, {}, NOW);
    store.revoke(a);
    store.revokeByPublicId(b.slice(0, 12));
    store.revokeAll();
    expect(seen).toEqual([[a], [b], 'all']);

    stop();
    store.revokeAll();
    expect(seen).toHaveLength(3);
    // A listener that throws does not stop a session from ending.
    store.onEnd(() => {
      throw new Error('boom');
    });
    const c = store.create(NOW + HOUR, {}, NOW);
    expect(store.revoke(c)).toBe(true);
    expect(store.isActive(c, NOW)).toBe(false);
  });

  it('forgets expired sessions when a new one is made', () => {
    const store = new SessionStore();
    store.create(NOW + HOUR, {}, NOW);
    store.create(NOW + HOUR, {}, NOW);
    const later = NOW + 2 * HOUR;
    const fresh = store.create(later + HOUR, {}, later);
    // The two old ones are gone from memory, not only hidden from the list.
    expect((store as any).sessions.size).toBe(1);
    expect(store.isActive(fresh, later)).toBe(true);
  });

  it('does not bring back a session ended while the stored ones were being read', async () => {
    const row = (id: string) => ({
      id,
      created_at: new Date(NOW - HOUR),
      expires_at: new Date(NOW + HOUR),
      ip: null,
      user_agent: null,
    });
    const run = async (end: (store: SessionStore) => void) => {
      const store = new SessionStore();
      store.attach({
        query: jest.fn(async (sql: string) => {
          if (!/^\s*SELECT/i.test(sql)) return { rows: [] };
          // Sign-out arrives after the rows were read, before they are kept.
          end(store);
          return { rows: [row('a'.repeat(48)), row('b'.repeat(48))] };
        }),
      });
      await store.start(NOW);
      return store;
    };

    const one = await run((store) => store.revoke('a'.repeat(48)));
    expect(one.isActive('a'.repeat(48), NOW)).toBe(false);
    expect(one.isActive('b'.repeat(48), NOW)).toBe(true);

    const all = await run((store) => store.revokeAll());
    expect(all.list(null, NOW)).toEqual([]);

    // Afterwards the store is back to normal: a later load keeps its rows.
    const again = await run(() => undefined);
    expect(again.list(null, NOW)).toHaveLength(2);
  });

  it('works with no database attached', async () => {
    const store = new SessionStore();
    await store.start(NOW);
    const id = store.create(NOW + HOUR, {}, NOW);
    expect(store.isActive(id, NOW)).toBe(true);
  });
});
