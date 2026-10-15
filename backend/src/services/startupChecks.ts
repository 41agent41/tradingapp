/**
 * Configuration checks run once at backend startup.
 *
 * Errors stop the process: they are configurations that are unsafe to run
 * (an open API, a default database password, live trading without MFA, a
 * kill-switch action that does nothing). Warnings are logged and the backend
 * starts anyway.
 *
 * Most checks only apply when `NODE_ENV=production` so local development
 * keeps working with an empty `.env`. The live-trading and kill-switch checks
 * apply everywhere, because they are about what an order can do, not about
 * where the app runs.
 */

import { encryptionKey } from '../config/secretBox.js';
import { parsePropRules } from './propRules.js';

export interface StartupCheckResult {
  errors: string[];
  warnings: string[];
}

type Env = Record<string, string | undefined>;

/** Values shipped in templates, defaults and docs. Never acceptable in production. */
const KNOWN_DEFAULTS = new Set([
  'change_me',
  'changeme',
  'changeme_jwt_secret',
  'changeme_session_secret',
  'tradingapp123',
  'password',
  'postgres',
  'secret',
]);

function val(env: Env, key: string): string {
  return (env[key] || '').trim();
}

function isDefault(value: string): boolean {
  return KNOWN_DEFAULTS.has(value.toLowerCase());
}

/** Refuses empty, template and too-short values. Returns the problem or null. */
function weakSecret(value: string, minLength: number): string | null {
  if (!value) return 'is not set';
  if (isDefault(value)) return 'is still a template or default value';
  if (value.length < minLength) return `is shorter than ${minLength} characters`;
  return null;
}

export function checkStartupConfig(env: Env = process.env): StartupCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const production = val(env, 'NODE_ENV') === 'production';

  // (Live trading needs the trader role and MFA, S4. Both can now be set up
  // on the Security tab, so the live gate itself checks for them on every
  // order and stays closed without them, rather than this refusing to start.)

  // --- Kill switch: an unknown action would silently fall back to notify ---
  const action = val(env, 'KILL_SWITCH_ACTION').toLowerCase();
  if (action && !['notify', 'halt', 'flatten'].includes(action)) {
    errors.push(
      `KILL_SWITCH_ACTION=${action} is not an action. Set notify, halt or flatten (or remove it).`
    );
  }

  // --- Trading day zone: a bad one would make every equity check throw -----
  const zone = val(env, 'TRADING_DAY_TIMEZONE');
  if (zone) {
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: zone });
    } catch {
      errors.push(
        `TRADING_DAY_TIMEZONE=${zone} is not a valid IANA time zone (for example Europe/Athens).`
      );
    }
  }

  // --- Prop rules: a funded account with unreadable rules must not start --
  for (const [name, raw] of Object.entries(env)) {
    if (!name.startsWith('PROP_RULES__') || !raw || !raw.trim()) continue;
    try {
      parsePropRules(raw);
    } catch (err) {
      errors.push(`${name} ${(err as Error).message}.`);
    }
  }

  // --- Dead-man's switch: a URL in .env must be one -----------------------
  // (Whether one is set at all is `heartbeatWarnings`, checked once the
  // Settings page's values are read, since it can be set there too.)
  for (const name of ['HEARTBEAT_URL', 'HEARTBEAT_FAIL_URL']) {
    const url = val(env, name);
    if (url && !/^https?:\/\//i.test(url)) errors.push(`${name} must be an http(s) URL.`);
  }

  // --- Settings encryption key: secrets saved on the Settings page --------
  if (val(env, 'SETTINGS_ENCRYPTION_KEY')) {
    try {
      encryptionKey(env);
    } catch (err) {
      // Production refuses it; a development .env copied from the template
      // only warns, since nothing there is encrypted yet.
      (production ? errors : warnings).push((err as Error).message);
    }
  } else if (production) {
    warnings.push(
      'SETTINGS_ENCRYPTION_KEY is not set: secrets cannot be saved from the Settings page. ' +
        'Run ./tradingapp.sh config to generate one.'
    );
  }

  if (val(env, 'NEXT_PUBLIC_API_TOKEN')) {
    warnings.push(
      'NEXT_PUBLIC_API_TOKEN is no longer used and should be removed from .env. If it ever ' +
        'held your API_TOKEN, that token was readable in the web page: rotate API_TOKEN.'
    );
  }

  if (!production) return { errors, warnings };

  // --- Authentication (S2) ------------------------------------------------
  // The password and tokens can be left out of .env and set in the app: with
  // none, the API refuses every request until the first-run setup is done.
  // A value that is in .env must still be a real one.
  const apiToken = val(env, 'API_TOKEN');
  const appPassword = val(env, 'APP_PASSWORD');
  if (apiToken) {
    const problem = weakSecret(apiToken, 24);
    if (problem) errors.push(`API_TOKEN ${problem}.`);
  }
  if (appPassword) {
    const problem = weakSecret(appPassword, 12);
    if (problem) errors.push(`APP_PASSWORD ${problem}.`);
  }
  const sessionSecret = val(env, 'SESSION_SECRET');
  if (sessionSecret) {
    const sessionProblem = weakSecret(sessionSecret, 32);
    if (sessionProblem) errors.push(`SESSION_SECRET ${sessionProblem} (it signs login sessions).`);
  } else if (!val(env, 'SETTINGS_ENCRYPTION_KEY')) {
    warnings.push(
      'Neither SESSION_SECRET nor SETTINGS_ENCRYPTION_KEY is set: logins will not survive a restart.'
    );
  }

  // --- Broker service shared secret (S1) ----------------------------------
  const brokerProblem = weakSecret(val(env, 'BROKER_SERVICE_TOKEN'), 24);
  if (brokerProblem) {
    errors.push(
      `BROKER_SERVICE_TOKEN ${brokerProblem}. It must match on the backend and the ` +
        'broker service, or anything that can reach the broker service can place orders.'
    );
  }

  // --- Default credentials (S3) -------------------------------------------
  const pg = val(env, 'POSTGRES_PASSWORD');
  if (!pg || isDefault(pg)) {
    errors.push(
      'POSTGRES_PASSWORD is empty or a known default. Change it in the database ' +
        "(ALTER USER ... WITH PASSWORD '...') and in .env."
    );
  }
  const redis = val(env, 'REDIS_PASSWORD');
  if (!redis || isDefault(redis)) {
    warnings.push(
      'REDIS_PASSWORD is empty or a default; any container on the network can use Redis.'
    );
  }

  return { errors, warnings };
}

/** Unattended trading with nothing watching. Called with the settings in
 *  effect (`.env` and the Settings page), after they have been read. */
export function heartbeatWarnings(env: Record<string, string | undefined>): string[] {
  if (val(env, 'HEARTBEAT_URL')) return [];
  if (val(env, 'SYSTEMATIC_EXECUTION_ENABLED').toLowerCase() !== 'true') return [];
  return [
    'SYSTEMATIC_EXECUTION_ENABLED=true with no heartbeat URL: nothing will page you if the ' +
      'app, the host or its internet goes down. Set a monitor off the host (Settings, ' +
      'Alerts and safety, or HEARTBEAT_URL).',
  ];
}
