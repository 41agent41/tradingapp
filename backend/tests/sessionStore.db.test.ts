/**
 * The session store against a real database (S-05): sessions written by one
 * process are in force in the next. Runs only with DB_TESTS=1.
 */
import fs from 'fs';
import path from 'path';

import { Pool } from 'pg';

import { SessionStore } from '../src/services/sessionStore.js';

const run = process.env.DB_TESTS === '1' ? describe : describe.skip;
const HOUR = 3_600_000;

run('SessionStore with a database', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
    });
    const migration = path.join(__dirname, '../src/database/migrations/010_auth_sessions.sql');
    await pool.query(fs.readFileSync(migration, 'utf8'));
    await pool.query('DELETE FROM auth_sessions');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM auth_sessions');
    await pool.end();
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

  it('keeps sessions across a restart and forgets ended ones', async () => {
    const first = new SessionStore();
    first.attach(pool);
    await first.start();
    const kept = first.create(Date.now() + HOUR, { ip: '10.0.0.5', userAgent: 'Firefox' });
    const ended = first.create(Date.now() + HOUR);
    const stale = first.create(Date.now() - 1000);
    await settle();
    first.revoke(ended);
    await settle();

    const second = new SessionStore();
    second.attach(pool);
    await second.start();
    expect(second.isActive(kept)).toBe(true);
    expect(second.isActive(ended)).toBe(false);
    expect(second.isActive(stale)).toBe(false);
    expect(second.list(kept)).toEqual([
      expect.objectContaining({ ip: '10.0.0.5', user_agent: 'Firefox', current: true }),
    ]);
    // Startup also clears the expired row.
    const { rows } = await pool.query('SELECT id FROM auth_sessions');
    expect(rows.map((r) => r.id)).toEqual([kept]);

    second.revokeAll();
    await settle();
    const third = new SessionStore();
    third.attach(pool);
    await third.start();
    expect(third.list(null)).toEqual([]);
  });
});
