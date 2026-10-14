/**
 * Where a setting's value comes from: `.env` first, then the database, then
 * the consumer's own default.
 *
 * The environment winning is deliberate. Every existing install keeps
 * behaving exactly as before until a line is removed from `.env`, and a value
 * set there is a break-glass that the Settings page cannot override (the page
 * shows it as locked).
 *
 * Values are cached in memory and re-read every 30 seconds, and immediately
 * after a save through this process. If the database is unreachable the last
 * good copy is kept; before the first successful read only `.env` applies,
 * which is exactly the behaviour before this service existed.
 *
 * Consumers read a setting the way they read the environment variable:
 *
 *   configService.get('NEWS_CALENDAR_URL')       // string | undefined
 *   promotionThresholds(configService.asEnv())   // for env-injectable code
 */
import type { Querier } from '../services/backtestRunRepository.js';
import { logger } from '../services/logger.js';
import {
  SETTINGS,
  type SettingDef,
  SettingValidationError,
  normalizeValue,
  settingDef,
} from './registry.js';
import { encryptionKey, openSecret, sealSecret } from './secretBox.js';

export type SettingSource = 'environment' | 'database' | 'default' | 'unset';

interface StoredRow {
  key: string;
  value: string | null;
  ciphertext: string | null;
  version: number;
  updated_at: string | Date;
  updated_by: string | null;
}

export interface SettingView {
  key: string;
  section: string;
  label: string;
  type: string;
  options?: readonly string[];
  min?: number;
  max?: number;
  default: string | null;
  secret: boolean;
  apply: string;
  step_up: boolean;
  editable: boolean;
  help: string;
  source: SettingSource;
  /** The value in effect. Always null for a secret. */
  value: string | null;
  is_set: boolean;
  /** Set in `.env`, so the page cannot change it. */
  locked: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

export interface AuditEntry {
  id: number;
  key: string;
  action: string;
  old_value: string | null;
  new_value: string | null;
  changed_by: string | null;
  source_ip: string | null;
  reason: string | null;
  changed_at: string;
}

export interface ChangeContext {
  actor: string;
  ip?: string | null;
  reason?: string | null;
}

/** A save the caller should answer with `status`. */
export class SettingWriteError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

const REFRESH_MS = 30_000;
const SECRET_MARK = '(secret)';

export class ConfigService {
  private db: Querier | null = null;
  private rows = new Map<string, StoredRow>();
  private secrets = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private loadedAt: Date | null = null;
  private lastError: string | null = null;

  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

  /** Connects the store. Until then only `.env` applies. */
  attach(db: Querier): void {
    this.db = db;
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Re-reads every stored setting. Keeps the last good copy on failure. */
  async refresh(): Promise<boolean> {
    if (!this.db) return false;
    try {
      const { rows } = await this.db.query(
        `SELECT key, value, ciphertext, version, updated_at, updated_by FROM app_settings`
      );
      this.load(rows as StoredRow[]);
      this.loadedAt = new Date();
      this.lastError = null;
      return true;
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      if (message !== this.lastError) {
        logger.warn({ err: message }, 'settings: could not read app_settings; keeping last copy');
      }
      this.lastError = message;
      return false;
    }
  }

  private load(rows: StoredRow[]): void {
    const next = new Map<string, StoredRow>();
    const secrets = new Map<string, string>();
    let key: Buffer | null = null;
    try {
      key = encryptionKey(this.env);
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'settings: encryption key unusable');
    }
    for (const row of rows) {
      next.set(row.key, row);
      if (row.ciphertext) {
        if (!key) {
          logger.warn({ key: row.key }, 'settings: stored secret ignored, no encryption key');
          continue;
        }
        try {
          secrets.set(row.key, openSecret(row.ciphertext, key));
        } catch (err) {
          logger.warn({ key: row.key, err: (err as Error).message }, 'settings: secret ignored');
        }
      }
    }
    this.rows = next;
    this.secrets = secrets;
  }

  private fromEnv(key: string): string | undefined {
    const raw = this.env[key];
    return raw === undefined || raw.trim() === '' ? undefined : raw;
  }

  private fromDb(def: SettingDef | undefined): string | undefined {
    // Only settings whose consumer reads through this service are taken from
    // the database, so a stale row can never half-apply.
    if (!def?.editable) return undefined;
    if (def.secret) return this.secrets.get(def.key);
    return this.rows.get(def.key)?.value ?? undefined;
  }

  /** The value in effect, or undefined so the consumer applies its default. */
  get(key: string): string | undefined {
    return this.fromEnv(key) ?? this.fromDb(settingDef(key));
  }

  source(key: string): SettingSource {
    if (this.fromEnv(key) !== undefined) return 'environment';
    const def = settingDef(key);
    if (this.fromDb(def) !== undefined) return 'database';
    return def?.default !== undefined ? 'default' : 'unset';
  }

  /**
   * An environment-shaped view for code that takes `env` as a parameter:
   * registered keys resolve through this service, anything else falls
   * through to the real environment. Read lazily, so a later save is seen.
   */
  asEnv(): Record<string, string | undefined> {
    return new Proxy({} as Record<string, string | undefined>, {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;
        return settingDef(prop) ? this.get(prop) : this.env[prop];
      },
    });
  }

