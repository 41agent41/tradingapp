/**
 * `settings import`: copies what `.env` sets today into the app, so those
 * lines can be deleted from `.env` and managed on the Settings page.
 *
 * Run inside the backend container by `./tradingapp.sh settings-import`,
 * which passes the names of the keys in `.env` and deletes the ones reported
 * as IMPORTED (after a backup). Output, one line per key it knows:
 *
 *   IMPORTED <KEY>            stored (or already stored); the line can go
 *   KEPT <KEY> <reason>       must stay in .env for now
 *
 * Per-connection caps (`CONNECTION_MAX_*__<CONN>`) and prop rules
 * (`PROP_RULES__<CONN>`) go onto that connection on the Connections tab when
 * it was added in the app; for a connection defined in `.env` they are KEPT.
 *
 * Keys it does not know (database, ports, the encryption key, brokers) are
 * not mentioned: they stay in `.env`.
 *
 * The stores are built with only SETTINGS_ENCRYPTION_KEY in their env, since
 * with the real env every write would be refused because `.env` wins.
 */
import { ConfigService } from '../config/configService.js';
import { normalizeValue, settingDef } from '../config/registry.js';
import type { Querier } from '../services/backtestRunRepository.js';
import { CredentialStore } from '../services/credentials.js';
import {
  BrokerConnectionStore,
  type BrokerConnectionView,
  type LimitField,
} from '../services/brokerConnections.js';
import { connectionEnvKey } from '../services/accountLimits.js';

export interface ImportResult {
  imported: string[];
  kept: { key: string; reason: string }[];
}

const LIVE_KEY = 'LIVE_TRADING_ENABLED';
// A key in .env that the running backend never saw was added after the last
// deploy; importing its (missing) value would lose it.
const NOT_LOADED = 'is not in the running backend yet; redeploy, then import again';
const CREDENTIAL_KEYS = [
  'APP_PASSWORD',
  'SESSION_SECRET',
  'API_TOKEN',
  'TRADING_TOKENS',
  'ORDER_MFA_SECRET',
] as const;

/** `CONNECTION_MAX_DRAWDOWN__MT5_FTMO` → the cap it sets. */
const PER_CONNECTION_CAPS: Record<string, LimitField> = {
  CONNECTION_MAX_ORDERS_PER_DAY: 'max_orders_per_day',
  CONNECTION_MAX_DAILY_LOSS: 'max_daily_loss',
  CONNECTION_MAX_DAILY_EQUITY_LOSS: 'max_daily_equity_loss',
  CONNECTION_MAX_DRAWDOWN: 'max_drawdown',
};

type ConnectionStore = Pick<BrokerConnectionStore, 'list' | 'update'>;

/** What a per-connection key sets, or null when it is not one. */
function perConnectionKey(key: string): { suffix: string; cap: LimitField | 'prop' } | null {
  const at = key.indexOf('__');
  if (at < 0) return null;
  const family = key.slice(0, at);
  const suffix = key.slice(at + 2);
  if (!suffix) return null;
  if (family === 'PROP_RULES') return { suffix, cap: 'prop' };
  const cap = PER_CONNECTION_CAPS[family];
  return cap ? { suffix, cap } : null;
}

async function importConnectionLimits(
  keys: readonly string[],
  env: Record<string, string | undefined>,
  store: ConnectionStore,
  ctx: { actor: string },
  result: ImportResult
): Promise<void> {
  const wanted = keys
    .map((key) => ({ key, target: perConnectionKey(key) }))
    .filter((k): k is { key: string; target: NonNullable<ReturnType<typeof perConnectionKey>> } =>
      Boolean(k.target)
    );
  if (wanted.length === 0) return;

  let connections: BrokerConnectionView[];
  try {
    connections = await store.list();
  } catch (err) {
    for (const { key } of wanted) result.kept.push({ key, reason: message(err) });
    return;
  }
  const bySuffix = new Map(
    connections.map((c) => [connectionEnvKey({ broker: c.platform, brokerAccount: c.account }), c])
  );

  for (const { key, target } of wanted) {
    if (env[key] === undefined) {
      result.kept.push({ key, reason: NOT_LOADED });
      continue;
    }
    const connection = bySuffix.get(target.suffix);
    if (!connection) {
      result.kept.push({
        key,
        reason: 'its connection is defined in .env, not on the Connections tab; it stays with it',
      });
      continue;
    }
    const raw = (env[key] ?? '').trim();
    if (!raw) {
      result.imported.push(key);
      continue;
    }
    try {
      if (target.cap === 'prop') {
        let unchanged = false;
        try {
          unchanged = JSON.stringify(connection.prop_rules) === JSON.stringify(JSON.parse(raw));
        } catch {
          // Not JSON: the store's validation says so.
        }
        if (!unchanged) await store.update(connection.id, { prop_rules: raw }, ctx);
      } else if (Number(connection.limits?.[target.cap]) !== Number(raw)) {
        await store.update(connection.id, { limits: { [target.cap]: raw } }, ctx);
      }
      result.imported.push(key);
    } catch (err) {
      result.kept.push({ key, reason: message(err) });
    }
  }
}

