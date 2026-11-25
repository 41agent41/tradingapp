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

/** What a connection supports, as its broker adapter reports it (E-19). */
export type Capabilities = {
  market_data?: boolean;
  trading?: boolean;
  /** Bar timeframes its history serves. */
  timeframes?: string[];
  live_prices?: 'stream' | 'poll' | null;
  /** Its bars carry the broker's spread. */
  spread_bars?: boolean;
  /** It publishes its own live 1-minute bars, stored in place of built ones. */
  live_bars?: boolean;
  /** It publishes an order book. */
  depth?: boolean;
  /** It keeps past ticks and hands them over. */
  tick_history?: boolean;
  /** It says how its clients are positioned. */
  sentiment?: boolean;
  /** Each order type it takes, with the times in force that type accepts. */
  order_types?: Record<string, string[]>;
  attaches_stops?: boolean;
  /** That stop can trail the price, or be guaranteed, at the broker. */
  trailing_stops?: boolean;
  guaranteed_stops?: boolean;
  /** How the app learns of a fill. */
  fills?: 'stream' | 'signal' | 'poll' | null;
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
  /** Older broker services omit it; everything is then offered. */
  capabilities?: Capabilities | null;
  /** Where a LAN connection goes and how the link is protected. */
  link?: ConnectionLink | null;
};

/** The LAN endpoint behind an MT5 or IB Gateway connection. */
export type ConnectionLink = {
  host: string | null;
  port: number | null;
  security: 'tls_pinned' | 'tls' | 'plain' | 'loopback';
};

/**
 * What to say about a connection's link, or null when there is nothing to:
 * a broker reached over the internet, or a service on the app server itself.
 */
export function describeLink(
  platform: string,
  link: ConnectionLink | null | undefined
): { tone: 'ok' | 'warn'; text: string } | null {
  if (!link || link.security === 'loopback') return null;
  const where = link.host ? `${link.host}:${link.port}` : 'the bridge';
  if (link.security === 'tls_pinned') {
    return { tone: 'ok', text: `Encrypted to ${where}, certificate pinned` };
  }
  if (link.security === 'tls') return { tone: 'ok', text: `Encrypted to ${where}` };
  if (platform === 'ib') {
    return {
      tone: 'warn',
      text: `Not encrypted to ${where}: IB Gateway has no TLS, so its port must be firewalled to this server`,
    };
  }
  return {
    tone: 'warn',
    text: `Not encrypted to ${where}: the bridge secret and orders cross the network in the clear. Turn TLS on at the sidecar`,
  };
}

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
  /** Null on a connection saved before firms; the form asks for one. */
  firm?: string | null;
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
  /** A field of several lines, with a note under it. */
  multiline?: boolean;
  help?: string;
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
    {
      name: 'tls_fingerprint',
      label: 'Certificate fingerprint (https only)',
      placeholder: 'AB:CD:… from the sidecar log',
    },
    { name: 'server_timezone', label: 'Server timezone', placeholder: 'Etc/GMT-2' },
    {
      name: 'symbol_map',
      label: 'Symbol map',
      multiline: true,
      placeholder: 'EURUSD=EURUSD.a',
      help: "Only when the broker lists a symbol under several names and the app reports it as ambiguous. One pair per line: the app's symbol, an equals sign, then the broker's exact name.",
    },
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
  ig: [
    { name: 'api_key', label: 'API key', secret: true, required: true },
    { name: 'username', label: 'Username', required: true },
    { name: 'api_secret', label: 'Password', secret: true, required: true },
    { name: 'account_id', label: 'Account ID', placeholder: 'Leave blank for the default' },
  ],
  ctrader: [
    { name: 'api_key', label: 'Open API client ID', secret: true, required: true },
    { name: 'api_secret', label: 'Open API client secret', secret: true, required: true },
    { name: 'token', label: 'Access token', secret: true, required: true },
    {
      name: 'account_id',
      label: 'ctidTraderAccountId',
      required: true,
      placeholder: '12345678 (not the login)',
    },
  ],
  ibweb: [
    {
      name: 'url',
      label: 'Client Portal Gateway URL',
      required: true,
      placeholder: 'https://10.0.0.30:5000',
    },
    {
      name: 'account_id',
      label: 'Account ID',
      required: true,
      placeholder: 'DU1234567 (paper) or U1234567 (live)',
    },
  ],
};