  describe(): SettingView[] {
    return SETTINGS.map((def) => {
      const source = this.source(def.key);
      const effective = this.get(def.key) ?? def.default ?? null;
      const row = def.editable ? this.rows.get(def.key) : undefined;
      return {
        key: def.key,
        section: def.section,
        label: def.label,
        type: def.type,
        options: def.options,
        min: def.min,
        max: def.max,
        default: def.secret ? null : (def.default ?? null),
        secret: !!def.secret,
        apply: def.apply,
        step_up: !!def.stepUp,
        editable: !!def.editable,
        help: def.help,
        source,
        value: def.secret ? null : effective,
        is_set: source === 'environment' || source === 'database',
        locked: source === 'environment',
        updated_at: row ? new Date(row.updated_at).toISOString() : null,
        updated_by: row?.updated_by ?? null,
      };
    });
  }

  status(): { loaded_at: string | null; error: string | null; encryption_key: boolean } {
    let hasKey = false;
    try {
      hasKey = encryptionKey(this.env) !== null;
    } catch {
      hasKey = false;
    }
    return {
      loaded_at: this.loadedAt ? this.loadedAt.toISOString() : null,
      error: this.lastError,
      encryption_key: hasKey,
    };
  }

  private writable(key: string): SettingDef {
    const def = settingDef(key);
    if (!def) throw new SettingWriteError(`Unknown setting ${key}.`, 404);
    if (!def.editable) {
      throw new SettingWriteError(
        `${def.label} cannot be changed here yet; it is still read from .env.`,
        409
      );
    }
    if (this.fromEnv(key) !== undefined) {
      throw new SettingWriteError(
        `${def.label} is set in .env, which takes precedence. Remove ${key} from .env to manage it here.`,
        409
      );
    }
    if (!this.db) throw new SettingWriteError('The settings store is not connected.', 503);
    return def;
  }

  /** Validates, stores and audits one value, then refreshes the cache. */
  async set(key: string, raw: unknown, ctx: ChangeContext): Promise<void> {
    const def = this.writable(key);
    let value: string;
    try {
      value = normalizeValue(def, raw);
    } catch (err) {
      if (err instanceof SettingValidationError) throw new SettingWriteError(err.message, 400);
      throw err;
    }

    let stored: string | null = value;
    let ciphertext: string | null = null;
    if (def.secret) {
      const secretKey = encryptionKey(this.env);
      if (!secretKey) {
        throw new SettingWriteError(
          'SETTINGS_ENCRYPTION_KEY is not set in .env, so secrets cannot be stored.',
          409
        );
      }
      ciphertext = sealSecret(value, secretKey);
      stored = null;
    }

    // One statement, so the row and its audit entry land together or not at all.
    await this.db!.query(
      `WITH prev AS (
         SELECT value, ciphertext FROM app_settings WHERE key = $1
       ), up AS (
         INSERT INTO app_settings (key, value, ciphertext, updated_at, updated_by)
         VALUES ($1, $2, $3, NOW(), $4)
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value,
               ciphertext = EXCLUDED.ciphertext,
               version = app_settings.version + 1,
               updated_at = NOW(),
               updated_by = EXCLUDED.updated_by
         RETURNING key
       )
       INSERT INTO settings_audit (key, action, old_value, new_value, changed_by, source_ip, reason)
       SELECT $1, 'set',
              (SELECT CASE WHEN ciphertext IS NOT NULL THEN '${SECRET_MARK}' ELSE value END FROM prev),
              $5, $4, $6, $7
         FROM up`,
      [
        key,
        stored,
        ciphertext,
        ctx.actor,
        def.secret ? SECRET_MARK : value,
        ctx.ip ?? null,
        ctx.reason ?? null,
      ]
    );
    await this.refresh();
  }

  /** Removes the stored value, so the default applies again. */
  async clear(key: string, ctx: ChangeContext): Promise<void> {
    const def = this.writable(key);
    await this.db!.query(
      `WITH gone AS (
         DELETE FROM app_settings WHERE key = $1 RETURNING value, ciphertext
       )
       INSERT INTO settings_audit (key, action, old_value, new_value, changed_by, source_ip, reason)
       SELECT $1, 'clear',
              CASE WHEN ciphertext IS NOT NULL THEN '${SECRET_MARK}' ELSE value END,
              $2, $3, $4, $5
         FROM gone`,
      [key, def.default ?? null, ctx.actor, ctx.ip ?? null, ctx.reason ?? null]
    );
    await this.refresh();
  }

  async audit(limit = 200, key?: string): Promise<AuditEntry[]> {
    if (!this.db) return [];
    const capped = Math.max(1, Math.min(1000, Math.floor(limit) || 200));
    const { rows } = key
      ? await this.db.query(
          `SELECT id, key, action, old_value, new_value, changed_by, source_ip, reason, changed_at
             FROM settings_audit WHERE key = $1 ORDER BY changed_at DESC, id DESC LIMIT $2`,
          [key, capped]
        )
      : await this.db.query(
          `SELECT id, key, action, old_value, new_value, changed_by, source_ip, reason, changed_at
             FROM settings_audit ORDER BY changed_at DESC, id DESC LIMIT $1`,
          [capped]
        );
    return rows.map((r: any) => ({
      ...r,
      id: Number(r.id),
      changed_at: new Date(r.changed_at).toISOString(),
    }));
  }
}

/** The process-wide settings. `index.ts` attaches the database and starts it. */
export const configService = new ConfigService();
