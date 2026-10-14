/**
 * Login and order credentials managed on the Settings page (Security tab):
 * the login password, API tokens, trading tokens and the order MFA secret,
 * plus the key that signs login sessions.
 *
 * Stored in `auth_credentials`, never in a form that can be read back where
 * that is avoidable:
 *   - the password is an scrypt hash;
 *   - tokens are SHA-256 hashes (they are 32 random bytes, so a slow hash
 *     adds nothing), shown once when created and never again;
 *   - the MFA secret and the session key have to be used, not just checked,
 *     so they are sealed under SETTINGS_ENCRYPTION_KEY like other secrets.
 *
 * `.env` still wins, as everywhere else: APP_PASSWORD, ORDER_MFA_SECRET and
 * SESSION_SECRET set there replace the stored ones, and API_TOKEN and
 * TRADING_TOKENS set there are accepted alongside the stored tokens.
 *
 * Checks run on every request, so they read an in-memory copy that is
 * reloaded after every change and every 30 seconds. Each change is written to
 * `settings_audit` under `security:<what>`, with no secret in it.
 */
import crypto from 'crypto';

import type { Querier } from './backtestRunRepository.js';
import { encryptionKey, openSecret, sealSecret } from '../config/secretBox.js';
import { logger } from './logger.js';

export type TokenKind = 'api' | 'trading';
export type CredentialSource = 'environment' | 'database' | 'unset';

export interface TokenView {
  id: string;
  kind: TokenKind;
  label: string;
  /** The first characters of the token, so a person can tell them apart. */
  prefix: string;
  created_at: string;
  created_by: string | null;
  last_used_at: string | null;
}

export interface ChangeContext {
  actor: string;
  ip?: string | null;
}

/** A change the route answers with `status`. */
export class CredentialError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

interface Row {
  id: string;
  kind: string;
  label: string | null;
  prefix: string | null;
  hash: string | null;
  ciphertext: string | null;
  created_at: string | Date;
  created_by: string | null;
  last_used_at: string | Date | null;
}

export const MIN_PASSWORD_LENGTH = 12;
const REFRESH_MS = 30_000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const TOKEN_PREFIX = { api: 'tapi_', trading: 'ttrd_' } as const;
const MFA_PENDING_MS = 10 * 60_000;

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function sameHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && crypto.timingSafeEqual(ab, bb);
}

/** `scrypt$N$r$p$salt$hash`, all hex. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('hex'), hash.toString('hex')].join(
    '$'
  );
}

export function verifyPasswordHash(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'hex');
  let actual: Buffer;
  try {
    actual = crypto.scryptSync(password, Buffer.from(salt, 'hex'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** A fresh base32 TOTP secret (160 bits, the authenticator-app norm). */
