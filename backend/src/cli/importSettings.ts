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

function message(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

export async function importFromEnv(
  keys: readonly string[],
  env: Record<string, string | undefined>,
  db: Querier
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
