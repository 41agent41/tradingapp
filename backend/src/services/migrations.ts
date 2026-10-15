/**
 * Brings the database schema up to date, and records what was applied.
 *
 * Two kinds of file, both under `src/database/`:
 *
 *   - `timescaledb-schema.sql`, the baseline. Every statement in it is
 *     idempotent, so it is applied again whenever its content changes (its
 *     checksum differs from the one recorded). A fresh database is built from
 *     it, and an older one is carried forward by its `IF NOT EXISTS` /
 *     `ADD COLUMN IF NOT EXISTS` blocks, exactly as re-running it by hand did.
 *   - `migrations/NNN_name.sql`, applied once each, in order, each in its own
 *     transaction. Changes that are not naturally idempotent go here.
 *
 * Both are recorded in `schema_migrations`. The backend runs this at startup
 * before it serves anything that needs the database, under an advisory lock so
 * two processes starting together cannot apply the same file twice;
 * `node dist/cli/migrate.js` (`./tradingapp.sh migrate`) runs the same code.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { PoolClient } from 'pg';
import { logger } from './logger.js';

export const BASELINE_VERSION = '000_baseline';
const LOCK_ID = 727274; // arbitrary, constant: "the schema migration lock"

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrationResult {
  applied: string[];
  current: string[];
}

/** Where the .sql files are: next to the sources, or beside `dist/` in the image. */
export function databaseDir(): string {
  const candidates = [
    path.join(__dirname, '..', 'database'),
    path.join(__dirname, '..', '..', 'src', 'database'),
  ];
  const found = candidates.find((dir) => fs.existsSync(path.join(dir, 'timescaledb-schema.sql')));
  if (!found) throw new Error(`schema files not found (looked in ${candidates.join(', ')})`);
  return found;
}

function checksum(sql: string): string {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

export function loadMigrationFiles(dir: string = databaseDir()): MigrationFile[] {
  const baselineSql = fs.readFileSync(path.join(dir, 'timescaledb-schema.sql'), 'utf8');
  const files: MigrationFile[] = [
    {
      version: BASELINE_VERSION,
      name: 'timescaledb-schema.sql',
      sql: baselineSql,
      checksum: checksum(baselineSql),
    },
  ];
  const migrationsDir = path.join(dir, 'migrations');
  if (fs.existsSync(migrationsDir)) {
    for (const name of fs.readdirSync(migrationsDir).sort()) {
      const match = /^(\d{3})_[a-z0-9_]+\.sql$/.exec(name);
      if (!match) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, name), 'utf8');
      files.push({ version: name.replace(/\.sql$/, ''), name, sql, checksum: checksum(sql) });
    }
  }
  return files;
}

async function exists(client: PoolClient, relation: string): Promise<boolean> {
  const { rows } = await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [relation]);
  return Boolean(rows[0]?.present);
}

/**
 * Applies whatever is pending. Throws on the first file that fails, leaving
 * that file unrecorded so the next start tries it again.
 */
export async function runMigrations(
  client: PoolClient,
  files: MigrationFile[] = loadMigrationFiles()
): Promise<MigrationResult> {
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(64) PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    const { rows } = await client.query('SELECT version, checksum FROM schema_migrations');
    const recorded = new Map<string, string>(rows.map((r) => [r.version, r.checksum]));

    const applied: string[] = [];
    for (const file of files) {
      const baseline = file.version === BASELINE_VERSION;
      const previous = recorded.get(file.version);
      if (previous === file.checksum) continue;
      if (previous && !baseline) {
        // A numbered migration is applied once; editing it afterwards does
        // nothing on databases that already ran it, so say so.
        logger.warn(
          { migration: file.name },
          'migration file changed after it was applied; the change is not re-run'
        );
        continue;
      }

      logger.info({ migration: file.name }, 'applying database migration');
      if (baseline) {
        const hadAggregate = await exists(client, 'daily_candlestick_data');
        // One batch: Postgres runs it as a single implicit transaction.
        await client.query(file.sql);
        if (!hadAggregate) {
          // Created WITH NO DATA (see the schema file); fill it once. Cannot
          // run inside a transaction, so it is its own statement.
          await client.query(
            `CALL refresh_continuous_aggregate('daily_candlestick_data', NULL, NULL)`
          );
        }
      } else {
        await client.query('BEGIN');
        try {
          await client.query(file.sql);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
      await client.query(
        `INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)
         ON CONFLICT (version) DO UPDATE
           SET name = EXCLUDED.name, checksum = EXCLUDED.checksum, applied_at = NOW()`,
        [file.version, file.name, file.checksum]
      );
      applied.push(file.version);
    }
    return { applied, current: files.map((f) => f.version) };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
  }
}
