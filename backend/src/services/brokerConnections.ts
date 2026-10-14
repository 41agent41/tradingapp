/**
 * Broker connections added on the Settings page (Connections tab).
 *
 * Each row is one account at one broker. What it needs to connect is split in
 * two: `settings` (addresses, ids, the OANDA account number) stored as JSON,
 * and `secrets` (API tokens and keys, the MT5 bridge secret) sealed as one
 * JSON blob under SETTINGS_ENCRYPTION_KEY, exactly like secret settings. No
 * secret is ever returned by the API: a view says only which ones are set.
 *
 * The broker service gets the decrypted set from `brokerSync.ts`. `.env`
 * still wins there, per platform: a platform configured in `.env` ignores the
 * rows for it here, which the page shows as "overridden by .env".
 *
 * Every write is audited in `settings_audit` under `broker_connection:<label>`,
 * with secrets recorded only as "(secret)".
 */
import type { Querier } from './backtestRunRepository.js';
import { encryptionKey, openSecret, sealSecret } from '../config/secretBox.js';
import { logger } from './logger.js';

import { BROKER_PRIORITY, type Broker } from './orderTypes.js';

/** Every supported broker, in priority order (services/orderTypes.ts). */
export const PLATFORMS: readonly Broker[] = BROKER_PRIORITY;
export type Platform = Broker;
export type AccountMode = 'paper' | 'live';

/** What each platform needs. Required fields are checked on save. */
export const PLATFORM_FIELDS: Record<
  Platform,
  { settings: readonly string[]; required: readonly string[]; secrets: readonly string[] }
> = {
  oanda: { settings: ['account_id'], required: ['account_id', 'token'], secrets: ['token'] },
  mt5: { settings: ['url', 'server_timezone'], required: ['url'], secrets: ['secret'] },
  ib: { settings: ['host', 'port', 'client_id'], required: ['host'], secrets: [] },
  alpaca: { settings: [], required: ['api_key', 'api_secret'], secrets: ['api_key', 'api_secret'] },
};

const ACCOUNT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const INTEGER_SETTINGS = new Set(['port', 'client_id']);
const SECRET_MARK = '(secret)';