export function newTotpSecret(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = crypto.randomBytes(20);
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += alphabet[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function iso(v: string | Date | null): string | null {
  return v === null ? null : new Date(v).toISOString();
}

export class CredentialStore {
  private db: Querier | null = null;
  private timer: NodeJS.Timeout | null = null;
  private passwordHash: string | null = null;
  private tokens: (TokenView & { hash: string })[] = [];
  private mfa: string | null = null;
  private storedSessionSecret: string | null = null;
  /** Used when no session key is set or storable: logins last until restart. */
  private readonly ephemeralSessionSecret = crypto.randomBytes(32).toString('hex');
  private pendingMfa: { secret: string; until: number } | null = null;
  private loadError: string | null = null;
  private loaded = false;
  private listeners: (() => void)[] = [];

  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

  attach(db: Querier): void {
    this.db = db;
  }

  /** Loads the stored credentials, then reloads them every 30 seconds. */
  async start(): Promise<void> {
    await this.ensureTable();
    await this.load();
    if (this.timer) return;
    this.timer = setInterval(() => void this.load(), REFRESH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Called after any change, here or (within 30 seconds) by another process. */
  onChange(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  /**
   * The table is in timescaledb-schema.sql, but an install updated without
   * re-running the installer would not have it, and without it nobody could
   * log in. Creating it here is idempotent and matches the schema file.
   */
  private async ensureTable(): Promise<void> {
    if (!this.db) return;
    try {
      await this.db.query(
        `CREATE TABLE IF NOT EXISTS auth_credentials (
           id VARCHAR(32) PRIMARY KEY,
           kind VARCHAR(16) NOT NULL,
           label VARCHAR(64),
           prefix VARCHAR(16),
           hash TEXT,
           ciphertext TEXT,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           created_by VARCHAR(64),
           last_used_at TIMESTAMPTZ
         )`
      );
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, 'auth_credentials could not be created');
    }
  }

  private fromEnv(key: string): string {
    return (this.env[key] || '').trim();
  }

  private key(): Buffer | null {
    try {
      return encryptionKey(this.env);
    } catch {
      return null;
    }
  }

  private fingerprint(): string {
    return JSON.stringify([
      this.passwordHash,
      this.tokens.map((t) => t.id),
      this.mfa,
      this.storedSessionSecret,
    ]);
  }

  async load(): Promise<boolean> {
    if (!this.db) return false;
    try {
      const { rows } = await this.db.query(
        `SELECT id, kind, label, prefix, hash, ciphertext, created_at, created_by, last_used_at
           FROM auth_credentials ORDER BY created_at`
      );
      const before = this.fingerprint();
      const key = this.key();
      const open = (r: Row): string | null => {
        if (!r.ciphertext || !key) return null;
        try {
          return openSecret(r.ciphertext, key);
        } catch (err) {
          logger.error({ id: r.id, err: (err as Error).message }, 'credential cannot be decrypted');
          return null;
        }
      };
      const all = rows as Row[];
      this.passwordHash = all.find((r) => r.kind === 'password')?.hash ?? null;
      const mfaRow = all.find((r) => r.kind === 'mfa');
      this.mfa = mfaRow ? open(mfaRow) : null;
      const sessionRow = all.find((r) => r.kind === 'session_secret');
      this.storedSessionSecret = sessionRow ? open(sessionRow) : null;
      this.tokens = all
        .filter((r) => r.kind === 'api' || r.kind === 'trading')
        .map((r) => ({
          id: r.id,
          kind: r.kind as TokenKind,
          label: r.label ?? '',
          prefix: r.prefix ?? '',
          hash: r.hash ?? '',
          created_at: iso(r.created_at) ?? '',
          created_by: r.created_by,
          last_used_at: iso(r.last_used_at),
        }));
      this.loadError = null;
      this.loaded = true;
      if (!this.storedSessionSecret && !this.fromEnv('SESSION_SECRET')) {
        await this.createSessionSecret();
      }
      if (this.fingerprint() !== before) this.notify();
      return true;
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      if (message !== this.loadError) {
        logger.warn({ err: message }, 'credentials could not be read; keeping the last copy');
      }
      this.loadError = message;
      return false;
    }
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        logger.warn({ err: (err as Error)?.message }, 'credential listener failed');
      }
    }
  }

  private requireDb(): Querier {
    if (!this.db) throw new CredentialError('The settings store is not connected.', 503);
    return this.db;
  }

  private requireKey(what: string): Buffer {
    const key = this.key();
    if (!key) {
      throw new CredentialError(
        `SETTINGS_ENCRYPTION_KEY is not set in .env, so ${what} cannot be stored.`,
        409
      );
    }
    return key;
  }

  private async audit(what: string, action: string, newValue: string | null, ctx: ChangeContext) {
    await this.requireDb().query(
      `INSERT INTO settings_audit (key, action, old_value, new_value, changed_by, source_ip, reason)
       VALUES ($1, $2, NULL, $3, $4, $5, NULL)`,
      [`security:${what}`, action, newValue, ctx.actor, ctx.ip ?? null]
    );
  }

  // --- Session signing key -------------------------------------------------

  private async createSessionSecret(): Promise<void> {
    const key = this.key();
    if (!key || !this.db) return;
    const secret = crypto.randomBytes(32).toString('hex');
    await this.db.query(
      `INSERT INTO auth_credentials (id, kind, ciphertext, created_by)
       VALUES ('session_secret', 'session_secret', $1, 'system')
       ON CONFLICT (id) DO NOTHING`,
      [sealSecret(secret, key)]
    );
    const { rows } = await this.db.query(
      `SELECT ciphertext FROM auth_credentials WHERE id = 'session_secret'`
    );
    const sealed = (rows[0] as Row | undefined)?.ciphertext;
    this.storedSessionSecret = sealed ? openSecret(sealed, key) : null;
  }

  /** The key that signs login cookies: SESSION_SECRET, else the stored one. */
  sessionSecret(): string {
    return (
      this.fromEnv('SESSION_SECRET') || this.storedSessionSecret || this.ephemeralSessionSecret
    );
  }

  /** A new session key signs every browser out. Only a stored key rotates. */
  private async rotateSessionSecret(): Promise<void> {
    if (this.fromEnv('SESSION_SECRET')) return;
    const key = this.key();
    if (!key) return;
    await this.requireDb().query(
      `INSERT INTO auth_credentials (id, kind, ciphertext, created_by)
       VALUES ('session_secret', 'session_secret', $1, 'system')
       ON CONFLICT (id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, created_at = NOW()`,
      [sealSecret(crypto.randomBytes(32).toString('hex'), key)]
    );
  }

  // --- Login password ------------------------------------------------------

  passwordSource(): CredentialSource {
    if (this.fromEnv('APP_PASSWORD')) return 'environment';
    return this.passwordHash ? 'database' : 'unset';
  }

  hasPassword(): boolean {
    return this.passwordSource() !== 'unset';
  }

  verifyPassword(supplied: unknown): boolean {
    if (typeof supplied !== 'string' || !supplied) return false;
    const env = this.fromEnv('APP_PASSWORD');
    if (env) {
      const a = crypto.createHash('sha256').update(supplied).digest();
      const b = crypto.createHash('sha256').update(env).digest();
      return crypto.timingSafeEqual(a, b) && supplied.length === env.length;
    }
    return this.passwordHash ? verifyPasswordHash(supplied, this.passwordHash) : false;
  }

  /**
   * Stores a new password and signs every other browser out. With one already
   * stored the caller must have checked the current one.
   */
  async setPassword(password: unknown, ctx: ChangeContext): Promise<void> {
    if (this.fromEnv('APP_PASSWORD')) {
      throw new CredentialError(
        'The password is set in .env (APP_PASSWORD), which takes precedence. Remove it there to manage it here.',
        409
      );
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw new CredentialError(
        `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        400
      );
    }
    if (password.length > 256) throw new CredentialError('The password is too long.', 400);
    await this.requireDb().query(
      `INSERT INTO auth_credentials (id, kind, hash, created_by)
       VALUES ('password', 'password', $1, $2)
       ON CONFLICT (id) DO UPDATE
         SET hash = EXCLUDED.hash, created_at = NOW(), created_by = EXCLUDED.created_by`,
      [hashPassword(password), ctx.actor]
    );
    await this.rotateSessionSecret();
    await this.audit('password', 'set', '(secret)', ctx);
    await this.load();
  }

  // --- API and trading tokens ----------------------------------------------

  private envTokens(kind: TokenKind): string[] {
    const raw = kind === 'api' ? this.fromEnv('API_TOKEN') : this.fromEnv('TRADING_TOKENS');
    if (kind === 'api') return raw ? [raw] : [];
    return raw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }

  envTokenCount(kind: TokenKind): number {
    return this.envTokens(kind).length;
  }

  hasTokens(kind: TokenKind): boolean {
    return this.envTokens(kind).length > 0 || this.tokens.some((t) => t.kind === kind);
  }

  listTokens(kind?: TokenKind): TokenView[] {
    return this.tokens
      .filter((t) => !kind || t.kind === kind)
      .map(({ hash: _hash, ...view }) => view);
  }

  /** True when `supplied` is one of the tokens of this kind. */
  matchToken(kind: TokenKind, supplied: string | null | undefined): boolean {
    if (!supplied) return false;
    const digest = sha256(supplied);
    for (const t of this.envTokens(kind)) {
      if (sameHex(digest, sha256(t))) return true;
    }
    const row = this.tokens.find((t) => t.kind === kind && sameHex(digest, t.hash));
    if (!row) return false;
    this.touch(row);
    return true;
  }

  private touch(row: TokenView): void {
    const now = Date.now();
    if (row.last_used_at && now - Date.parse(row.last_used_at) < 60_000) return;
    row.last_used_at = new Date(now).toISOString();
    void this.db
      ?.query(`UPDATE auth_credentials SET last_used_at = NOW() WHERE id = $1`, [row.id])
      .catch(() => undefined);
  }

  /** Creates a token and returns it. It is never shown again. */
  async createToken(
    kind: TokenKind,
    label: unknown,
    ctx: ChangeContext
  ): Promise<{ token: string; view: TokenView }> {
    const name = typeof label === 'string' ? label.trim().slice(0, 64) : '';
    if (!name) throw new CredentialError('Give the token a name.', 400);
    const token = TOKEN_PREFIX[kind] + crypto.randomBytes(32).toString('base64url');
    const id = `tok_${crypto.randomBytes(8).toString('hex')}`;
    const prefix = token.slice(0, TOKEN_PREFIX[kind].length + 4);
    await this.requireDb().query(
      `INSERT INTO auth_credentials (id, kind, label, prefix, hash, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, kind, name, prefix, sha256(token), ctx.actor]
    );
    await this.audit(`${kind}_token`, 'set', `${name} (${prefix}…)`, ctx);
    await this.load();
    const view = this.listTokens(kind).find((t) => t.id === id);
    if (!view) throw new CredentialError('The token could not be read back.', 500);
    return { token, view };
  }

  async revokeToken(id: string, ctx: ChangeContext): Promise<TokenView> {
    const row = this.listTokens().find((t) => t.id === id);
    if (!row) throw new CredentialError('No such token.', 404);
    await this.requireDb().query(
      `DELETE FROM auth_credentials WHERE id = $1 AND kind IN ('api', 'trading')`,
      [id]
    );
    await this.audit(`${row.kind}_token`, 'clear', `${row.label} (${row.prefix}…)`, ctx);
    await this.load();
    return row;
  }

  // --- Order MFA -------------------------------------------------------------

  mfaSource(): CredentialSource {
    if (this.fromEnv('ORDER_MFA_SECRET')) return 'environment';
    return this.mfa ? 'database' : 'unset';
  }

  /** The TOTP secret in effect, or '' when MFA is off. */
  mfaSecret(): string {
    return this.fromEnv('ORDER_MFA_SECRET') || this.mfa || '';
  }

  /** Starts enrolment: a new secret that takes effect once a code from it is confirmed. */
  beginMfa(now: number = Date.now()): string {
    if (this.fromEnv('ORDER_MFA_SECRET')) {
      throw new CredentialError(
        'The MFA secret is set in .env (ORDER_MFA_SECRET), which takes precedence. Remove it there to manage it here.',
        409
      );
    }
    this.requireKey('the MFA secret');
    const secret = newTotpSecret();
    this.pendingMfa = { secret, until: now + MFA_PENDING_MS };
    return secret;
  }

  /** Stores the pending secret once `verify` accepts a code from it. */
  async confirmMfa(
    verify: (secret: string) => boolean,
    ctx: ChangeContext,
    now: number = Date.now()
  ): Promise<void> {
    const pending = this.pendingMfa;
    if (!pending || pending.until < now) {
      this.pendingMfa = null;
      throw new CredentialError('Start the MFA setup again; the last one expired.', 409);
    }
    if (!verify(pending.secret)) {
      throw new CredentialError('That code does not match. Check the time on your phone.', 400);
    }
    const key = this.requireKey('the MFA secret');
    await this.requireDb().query(
      `INSERT INTO auth_credentials (id, kind, ciphertext, created_by)
       VALUES ('mfa', 'mfa', $1, $2)
       ON CONFLICT (id) DO UPDATE
         SET ciphertext = EXCLUDED.ciphertext, created_at = NOW(), created_by = EXCLUDED.created_by`,
      [sealSecret(pending.secret, key), ctx.actor]
    );
    this.pendingMfa = null;
    await this.audit('mfa', 'set', '(secret)', ctx);
    await this.load();
  }

  async removeMfa(ctx: ChangeContext): Promise<void> {
    if (this.fromEnv('ORDER_MFA_SECRET')) {
      throw new CredentialError('The MFA secret is set in .env; remove it there.', 409);
    }
    await this.requireDb().query(`DELETE FROM auth_credentials WHERE id = 'mfa'`);
    await this.audit('mfa', 'clear', null, ctx);
    await this.load();
  }

  /** Whether the stored credentials have been read at least once. */
  isLoaded(): boolean {
    return this.loaded;
  }

  status(): { loaded: boolean; error: string | null; encryption_key: boolean } {
    return { loaded: this.loaded, error: this.loadError, encryption_key: this.key() !== null };
  }
}

/** The process-wide store. `index.ts` attaches the database and starts it. */
export const credentials = new CredentialStore();
