/**
 * The database comes first.
 *
 * Settings, logins, broker connections and every record the app keeps live in
 * the database, so nothing that needs it starts until it is reachable, its
 * schema is current and the encryption key opens what it holds. Until then the
 * HTTP server is up (so health checks can say why), `/api/health/ready`
 * answers 503, and every other API route answers 503 with the same reason
 * instead of failing half-configured.
 *
 * The wait has no deadline: a database that comes up later (started after the
 * app, or restarted) is picked up when it does. A failed migration or a wrong
 * key does not fix itself, so those stop the wait and stay reported.
 */
import type { NextFunction, Request, Response } from 'express';
import { logger } from './logger.js';
import { runMigrations, type MigrationResult } from './migrations.js';
import { checkEncryptionKey } from './keyCheck.js';
import type { DatabaseService } from './database.js';

export type StartupState =
  'waiting_for_database' | 'migrating' | 'migration_failed' | 'key_mismatch' | 'ready';

export interface StartupStatus {
  state: StartupState;
  ready: boolean;
  detail: string | null;
  database: string;
  since: string;
  attempts: number;
  migrations: MigrationResult | null;
}

/** Routes that work before the database is ready. */
const OPEN_BEFORE_READY = ['/api/health', '/api/database/health'];

function target(env: Record<string, string | undefined> = process.env): string {
  return `${env.POSTGRES_HOST || 'localhost'}:${env.POSTGRES_PORT || '5432'}/${env.POSTGRES_DB || 'tradingapp'}`;
}

export class StartupGate {
  private status: StartupStatus = {
    state: 'waiting_for_database',
    ready: false,
    detail: null,
    database: target(),
    since: new Date().toISOString(),
    attempts: 0,
    migrations: null,
  };
  private readyListeners: (() => void)[] = [];

  constructor(
    private readonly db: Pick<DatabaseService, 'testConnection' | 'getClient' | 'query'>,
    private readonly opts: {
      initialDelayMs?: number;
      maxDelayMs?: number;
      sleep?: (ms: number) => Promise<void>;
    } = {}
  ) {}

  current(): StartupStatus {
    return { ...this.status };
  }

  isReady(): boolean {
    return this.status.ready;
  }

  /** Runs once the database is ready (at once if it already is). */
  onReady(fn: () => void): void {
    if (this.status.ready) fn();
    else this.readyListeners.push(fn);
  }

  private set(state: StartupState, detail: string | null): void {
    this.status = {
      ...this.status,
      state,
      ready: state === 'ready',
      detail,
      since: new Date().toISOString(),
    };
  }

  /** Waits for the database, migrates it and checks the key. Never throws. */
  async run(): Promise<StartupStatus> {
    const sleep = this.opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    let delay = this.opts.initialDelayMs ?? 1000;
    const maxDelay = this.opts.maxDelayMs ?? 30000;

    this.set('waiting_for_database', `waiting for the database at ${this.status.database}`);
    for (;;) {
      this.status.attempts += 1;
      if (await this.db.testConnection().catch(() => false)) break;
      if (this.status.attempts === 1 || this.status.attempts % 10 === 0) {
        logger.warn(
          { database: this.status.database, attempts: this.status.attempts },
          'waiting for the database; the app starts once it is reachable'
        );
      }
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelay);
    }

    this.set('migrating', 'bringing the database schema up to date');
    let client;
    try {
      client = await this.db.getClient();
      this.status.migrations = await runMigrations(client);
      if (this.status.migrations.applied.length > 0) {
        logger.info({ applied: this.status.migrations.applied }, 'database migrations applied');
      }
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      logger.error({ err: message }, 'database migration failed; the app will not start');
      this.set(
        'migration_failed',
        `a database migration failed: ${message}. Fix the cause and restart the backend.`
      );
      return this.current();
    } finally {
      client?.release();
    }

    try {
      const key = await checkEncryptionKey(this.db);
      if (!key.ok) {
        logger.error({ reason: key.reason }, 'encryption key check failed; the app will not start');
        this.set('key_mismatch', key.reason ?? 'the encryption key check failed');
        return this.current();
      }
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      this.set('key_mismatch', `the encryption key could not be checked: ${message}`);
      return this.current();
    }

    this.set('ready', null);
    logger.info({ database: this.status.database }, 'database ready');
    const listeners = this.readyListeners;
    this.readyListeners = [];
    for (const fn of listeners) {
      try {
        fn();
      } catch (err) {
        logger.error({ err: String(err) }, 'startup listener failed');
      }
    }
    return this.current();
  }

  /** Answers 503 for API routes that need the database until it is ready. */
  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      if (this.status.ready) return next();
      const p = req.path;
      if (
        !p.startsWith('/api/') ||
        OPEN_BEFORE_READY.some((o) => p === o || p.startsWith(`${o}/`))
      ) {
        return next();
      }
      res.status(503).json({
        error: 'starting',
        startup: this.current(),
        message: this.status.detail ?? 'the app is starting',
      });
    };
  }
}
