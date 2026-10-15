/**
 * Helpers for Settings > Connections (BrokerConnections.tsx): what each
 * broker needs, the form's request body, and reordering the priority list.
 */

export type ConnectionCheck = {
  status: 'connected' | 'unreachable';
  error: string | null;
  latency_ms: number | null;
  checked_at: string | null;
};

/** A connection in effect, as the broker service reports it. */
export type LiveConnection = {
  label: string;
  platform: string;
  account: string;
  account_mode: string | null;
  is_default: boolean;
  /** "env" (.env) or "app" (added here). Older broker services omit it. */
  source?: string;
  check: ConnectionCheck | null;
};

export type StatusPayload = {
  default: string | null;
  priority: string[];
  priority_from_env?: boolean;
  overridden?: string[];
  connections: LiveConnection[];
};

/** A connection added here, as stored (never with its secrets). */
export type StoredConnection = {
  id: number;
  platform: string;
  account: string;
  label: string;
  account_mode: 'paper' | 'live';
  currency: string;
  is_default: boolean;
  settings: Record<string, string>;
  limits?: Partial<Record<LimitField, number>>;
  prop_rules?: Record<string, unknown> | null;
  secrets_set: Record<string, boolean>;
  secret_error: string | null;
};

/** The caps a connection can set for itself; empty falls back to the Risk tab. */
export const LIMIT_FORM = [
  { name: 'max_orders_per_day', label: 'Orders per day' },
  { name: 'max_daily_loss', label: 'Daily realised loss' },
  { name: 'max_daily_equity_loss', label: 'Daily equity loss' },
  { name: 'max_drawdown', label: 'Drawdown' },
] as const;
export type LimitField = (typeof LIMIT_FORM)[number]['name'];

export type StoredPayload = {
  connections: StoredConnection[];
  platforms: string[];
  priority: string[] | null;
  priority_locked: boolean;
  encryption_ready: boolean;
  auth: { trading_auth_required: boolean; mfa_required: boolean };
};

export type Field = {
  name: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
};

/** Mirrors PLATFORM_FIELDS in backend/src/services/brokerConnections.ts. */
export const PLATFORM_FORM: Record<string, Field[]> = {
  oanda: [
    { name: 'account_id', label: 'Account ID', required: true, placeholder: '101-001-1234567-001' },
    { name: 'token', label: 'API token', secret: true, required: true },
  ],
  mt5: [
    { name: 'url', label: 'Bridge URL', required: true, placeholder: 'http://10.0.0.20:9100' },
    { name: 'secret', label: 'Bridge secret', secret: true },
    { name: 'server_timezone', label: 'Server timezone', placeholder: 'Etc/GMT-2' },
  ],
  ib: [
    { name: 'host', label: 'Gateway host', required: true, placeholder: '10.0.0.30' },
    { name: 'port', label: 'Port', placeholder: '4002' },
    { name: 'client_id', label: 'Client ID', placeholder: '1' },
  ],
  alpaca: [
    { name: 'api_key', label: 'API key', secret: true, required: true },
    { name: 'api_secret', label: 'API secret', secret: true, required: true },
  ],
};

/**
 * Every supported broker, in the built-in priority order (the broker service
 * reports the order in effect). Mirrors BROKER_PRIORITY in
 * broker_service/connections.py; see broker_service/ADDING_A_BROKER.md.
 */
export const BROKERS_BY_PRIORITY = ['oanda', 'mt5', 'ib', 'alpaca'];

const PLATFORM_NAME: Record<string, string> = {
  oanda: 'OANDA',
  mt5: 'MT5',
  ib: 'Interactive Brokers',
  alpaca: 'Alpaca',
};

/** Short names, where space is tight (the header health badge). */
const PLATFORM_SHORT_NAME: Record<string, string> = { ib: 'IB' };

export function platformName(platform: string, short = false): string {
  return (short && PLATFORM_SHORT_NAME[platform]) || PLATFORM_NAME[platform] || platform;
}

export function checkSummary(check: ConnectionCheck | null): {
  tone: 'ok' | 'bad' | 'none';
  text: string;
} {
  if (!check) return { tone: 'none', text: 'Not checked yet' };
  if (check.status === 'connected') {
    return {
      tone: 'ok',
      text: `Connected${check.latency_ms != null ? ` (${check.latency_ms} ms)` : ''}`,
    };
  }
  return { tone: 'bad', text: `Unreachable${check.error ? `: ${check.error}` : ''}` };
}

/**
 * What to say after a save: the backend checks a connection right after it is
 * added or changed, so a wrong key or address shows at once.
 */
export function saveMessage(
  done: string,
  res: { sync_error?: string | null; check?: ConnectionCheck | null; check_error?: string | null }
): { kind: 'ok' | 'error'; text: string } {
  if (res?.sync_error) {
    return {
      kind: 'error',
      text: `${done} The broker service has not picked it up yet: ${res.sync_error}`,
    };
  }
  if (res?.check_error) {
    return { kind: 'error', text: `${done} It could not be checked: ${res.check_error}` };
  }
  if (res?.check) {
    const summary = checkSummary(res.check);
    return summary.tone === 'ok'
      ? { kind: 'ok', text: `${done} ${summary.text}.` }
      : { kind: 'error', text: `${done} Check failed. ${summary.text}` };
  }
  return { kind: 'ok', text: done };
}

/** Move `platform` one place up (-1) or down (+1). */
export function movePlatform(order: string[], platform: string, by: -1 | 1): string[] {
  const i = order.indexOf(platform);
  const j = i + by;
  if (i === -1 || j < 0 || j >= order.length) return order;
  const next = [...order];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

export type FormState = {
  platform: string;
  account: string;
  account_mode: 'paper' | 'live';
  currency: string;
  is_default: boolean;
  values: Record<string, string>;
  limits: Partial<Record<LimitField, string>>;
  /** The prop firm's rules as JSON text; empty for an ordinary account. */
  prop_rules: string;
};

export function emptyForm(platform = 'oanda'): FormState {
  return {
    platform,
    account: 'default',
    account_mode: 'paper',
    currency: 'USD',
    is_default: true,
    values: {},
    limits: {},
    prop_rules: '',
  };
}

export function formFromStored(c: StoredConnection): FormState {
  return {
    platform: c.platform,
    account: c.account,
    account_mode: c.account_mode,
    currency: c.currency,
    is_default: c.is_default,
    values: { ...c.settings },
    limits: Object.fromEntries(
      Object.entries(c.limits ?? {}).map(([k, v]) => [k, String(v)])
    ) as FormState['limits'],
    prop_rules: c.prop_rules ? JSON.stringify(c.prop_rules, null, 2) : '',
  };
}

/**
 * The POST/PUT body. Settings and limits are always sent in full (an empty
 * limit clears it); a secret left blank is not sent, which on an edit keeps
 * the stored one.
 */
export function requestBody(form: FormState): Record<string, unknown> {
  const settings: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const field of PLATFORM_FORM[form.platform] ?? []) {
    const value = (form.values[field.name] ?? '').trim();
    if (!value) continue;
    (field.secret ? secrets : settings)[field.name] = value;
  }
  return {
    platform: form.platform,
    account: form.account.trim().toLowerCase(),
    account_mode: form.account_mode,
    currency: form.currency.trim().toUpperCase(),
    is_default: form.is_default,
    settings,
    limits: Object.fromEntries(
      LIMIT_FORM.map(({ name }) => [name, (form.limits[name] ?? '').trim()])
    ),
    prop_rules: form.prop_rules.trim() || null,
    ...(Object.keys(secrets).length ? { secrets } : {}),
  };
}