/**
 * The firms a connection can belong to, each with its one connection type:
 * its web API when it has one, the MT5 bridge when it does not. Interactive
 * Brokers alone has two entries, its Web API and the older IB Gateway. The
 * backend refuses any other pairing.
 * Mirrors FIRMS in backend/src/services/firms.ts (same ids, order and
 * platforms; backend/tests/firms.test.ts checks it).
 */
export type FirmPreset = { id: string; name: string; platform: string; note: string };

const CTRADER_NOTE =
  'cTrader Open API. Register an app at openapi.ctrader.com and grant it your cTrader account.';
const WEB_API_ONLY = 'This firm has a web API, so its MT5 accounts cannot be added here.';

export const FIRM_PRESETS: FirmPreset[] = [
  {
    id: 'oanda',
    name: 'OANDA',
    platform: 'oanda',
    note: `REST API. Create a token under Manage API Access in the OANDA hub. ${WEB_API_ONLY}`,
  },
  {
    id: 'ig',
    name: 'IG',
    platform: 'ig',
    note: 'REST API. Create an API key on My IG > Settings > API keys; a demo key needs a demo login.',
  },
  {
    id: 'pepperstone',
    name: 'Pepperstone (cTrader)',
    platform: 'ctrader',
    note: `${CTRADER_NOTE} ${WEB_API_ONLY}`,
  },
  {
    id: 'icmarkets',
    name: 'IC Markets (cTrader)',
    platform: 'ctrader',
    note: `${CTRADER_NOTE} ${WEB_API_ONLY}`,
  },
  {
    id: 'fpmarkets',
    name: 'FP Markets (cTrader)',
    platform: 'ctrader',
    note: `${CTRADER_NOTE} ${WEB_API_ONLY}`,
  },
  {
    id: 'fusion',
    name: 'Fusion Markets (cTrader)',
    platform: 'ctrader',
    note: `${CTRADER_NOTE} ${WEB_API_ONLY}`,
  },
  {
    id: 'other_ctrader',
    name: 'Another cTrader firm',
    platform: 'ctrader',
    note: `${CTRADER_NOTE} Use this for a cTrader firm not listed above.`,
  },
  {
    id: 'ibkr',
    name: 'Interactive Brokers (Web API)',
    platform: 'ibweb',
    note: "Run the Client Portal Gateway and sign it in from a browser (paper login for a DU account). Several accounts, any market the account can trade, brackets attached at entry. IBKR's MCP server (api.ibkr.com/v1/api/mcp-public) works only inside an AI app such as Claude.",
  },
  {
    id: 'alpaca',
    name: 'Alpaca',
    platform: 'alpaca',
    note: 'REST API. Create a key pair on the Alpaca dashboard (paper keys for a paper account).',
  },
  {
    id: 'axi',
    name: 'Axi (MT5)',
    platform: 'mt5',
    note: "Axi has no public trading API: run the MT5 bridge next to an MT5 terminal logged in to your Axi account. Axi's MCP server (mcp.axi.com) works only inside Claude.",
  },
  {
    id: 'cmc',
    name: 'CMC Markets (MT5)',
    platform: 'mt5',
    note: 'CMC Markets offers its API to institutional clients only: open a CMC MetaTrader 5 account (not a CMC web platform or MT4 account) and run the MT5 bridge next to an MT5 terminal logged in to it.',
  },
  {
    id: 'eightcap',
    name: 'Eightcap (MT5)',
    platform: 'mt5',
    note: 'Run the MT5 bridge next to an MT5 terminal logged in to your Eightcap account.',
  },
  {
    id: 'vantage',
    name: 'Vantage (MT5)',
    platform: 'mt5',
    note: 'Run the MT5 bridge next to an MT5 terminal logged in to your Vantage account.',
  },
  {
    id: 'other_mt5',
    name: 'Another MT5 firm (no web API)',
    platform: 'mt5',
    note: 'For a firm with no web API, a prop firm for example: run the MT5 bridge next to an MT5 terminal logged in to the account. A firm listed above cannot be added this way.',
  },
  {
    id: 'ib',
    name: 'Interactive Brokers (IB Gateway)',
    platform: 'ib',
    note: 'TWS socket API through IB Gateway or TWS (port 4002 paper, 4001 live). One connection at a time; US stocks. Prefer the Web API for a new connection.',
  },
];