function message(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

export async function importFromEnv(
  keys: readonly string[],
  env: Record<string, string | undefined>,
  db: Querier,
  connections?: ConnectionStore
): Promise<ImportResult> {
  const storeEnv = { SETTINGS_ENCRYPTION_KEY: env.SETTINGS_ENCRYPTION_KEY };
  const ctx = { actor: 'settings import', reason: 'imported from .env' };
  const result: ImportResult = { imported: [], kept: [] };
  const wanted = new Set(keys);

  const config = new ConfigService(storeEnv);
  config.attach(db);
  if (!(await config.refresh())) throw new Error('the settings table could not be read');

  const creds = new CredentialStore(storeEnv);
  creds.attach(db);
  await creds.start();
  creds.stop();
  if (!creds.isLoaded()) throw new Error('the credentials table could not be read');

  // Password before the session key: both are imported, so nobody is signed out.
  for (const key of CREDENTIAL_KEYS) {
    if (!wanted.has(key)) continue;
    if (env[key] === undefined) {
      result.kept.push({ key, reason: NOT_LOADED });
      continue;
    }
    const value = (env[key] ?? '').trim();
    try {
      if (value) {
        if (key === 'APP_PASSWORD') await creds.importPassword(value, ctx);
        if (key === 'SESSION_SECRET') await creds.importSessionSecret(value, ctx);
        if (key === 'API_TOKEN') await creds.importToken('api', value, 'API_TOKEN from .env', ctx);
        if (key === 'ORDER_MFA_SECRET') await creds.importMfa(value, ctx);
        if (key === 'TRADING_TOKENS') {
          const tokens = value
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean);
          for (const [i, token] of tokens.entries()) {
            const label =
              tokens.length > 1 ? `TRADING_TOKENS ${i + 1} from .env` : 'TRADING_TOKENS from .env';
            await creds.importToken('trading', token, label, ctx);
          }
        }
      }
      result.imported.push(key);
    } catch (err) {
      result.kept.push({ key, reason: message(err) });
    }
  }

  for (const key of keys) {
    const def = settingDef(key);
    if (!def?.editable) continue;
    if (key === LIVE_KEY) {
      result.kept.push({
        key,
        reason:
          'switch live trading on the Trading tab; in .env it stays as a ceiling (false keeps it off)',
      });
      continue;
    }
    if (env[key] === undefined) {
      result.kept.push({ key, reason: NOT_LOADED });
      continue;
    }
    const raw = (env[key] ?? '').trim();
    try {
      if (raw) {
        const value = normalizeValue(def, raw);
        if (config.source(key) !== 'database' || config.get(key) !== value) {
          await config.set(key, value, ctx);
        }
      }
      result.imported.push(key);
    } catch (err) {
      result.kept.push({ key, reason: message(err) });
    }
  }

  await importConnectionLimits(
    keys,
    env,
    connections ?? new BrokerConnectionStore(db, storeEnv),
    ctx,
    result
  );
  return result;
}

async function main(keys: string[]): Promise<number> {
  const { dbService } = await import('../services/database.js');
  try {
    const result = await importFromEnv(keys, process.env, dbService);
    for (const key of result.imported) console.log(`IMPORTED ${key}`);
    for (const { key, reason } of result.kept) console.log(`KEPT ${key} ${reason}`);
    return 0;
  } catch (err) {
    console.log(`ERROR ${message(err)}`);
    return 1;
  } finally {
    await dbService.close().catch(() => undefined);
  }
}

if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
