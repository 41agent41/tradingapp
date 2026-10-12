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

  // --- Live trading needs the trader role and MFA (S4) -------------------
  if (val(env, 'LIVE_TRADING_ENABLED').toLowerCase() === 'true') {
    if (!val(env, 'TRADING_TOKENS')) {
      errors.push('LIVE_TRADING_ENABLED=true requires TRADING_TOKENS (the trader role).');
    }
    if (!val(env, 'ORDER_MFA_SECRET')) {
      errors.push('LIVE_TRADING_ENABLED=true requires ORDER_MFA_SECRET (order MFA).');
    }
  }

  // --- Kill switch: only notify is implemented (B8) -----------------------
  const action = val(env, 'KILL_SWITCH_ACTION').toLowerCase();
  if (action && action !== 'notify') {
    errors.push(
      `KILL_SWITCH_ACTION=${action} is not implemented: halt and flatten would only change ` +
        'the alert text. Set KILL_SWITCH_ACTION=notify (or remove it).'
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
  const apiToken = val(env, 'API_TOKEN');
  const appPassword = val(env, 'APP_PASSWORD');
  if (!apiToken && !appPassword) {
    errors.push('Set APP_PASSWORD (browser login) and/or API_TOKEN: the API would be open.');
  }
  if (apiToken) {
    const problem = weakSecret(apiToken, 24);
    if (problem) errors.push(`API_TOKEN ${problem}.`);
  }
  if (appPassword) {
    const problem = weakSecret(appPassword, 12);
    if (problem) errors.push(`APP_PASSWORD ${problem}.`);
    const sessionProblem = weakSecret(val(env, 'SESSION_SECRET'), 32);
    if (sessionProblem) errors.push(`SESSION_SECRET ${sessionProblem} (it signs login sessions).`);
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