/** The firm a platform implies when it serves only one, else ''. */
export function impliedFirm(platform: string): string {
  const firms = FIRM_PRESETS.filter((f) => f.platform === platform);
  return firms.length === 1 ? firms[0].id : '';
}

/** A new connection form for `firm`: its platform, named after the firm. */
export function formForFirm(firm: FirmPreset): FormState {
  return {
    ...emptyForm(firm.platform),
    firm: firm.id,
    account: firm.id.startsWith('other_') ? 'default' : firm.id,
  };
}

/**
 * Every supported broker, in the built-in priority order (the broker service
 * reports the order in effect). Mirrors BROKER_PRIORITY in
 * broker_service/connections.py; see docs/DEVELOPMENT.md, "Adding a broker".
 */
export const BROKERS_BY_PRIORITY = ['oanda', 'ig', 'ctrader', 'ibweb', 'alpaca', 'mt5', 'ib'];

const PLATFORM_NAME: Record<string, string> = {
  oanda: 'OANDA',
  mt5: 'MT5',
  ib: 'Interactive Brokers',
  alpaca: 'Alpaca',
  ig: 'IG',
  ctrader: 'cTrader',
  ibweb: 'IBKR Web API',
};

/** Short names, where space is tight (the header health badge). */
const PLATFORM_SHORT_NAME: Record<string, string> = { ib: 'IB', ibweb: 'IBKR' };

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
  /** A FIRM_PRESETS id; '' until chosen. */
  firm: string;
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
    firm: impliedFirm(platform),
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
    firm: c.firm ?? '',
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
    ...(form.firm ? { firm: form.firm } : {}),
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

/**
 * The connection a platform and account name. An empty account means the
 * platform's default account.
 */
export function findConnection(
  connections: LiveConnection[],
  platform: string | undefined,
  account: string | undefined
): LiveConnection | null {
  if (!platform) return null;
  const onPlatform = connections.filter((c) => c.platform === platform);
  if (account) return onPlatform.find((c) => c.account === account) ?? null;
  return onPlatform.find((c) => c.is_default) ?? (onPlatform.length === 1 ? onPlatform[0] : null);
}

/**
 * The bar timeframes to offer for a connection, or null to offer them all:
 * when no connection is chosen (the broker priority decides) or it does not
 * say what it supports.
 */
export function supportedTimeframes(connection: LiveConnection | null): string[] | null {
  const timeframes = connection?.capabilities?.timeframes;
  return Array.isArray(timeframes) && timeframes.length ? timeframes : null;
}

const TIMEFRAME_NAME: Record<string, string> = {
  tick: 'tick',
  '1min': '1m',
  '5min': '5m',
  '15min': '15m',
  '30min': '30m',
  '1hour': '1h',
  '4hour': '4h',
  '8hour': '8h',
  '1day': '1d',
};

/** One line on what a connection supports, for Settings > Connections. */
export function describeCapabilities(caps: Capabilities | null | undefined): string | null {
  if (!caps) return null;
  const parts: string[] = [];
  if (caps.timeframes?.length) {
    parts.push(`Bars: ${caps.timeframes.map((t) => TIMEFRAME_NAME[t] ?? t).join(', ')}`);
  }
  if (caps.live_prices) {
    parts.push(caps.live_prices === 'stream' ? 'prices streamed' : 'prices polled');
  }
  if (caps.spread_bars) parts.push('bars carry the spread');
  if (caps.live_bars) parts.push("recorded bars are the broker's own");
  if (caps.depth) parts.push('depth of market');
  if (caps.tick_history) parts.push('tick history');
  if (caps.sentiment) parts.push('client sentiment');
  if (caps.trading) {
    const kinds = Object.keys(caps.order_types ?? {});
    if (kinds.length) parts.push(`orders: ${kinds.map((k) => k.replace('_', ' ')).join(', ')}`);
    parts.push(caps.attaches_stops ? 'stop attached to the entry' : 'no stop on the entry');
    if (caps.trailing_stops) parts.push('trailing stops');
    if (caps.guaranteed_stops) parts.push('guaranteed stops');
    if (caps.fills) {
      parts.push(caps.fills === 'poll' ? 'fills polled' : 'fills pushed');
    }
  }
  return parts.length ? parts.join(' · ') : null;
}