export interface BrokerConnectionView {
  id: number;
  platform: Platform;
  account: string;
  label: string;
  account_mode: AccountMode;
  currency: string;
  is_default: boolean;
  settings: Record<string, string>;
  /** Which secrets are stored (never their values). */
  secrets_set: Record<string, boolean>;
  /** Set when the stored secrets cannot be decrypted (key changed or lost). */
  secret_error: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

export interface BrokerConnectionInput {
  platform?: unknown;
  account?: unknown;
  account_mode?: unknown;
  currency?: unknown;
  is_default?: unknown;
  settings?: unknown;
  /** Omitted or empty secrets keep the stored value on an update. */
  secrets?: unknown;
}

export interface ChangeContext {
  actor: string;
  ip?: string | null;
}

/** An error the route answers with `status`. */
export class BrokerConnectionError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

interface Row {
  id: number;
  platform: Platform;
  account: string;
  account_mode: AccountMode;
  currency: string;
  is_default: boolean;
  settings: Record<string, string> | null;
  ciphertext: string | null;
  updated_at: string | Date | null;
  updated_by: string | null;
}

export const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS broker_connections (
    id BIGSERIAL PRIMARY KEY,
    platform VARCHAR(16) NOT NULL,
    account VARCHAR(64) NOT NULL,
    account_mode VARCHAR(8) NOT NULL DEFAULT 'paper',
    currency VARCHAR(8) NOT NULL DEFAULT 'USD',
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    ciphertext TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by VARCHAR(64),
    UNIQUE (platform, account)
)`;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function stringMap(value: unknown, what: string): Record<string, string> {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new BrokerConnectionError(`${what} must be an object.`, 400);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const t = text(v);
    if (t.length > 2000) throw new BrokerConnectionError(`${k} is too long.`, 400);
    if (t) out[k] = t;
  }
  return out;
}

export class BrokerConnectionStore {
  private ready = false;

  constructor(
    private readonly db: Querier,
    private readonly env: Record<string, string | undefined> = process.env
  ) {}

  /** Creates the table on an install whose schema predates it. */
  async ensureTable(): Promise<void> {
    if (this.ready) return;
    await this.db.query(CREATE_TABLE_SQL);
    this.ready = true;
  }

  /** The key, or null when it is unset or unusable (startup checks report which). */
  private key(): Buffer | null {
    try {
      return encryptionKey(this.env);
    } catch {
      return null;
    }
  }

  private openSecrets(row: Row): { secrets: Record<string, string>; error: string | null } {
    if (!row.ciphertext) return { secrets: {}, error: null };
    const key = this.key();
    if (!key)
      return { secrets: {}, error: 'SETTINGS_ENCRYPTION_KEY in .env is not set or not valid' };
    try {
      return { secrets: JSON.parse(openSecret(row.ciphertext, key)), error: null };
    } catch (err) {
      return { secrets: {}, error: (err as Error).message };
    }
  }

  private view(row: Row): BrokerConnectionView {
    const { secrets, error } = this.openSecrets(row);
    const names = PLATFORM_FIELDS[row.platform]?.secrets ?? [];
    return {
      id: Number(row.id),
      platform: row.platform,
      account: row.account,
      label: `${row.platform}:${row.account}`,
      account_mode: row.account_mode,
      currency: row.currency,
      is_default: row.is_default,
      settings: row.settings ?? {},
      secrets_set: Object.fromEntries(names.map((n) => [n, Boolean(secrets[n])])),
      secret_error: error,
      updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      updated_by: row.updated_by,
    };
  }

  private async rows(): Promise<Row[]> {
    await this.ensureTable();
    const { rows } = await this.db.query(
      `SELECT id, platform, account, account_mode, currency, is_default, settings, ciphertext,
              updated_at, updated_by
         FROM broker_connections ORDER BY platform, account`
    );
    return rows as Row[];
  }

  async list(): Promise<BrokerConnectionView[]> {
    return (await this.rows()).map((r) => this.view(r));
  }

  private async row(id: number): Promise<Row> {
    await this.ensureTable();
    const { rows } = await this.db.query(
      `SELECT id, platform, account, account_mode, currency, is_default, settings, ciphertext,
              updated_at, updated_by
         FROM broker_connections WHERE id = $1`,
      [id]
    );
    if (!rows[0]) throw new BrokerConnectionError('No such connection.', 404);
    return rows[0] as Row;
  }

  /**
   * Validates an input against the platform's fields. `existing` supplies the
   * stored secrets an update leaves out.
   */
  private validate(
    input: BrokerConnectionInput,
    existing?: { row: Row; secrets: Record<string, string> }
  ) {
    const platform = (existing?.row.platform ?? text(input.platform).toLowerCase()) as Platform;
    if (!PLATFORMS.includes(platform)) {
      throw new BrokerConnectionError(`Broker must be one of: ${PLATFORMS.join(', ')}.`, 400);
    }
    const account = existing?.row.account ?? (text(input.account).toLowerCase() || 'default');
    if (!ACCOUNT_PATTERN.test(account)) {
      throw new BrokerConnectionError(
        'Name must be up to 64 lowercase letters, digits, - or _, starting with a letter or digit.',
        400
      );
    }
    const modeRaw = text(input.account_mode ?? existing?.row.account_mode ?? 'paper').toLowerCase();
    if (modeRaw !== 'paper' && modeRaw !== 'live') {
      throw new BrokerConnectionError('Mode must be paper or live.', 400);
    }
    const accountMode = modeRaw as AccountMode;
    const currency = (text(input.currency) || existing?.row.currency || 'USD').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new BrokerConnectionError('Currency must be a three-letter code.', 400);
    }
    const isDefault =
      input.is_default === undefined
        ? Boolean(existing?.row.is_default)
        : input.is_default === true;

    const fields = PLATFORM_FIELDS[platform];
    const given = stringMap(input.settings, 'settings');
    const settings: Record<string, string> = {};
    for (const name of fields.settings) {
      const value =
        given[name] ?? (input.settings === undefined ? existing?.row.settings?.[name] : undefined);
      if (!value) continue;
      if (INTEGER_SETTINGS.has(name) && !/^\d{1,6}$/.test(value)) {
        throw new BrokerConnectionError(`${name} must be a whole number.`, 400);
      }
      if (name === 'url' && !/^https?:\/\/[^\s]+$/i.test(value)) {
        throw new BrokerConnectionError('URL must start with http:// or https://.', 400);
      }
      settings[name] = value;
    }

    const newSecrets = stringMap(input.secrets, 'secrets');
    const secrets: Record<string, string> = {};
    for (const name of fields.secrets) {
      const value = newSecrets[name] || existing?.secrets[name];
      if (value) secrets[name] = value;
    }

    const missing = fields.required.filter((n) => !settings[n] && !secrets[n]);
    if (missing.length) {
      throw new BrokerConnectionError(`${platform} needs: ${missing.join(', ')}.`, 400);
    }

    let ciphertext: string | null = null;
    if (Object.keys(secrets).length) {
      const key = this.key();
      if (!key) {
        throw new BrokerConnectionError(
          'SETTINGS_ENCRYPTION_KEY in .env is not set or not valid, so broker credentials cannot be stored. Set it (openssl rand -hex 32) and redeploy.',
          409
        );
      }
      ciphertext = sealSecret(JSON.stringify(secrets), key);
    }
    const secretsChanged = Object.keys(newSecrets).some((n) => fields.secrets.includes(n));
    return {
      platform,
      account,
      accountMode,
      currency,
      isDefault,
      settings,
      ciphertext,
      secretsChanged,
    };
  }

  private async audit(
    label: string,
    action: string,
    oldValue: string | null,
    newValue: string | null,
    ctx: ChangeContext
  ): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO settings_audit (key, action, old_value, new_value, changed_by, source_ip)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [`broker_connection:${label}`, action, oldValue, newValue, ctx.actor, ctx.ip ?? null]
      );
    } catch (err) {
      logger.warn({ label, err: (err as Error).message }, 'broker connection audit failed');
    }
  }

  private describe(v: {
    accountMode: string;
    currency: string;
    isDefault: boolean;
    settings: Record<string, string>;
    secretsChanged?: boolean;
  }): string {
    const parts = [
      `mode=${v.accountMode}`,
      `currency=${v.currency}`,
      ...Object.entries(v.settings).map(([k, val]) => `${k}=${val}`),
    ];
    if (v.isDefault) parts.push('default');
    if (v.secretsChanged) parts.push(`credentials=${SECRET_MARK}`);
    return parts.join(' ');
  }

  /** Only one default per platform: setting one clears the others. */
  private async clearOtherDefaults(platform: string, keepId: number): Promise<void> {
    await this.db.query(
      `UPDATE broker_connections SET is_default = FALSE WHERE platform = $1 AND id <> $2`,
      [platform, keepId]
    );
  }

  async create(input: BrokerConnectionInput, ctx: ChangeContext): Promise<BrokerConnectionView> {
    await this.ensureTable();
    const v = this.validate(input);
    let inserted: Row;
    try {
      const { rows } = await this.db.query(
        `INSERT INTO broker_connections
           (platform, account, account_mode, currency, is_default, settings, ciphertext, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
         RETURNING id, platform, account, account_mode, currency, is_default, settings, ciphertext,
                   updated_at, updated_by`,
        [
          v.platform,
          v.account,
          v.accountMode,
          v.currency,
          v.isDefault,
          JSON.stringify(v.settings),
          v.ciphertext,
          ctx.actor,
        ]
      );
      inserted = rows[0] as Row;
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') {
        throw new BrokerConnectionError(`${v.platform}:${v.account} already exists.`, 409);
      }
      throw err;
    }
    if (v.isDefault) await this.clearOtherDefaults(v.platform, Number(inserted.id));
    const label = `${v.platform}:${v.account}`;
    await this.audit(label, 'create', null, this.describe({ ...v, secretsChanged: true }), ctx);
    return this.view(inserted);
  }

  async update(
    id: number,
    input: BrokerConnectionInput,
    ctx: ChangeContext
  ): Promise<BrokerConnectionView> {
    const row = await this.row(id);
    const opened = this.openSecrets(row);
    if (opened.error && !input.secrets) {
      throw new BrokerConnectionError(
        `The stored credentials cannot be read (${opened.error}); enter them again.`,
        409
      );
    }
    const v = this.validate(input, { row, secrets: opened.secrets });
    const { rows } = await this.db.query(
      `UPDATE broker_connections
          SET account_mode = $2, currency = $3, is_default = $4, settings = $5::jsonb,
              ciphertext = $6, updated_at = NOW(), updated_by = $7
        WHERE id = $1
        RETURNING id, platform, account, account_mode, currency, is_default, settings, ciphertext,
                  updated_at, updated_by`,
      [
        id,
        v.accountMode,
        v.currency,
        v.isDefault,
        JSON.stringify(v.settings),
        v.ciphertext,
        ctx.actor,
      ]
    );
    if (v.isDefault) await this.clearOtherDefaults(v.platform, id);
    const label = `${row.platform}:${row.account}`;
    await this.audit(
      label,
      'update',
      this.describe({
        accountMode: row.account_mode,
        currency: row.currency,
        isDefault: row.is_default,
        settings: row.settings ?? {},
      }),
      this.describe(v),
      ctx
    );
    return this.view(rows[0] as Row);
  }

  async remove(id: number, ctx: ChangeContext): Promise<void> {
    const row = await this.row(id);
    await this.db.query(`DELETE FROM broker_connections WHERE id = $1`, [id]);
    await this.audit(`${row.platform}:${row.account}`, 'delete', null, null, ctx);
  }

  /**
   * The set the broker service registers, secrets decrypted, in the manifest
   * entry shape. A row whose secrets cannot be decrypted is left out (and
   * logged): registering it without credentials would only fail later.
   */
  async managedEntries(): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (const row of await this.rows()) {
      const { secrets, error } = this.openSecrets(row);
      if (error) {
        logger.warn(
          { connection: `${row.platform}:${row.account}`, error },
          'broker connection skipped'
        );
        continue;
      }
      const settings = row.settings ?? {};
      const entry: Record<string, unknown> = {
        id: row.account,
        platform: row.platform,
        account_mode: row.account_mode,
        currency: row.currency,
        default: row.is_default,
        ...settings,
        ...secrets,
      };
      if (row.platform === 'oanda') {
        entry.environment = row.account_mode === 'live' ? 'live' : 'practice';
      }
      out.push(entry);
    }
    return out;
  }
}
