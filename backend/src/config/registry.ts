/**
 * The settings registry: every setting the app reads that can live in the
 * database instead of `.env`, declared once.
 *
 * The Settings page, the `/api/settings` validation and (in later phases) the
 * broker service's config contract are all driven from this list. Values are
 * stored as the same strings `.env` would hold, so a consumer reads a setting
 * exactly as it read the environment variable, through `configService`.
 *
 * Not here, on purpose:
 *   - Bootstrap values the backend needs before it can reach the database, or
 *     that Docker reads before any process starts: the POSTGRES_* connection,
 *     SETTINGS_ENCRYPTION_KEY, BROKER_SERVICE_TOKEN, REDIS_PASSWORD, the ports,
 *     NODE_ENV, TZ, LOG_LEVEL. These stay in `.env`.
 *   - Per-connection families (`CONNECTION_MAX_*__<CONN>`, `PROP_RULES__<CONN>`)
 *     and the connection manifest's secrets, which move to their own tables
 *     with the Connections tab.
 *   - The MT5 sidecar's settings, which live on its Windows host.
 *
 * `editable` marks the settings whose consumers already read through
 * `configService`. Only those can be saved; the rest are shown read-only
 * until their consumer is migrated, so a saved value never silently does
 * nothing.
 */

export type SettingType = 'boolean' | 'integer' | 'number' | 'string' | 'enum' | 'json';

export type SettingSection =
  | 'trading'
  | 'risk'
  | 'alerts'
  | 'strategies'
  | 'schedulers'
  | 'security'
  | 'connections'
  | 'network';

/**
 * How a saved change takes effect:
 *   immediate — read on every use
 *   reload    — the owning loop restarts its timer
 *   restart   — the service must be restarted
 */
export type ApplyMode = 'immediate' | 'reload' | 'restart';

export interface SettingDef {
  key: string;
  section: SettingSection;
  label: string;
  type: SettingType;
  /** The value used when neither `.env` nor the database sets one. */
  default?: string;
  min?: number;
  max?: number;
  options?: readonly string[];
  /** Never returned by the API; stored encrypted. */
  secret?: boolean;
  apply: ApplyMode;
  /** Saving needs the trader role and MFA, like placing an order. */
  stepUp?: boolean;
  /** Saveable from the Settings page (its consumer reads `configService`). */
  editable?: boolean;
  help: string;
}

export const SECTIONS: { id: SettingSection; title: string }[] = [
  { id: 'trading', title: 'Trading' },
  { id: 'risk', title: 'Risk' },
  { id: 'alerts', title: 'Alerts and safety' },
  { id: 'strategies', title: 'Strategies' },
  { id: 'schedulers', title: 'Schedulers and data' },
  { id: 'security', title: 'Security' },
  { id: 'connections', title: 'Connections' },
  { id: 'network', title: 'Network' },
];

const BROKERS = ['ib', 'mt5', 'alpaca', 'oanda'] as const;

export const SETTINGS: readonly SettingDef[] = [
  // --- Trading -------------------------------------------------------------
  {
    key: 'LIVE_TRADING_ENABLED',
    section: 'trading',
    label: 'Live trading',
    type: 'boolean',
    default: 'false',
    apply: 'immediate',
    stepUp: true,
    help: 'Allows orders on live accounts. Paper orders work either way. Needs trading tokens and MFA.',
  },
  {
    key: 'SYSTEMATIC_ENABLED',
    section: 'trading',
    label: 'Strategy runner',
    type: 'boolean',
    default: 'false',
    apply: 'reload',
    help: 'Evaluates every running strategy on a timer and records its signals. Signal-only unless systematic execution is also on.',
  },
  {
    key: 'SYSTEMATIC_EXECUTION_ENABLED',
    section: 'trading',
    label: 'Systematic execution',
    type: 'boolean',
    default: 'false',
    apply: 'immediate',
    stepUp: true,
    help: 'Lets the strategy engine place orders (paper unless live trading is also on). Turning it off is the global kill switch.',
  },
  {
    key: 'DEFAULT_BROKER',
    section: 'trading',
    label: 'Default broker',
    type: 'enum',
    options: BROKERS,
    default: 'ib',
    apply: 'immediate',
    stepUp: true,
    help: 'Venue used when an order or a run does not name one.',
  },

  // --- Risk ----------------------------------------------------------------
  {
    key: 'ORDER_MAX_QUANTITY',
    section: 'risk',
    label: 'Max order quantity',
    type: 'number',
    default: '100000',
    min: 1,
    apply: 'immediate',
    stepUp: true,
    help: 'Fat-finger cap on every order, paper and live.',
  },
  {
    key: 'ORDER_MAX_PRICE',
    section: 'risk',
    label: 'Max order price',
    type: 'number',
    default: '1000000',
    min: 0.01,
    apply: 'immediate',
    stepUp: true,
    help: 'Fat-finger cap on limit and stop prices.',
  },
  {
    key: 'ORDER_MAX_POSITION',
    section: 'risk',
    label: 'Max net position per symbol',
    type: 'number',
    default: '0',
    min: 0,
    apply: 'immediate',
    stepUp: true,
    help: 'Caps the net submitted exposure per broker, symbol and account mode. 0 turns the guard off.',
  },
  {
    key: 'ORDER_POSITION_LOOKBACK_HOURS',
    section: 'risk',
    label: 'Position guard lookback (hours)',
    type: 'integer',
    default: '24',
    min: 1,
    apply: 'immediate',
    stepUp: true,
    help: 'Only orders submitted within this window count toward the net position.',
  },
  {
    key: 'SYSTEMATIC_MAX_ORDERS_PER_DAY',
    section: 'risk',
    label: 'Engine orders per day (all runs)',
    type: 'integer',
    default: '0',
    min: 0,
    apply: 'immediate',
    stepUp: true,
    help: 'Global backstop on engine-placed orders per calendar day. 0 turns it off.',
  },
  {
    key: 'ORDER_PLACE_WAIT_SECONDS',
    section: 'risk',
    label: 'IB order status wait (seconds)',
    type: 'integer',
    default: '3',
    min: 0,
    max: 5,
    apply: 'restart',
    help: 'How long the broker service waits after an IB order for its status callback.',
  },
  {
    key: 'CONNECTION_MAX_ORDERS_PER_DAY',
    section: 'risk',
    label: 'Orders per day per connection',
    type: 'integer',
    min: 0,
    apply: 'immediate',
    stepUp: true,
    help: 'Applies to every connection unless the connection sets its own.',
  },
  {
    key: 'CONNECTION_MAX_DAILY_LOSS',
    section: 'risk',
    label: 'Daily realised loss per connection',
    type: 'number',
    min: 0,
    apply: 'immediate',
    stepUp: true,
    help: 'Stops new entries once a connection has lost this much today, from fills.',
  },
  {
    key: 'CONNECTION_MAX_DAILY_EQUITY_LOSS',
    section: 'risk',
    label: 'Daily equity loss per connection',
    type: 'number',
    min: 0,
    apply: 'immediate',
    stepUp: true,
    help: 'Stops new entries once equity is this far below where the trading day started.',
  },
  {
    key: 'CONNECTION_MAX_DRAWDOWN',
    section: 'risk',
    label: 'Drawdown per connection',
    type: 'number',
    min: 0,
    apply: 'immediate',
    stepUp: true,
    help: 'Stops new entries once equity is this far below its high-water mark.',
  },
  {
    key: 'PORTFOLIO_MAX_DAILY_LOSS',
    section: 'risk',
    label: 'Fleet daily loss',
    type: 'number',
    min: 0,
    apply: 'immediate',
    stepUp: true,
    help: 'Fleet-wide backstop across every connection.',
  },
  {
    key: 'PORTFOLIO_BASE_CURRENCY',
    section: 'risk',
    label: 'Base currency',
    type: 'string',
    apply: 'immediate',
    stepUp: true,
    help: 'The currency every connection must report. A mismatch makes the portfolio cap refuse.',
  },
  {
    key: 'POSITION_RECONCILIATION_TOLERANCE',
    section: 'risk',
    label: 'Position reconciliation tolerance',
    type: 'number',
    default: '0.0001',
    min: 0,
    apply: 'restart',
    help: 'How far the venue and fills may disagree on a position before it is flagged.',
  },
  {
    key: 'TRADING_DAY_TIMEZONE',
    section: 'risk',
    label: 'Trading day timezone',
    type: 'string',
    default: 'UTC',
    apply: 'immediate',
    stepUp: true,
    help: 'IANA zone in which the trading day rolls over, e.g. Europe/Athens for most MT5 servers.',
  },

  // --- Alerts and safety ---------------------------------------------------
  {
    key: 'KILL_SWITCH_ACTION',
    section: 'alerts',
    label: 'Kill switch action',
    type: 'enum',
    options: ['notify', 'halt', 'flatten'],
    default: 'notify',
    apply: 'immediate',
    stepUp: true,
    help: 'notify alerts only; halt also stops new entries on the connection; flatten also closes its positions.',
  },
  {
    key: 'KILL_SWITCH_STOP_GAP_TOLERANCE_PCT',
    section: 'alerts',
    label: 'Stop gap tolerance (%)',
    type: 'number',
    default: '25',
    min: 0,
    apply: 'immediate',
    stepUp: true,
    help: 'How far past the stop a fill must land to count as a gap. 0 turns the check off.',
  },
  {
    key: 'KILL_SWITCH_EQUITY_FLOOR',
    section: 'alerts',
    label: 'Equity floor',
    type: 'number',
    default: '0',
    min: 0,
    apply: 'immediate',
    stepUp: true,
    help: 'Absolute equity floor per connection. 0 turns it off.',
  },
  {
    key: 'TELEGRAM_BOT_TOKEN',
    section: 'alerts',
    label: 'Telegram bot token',
    type: 'string',
    secret: true,
    apply: 'immediate',
    help: 'Alerts are off until both the token and the chat id are set.',
  },
  {
    key: 'TELEGRAM_CHAT_ID',
    section: 'alerts',
    label: 'Telegram chat id',
    type: 'string',
    apply: 'immediate',
    help: 'Chat or channel the bot posts to.',
  },
  {
    key: 'ALERT_DEDUPE_SECONDS',
    section: 'alerts',
    label: 'Repeat alert after (seconds)',
    type: 'integer',
    default: '3600',
    min: 0,
    apply: 'restart',
    help: 'An ongoing condition is alerted again only after this long.',
  },
  {
    key: 'ALERT_MAX_PER_HOUR',
    section: 'alerts',
    label: 'Alerts per hour',
    type: 'integer',
    default: '30',
    min: 1,
    apply: 'restart',
    help: 'Rate limit across all alerts.',
  },
  {
    key: 'HEARTBEAT_URL',
    section: 'alerts',
    label: 'Heartbeat URL',
    type: 'string',
    secret: true,
    apply: 'restart',
    help: 'Pinged while the app can trade, by a monitor off the host that pages when pings stop.',
  },
  {
    key: 'HEARTBEAT_FAIL_URL',
    section: 'alerts',
    label: 'Heartbeat failure URL',
    type: 'string',
    secret: true,
    apply: 'restart',
    help: 'Called at once when a known problem stops trading.',
  },
  {
    key: 'HEARTBEAT_INTERVAL_SECONDS',
    section: 'alerts',
    label: 'Heartbeat interval (seconds)',
    type: 'integer',
    default: '60',
    min: 10,
    apply: 'restart',
    help: 'How often the heartbeat URL is pinged.',
  },

  // --- Strategies ----------------------------------------------------------
  {
    key: 'PROMOTION_MIN_TRADES',
    section: 'strategies',
    label: 'Minimum backtest trades',
    type: 'integer',
    default: '30',
    min: 1,
    apply: 'immediate',
    stepUp: true,
    editable: true,
    help: 'Closed trades a qualifying backtest needs before paper or live.',
  },
  {
    key: 'PROMOTION_MAX_BACKTEST_DRAWDOWN_PCT',
    section: 'strategies',
    label: 'Max backtest drawdown (%)',
    type: 'number',
    default: '20',
    min: 0.01,
    max: 100,
    apply: 'immediate',
    stepUp: true,
    editable: true,
    help: "A qualifying backtest's max drawdown must be below this.",
  },
  {
    key: 'PROMOTION_MIN_PAPER_DAYS',
    section: 'strategies',
    label: 'Minimum paper days',
    type: 'integer',
    default: '28',
    min: 1,
    apply: 'immediate',
    stepUp: true,
    editable: true,
    help: 'How long a paper run must last before the definition can go live.',
  },
  {
    key: 'PROMOTION_PAPER_DRAWDOWN_RATIO',
    section: 'strategies',
    label: 'Paper drawdown ratio',
    type: 'number',
    default: '1.5',
    min: 0.01,
    apply: 'immediate',
    stepUp: true,
    editable: true,
    help: "Paper drawdown may be at most this multiple of the backtest's.",
  },
  {
    key: 'PROMOTION_PAPER_GATE',
    section: 'strategies',
    label: 'Backtest gate for paper',
    type: 'enum',
    options: ['enforce', 'off'],
    default: 'enforce',
    apply: 'immediate',
    stepUp: true,
    editable: true,
    help: 'off lets paper runs start without a qualifying backtest (smoke tests). Live is always gated.',
  },

  // --- Schedulers and data -------------------------------------------------
  {
    key: 'SYSTEMATIC_INTERVAL_SECONDS',
    section: 'schedulers',
    label: 'Runner interval (seconds)',
    type: 'integer',
    default: '60',
    min: 5,
    apply: 'reload',
    help: 'How often the runner evaluates every running strategy.',
  },
  {
    key: 'SYSTEMATIC_INITIAL_DELAY_MS',
    section: 'schedulers',
    label: 'Runner start delay (ms)',
    type: 'integer',
    default: '15000',
    min: 0,
    apply: 'restart',
    help: 'Delay before the first evaluation after startup.',
  },
  {
    key: 'SYSTEMATIC_MAX_CONNECTION_CONCURRENCY',
    section: 'schedulers',
    label: 'Connections evaluated at once',
    type: 'integer',
    default: '4',
    min: 1,
    apply: 'reload',
    help: 'Runs within one connection stay sequential.',
  },
  {
    key: 'SYSTEMATIC_CONNECTION_BREAKER_THRESHOLD',
    section: 'schedulers',
    label: 'Connection breaker threshold',
    type: 'integer',
    default: '3',
    min: 1,
    apply: 'reload',
    help: 'Consecutive failures before a connection is skipped.',
  },
  {
    key: 'SYSTEMATIC_CONNECTION_BREAKER_COOLDOWN_SECONDS',
    section: 'schedulers',
    label: 'Connection breaker cooldown (seconds)',
    type: 'integer',
    default: '300',
    min: 1,
    apply: 'reload',
    help: 'How long a failing connection is skipped.',
  },
  {
    key: 'BACKFILL_ENABLED',
    section: 'schedulers',
    label: 'Backfill scheduler',
    type: 'boolean',
    default: 'false',
    apply: 'reload',
    help: 'Tops up the database with recent bars for every auto-collect row.',
  },
  {
    key: 'BACKFILL_INTERVAL_MINUTES',
    section: 'schedulers',
    label: 'Backfill interval (minutes)',
    type: 'integer',
    default: '15',
    min: 1,
    apply: 'reload',
    help: 'How often the backfill scheduler ticks.',
  },
  {
    key: 'BACKFILL_PERIOD',
    section: 'schedulers',
    label: 'Backfill window',
    type: 'string',
    default: '5D',
    apply: 'reload',
    help: 'Window fetched per run, as an IB period (1D, 5D, 1M).',
  },
  {
    key: 'BACKFILL_INITIAL_DELAY_MS',
    section: 'schedulers',
    label: 'Backfill start delay (ms)',
    type: 'integer',
    default: '30000',
    min: 0,
    apply: 'restart',
    help: 'Delay before the first backfill after startup.',
  },
  {
    key: 'EXECUTIONS_SYNC_ENABLED',
    section: 'schedulers',
    label: 'Fills sync',
    type: 'boolean',
    default: 'false',
    apply: 'reload',
    help: "Pulls each venue's fills into the database. Needed for P&L and max_daily_loss.",
  },
  {
    key: 'EXECUTIONS_SYNC_INTERVAL_SECONDS',
    section: 'schedulers',
    label: 'Fills sync interval (seconds)',
    type: 'integer',
    default: '120',
    min: 15,
    apply: 'reload',
    help: 'How often each venue is polled.',
  },
  {
    key: 'EXECUTIONS_SYNC_LOOKBACK_DAYS',
    section: 'schedulers',
    label: 'Fills sync lookback (days)',
    type: 'integer',
    default: '2',
    min: 1,
    max: 30,
    apply: 'reload',
    help: 'How far back each poll reaches.',
  },
  {
    key: 'EXECUTIONS_SYNC_INITIAL_DELAY_MS',
    section: 'schedulers',
    label: 'Fills sync start delay (ms)',
    type: 'integer',
    default: '20000',
    min: 0,
    apply: 'restart',
    help: 'Delay before the first poll after startup.',
  },
  {
    key: 'EXECUTIONS_DEFAULT_ACCOUNT_MODE',
    section: 'schedulers',
    label: 'Mode for unmatched fills',
    type: 'enum',
    options: ['paper', 'live'],
    default: 'paper',
    apply: 'reload',
    help: 'Account mode stamped on a fill with no order of ours behind it.',
  },
  {
    key: 'REDIS_ENABLED',
    section: 'schedulers',
    label: 'Redis cache',
    type: 'boolean',
    default: 'true',
    apply: 'restart',
    help: 'Read-through cache for quotes and searches.',
  },
  {
    key: 'CACHE_TTL_REALTIME',
    section: 'schedulers',
    label: 'Quote cache (seconds)',
    type: 'integer',
    default: '2',
    min: 0,
    apply: 'restart',
    help: 'How long a realtime quote is cached.',
  },
  {
    key: 'STREAMING_ENABLED',
    section: 'schedulers',
    label: 'Live streaming',
    type: 'boolean',
    default: 'true',
    apply: 'restart',
    help: 'Fans out ticks from Redis to the browser.',
  },
  {
    key: 'NEWS_CALENDAR_URL',
    section: 'schedulers',
    label: 'News calendar URL',
    type: 'string',
    default: 'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
    apply: 'immediate',
    editable: true,
    help: 'Economic calendar used for prop-firm news blackouts.',
  },
  {
    key: 'NEWS_CALENDAR_REFRESH_MINUTES',
    section: 'schedulers',
    label: 'News calendar refresh (minutes)',
    type: 'number',
    default: '360',
    min: 1,
    apply: 'immediate',
    editable: true,
    help: 'How often the calendar is fetched.',
  },
  {
    key: 'NEWS_CALENDAR_MAX_AGE_HOURS',
    section: 'schedulers',
    label: 'News calendar max age (hours)',
    type: 'number',
    default: '24',
    min: 1,
    apply: 'immediate',
    editable: true,
    help: 'After this long without a successful fetch, accounts with a news rule stop taking entries.',
  },

  // --- Security ------------------------------------------------------------
  {
    key: 'APP_PASSWORD',
    section: 'security',
    label: 'Login password',
    type: 'string',
    secret: true,
    apply: 'immediate',
    stepUp: true,
    help: 'The browser login.',
  },
  {
    key: 'SESSION_SECRET',
    section: 'security',
    label: 'Session signing secret',
    type: 'string',
    secret: true,
    apply: 'immediate',
    stepUp: true,
    help: 'Signs login cookies. Changing it signs every browser out.',
  },
  {
    key: 'SESSION_TTL_HOURS',
    section: 'security',
    label: 'Session length (hours)',
    type: 'number',
    default: '12',
    min: 1,
    apply: 'immediate',
    help: 'How long a login lasts.',
  },
  {
    key: 'COOKIE_SECURE',
    section: 'security',
    label: 'Secure cookie',
    type: 'boolean',
    default: 'false',
    apply: 'immediate',
    help: 'Set when served over HTTPS by a proxy that does not send X-Forwarded-Proto.',
  },
  {
    key: 'API_TOKEN',
    section: 'security',
    label: 'API token',
    type: 'string',
    secret: true,
    apply: 'immediate',
    stepUp: true,
    help: 'Bearer token for scripts. Read access only; orders also need a trading token.',
  },
  {
    key: 'TRADING_TOKENS',
    section: 'security',
    label: 'Trading tokens',
    type: 'string',
    secret: true,
    apply: 'immediate',
    stepUp: true,
    help: 'Comma-separated tokens that grant the trader role (X-Trading-Token).',
  },
  {
    key: 'ORDER_MFA_SECRET',
    section: 'security',
    label: 'Order MFA secret',
    type: 'string',
    secret: true,
    apply: 'immediate',
    stepUp: true,
    help: 'Base32 TOTP secret for the X-MFA-Code on orders and protected settings.',
  },

  // --- Connections (single-account shorthand; moves to connection rows) ----
  {
    key: 'BROKER_CONNECTIONS',
    section: 'connections',
    label: 'Connection manifest',
    type: 'json',
    apply: 'reload',
    stepUp: true,
    help: 'JSON list of broker connections. Replaced by the Connections tab.',
  },
  {
    key: 'BROKER_CONNECTIONS_FILE',
    section: 'connections',
    label: 'Connection manifest file',
    type: 'string',
    apply: 'reload',
    stepUp: true,
    help: 'Path to a file holding the manifest JSON.',
  },
  {
    key: 'IB_HOST',
    section: 'connections',
    label: 'IB Gateway host',
    type: 'string',
    apply: 'restart',
    stepUp: true,
    help: 'Host running IB Gateway or TWS.',
  },
  {
    key: 'IB_PORT',
    section: 'connections',
    label: 'IB Gateway port',
    type: 'integer',
    default: '4002',
    apply: 'restart',
    stepUp: true,
    help: '4002 is the Gateway paper socket, 4001 live.',
  },
  {
    key: 'IB_CLIENT_ID',
    section: 'connections',
    label: 'IB client id',
    type: 'integer',
    default: '1',
    apply: 'restart',
    help: 'Unique per connecting process.',
  },
  {
    key: 'IB_TIMEOUT',
    section: 'connections',
    label: 'IB timeout (seconds)',
    type: 'integer',
    default: '15',
    min: 1,
    apply: 'restart',
    help: 'Request timeout against IB Gateway.',
  },
  {
    key: 'IB_CLIENT_POOL_SIZE',
    section: 'connections',
    label: 'IB client pool size',
    type: 'integer',
    default: '1',
    min: 1,
    apply: 'restart',
    help: '2 or more opens a pool of IB clients for concurrent requests.',
  },
  {
    key: 'IB_TIMEZONE',
    section: 'connections',
    label: 'IB timezone',
    type: 'string',
    default: 'UTC',
    apply: 'restart',
    help: 'Timezone IB reports execution times in.',
  },
  {
    key: 'MT5_BRIDGE_URL',
    section: 'connections',
    label: 'MT5 bridge URL',
    type: 'string',
    apply: 'reload',
    stepUp: true,
    help: 'Single-account MT5 sidecar address.',
  },
  {
    key: 'MT5_BRIDGE_SECRET',
    section: 'connections',
    label: 'MT5 bridge secret',
    type: 'string',
    secret: true,
    apply: 'reload',
    stepUp: true,
    help: 'Shared secret the sidecar checks on every request.',
  },
  {
    key: 'MT5_ACCOUNT_INFO_SOURCE',
    section: 'connections',
    label: 'MT5 account info source',
    type: 'enum',
    options: ['', 'oanda'],
    apply: 'reload',
    stepUp: true,
    help: 'oanda reads balance and positions from the OANDA API while orders go through MT5.',
  },
  {
    key: 'ALPACA_API_KEY',
    section: 'connections',
    label: 'Alpaca API key',
    type: 'string',
    secret: true,
    apply: 'reload',
    stepUp: true,
    help: 'Alpaca is available once the key and secret are set.',
  },
  {
    key: 'ALPACA_API_SECRET',
    section: 'connections',
    label: 'Alpaca API secret',
    type: 'string',
    secret: true,
    apply: 'reload',
    stepUp: true,
    help: 'Alpaca secret key.',
  },
  {
    key: 'ALPACA_PAPER',
    section: 'connections',
    label: 'Alpaca paper endpoint',
    type: 'boolean',
    default: 'true',
    apply: 'reload',
    stepUp: true,
    help: "true trades against Alpaca's paper endpoint.",
  },
  {
    key: 'OANDA_API_TOKEN',
    section: 'connections',
    label: 'OANDA API token',
    type: 'string',
    secret: true,
    apply: 'reload',
    stepUp: true,
    help: 'OANDA is available once the token and account id are set.',
  },
  {
    key: 'OANDA_ACCOUNT_ID',
    section: 'connections',
    label: 'OANDA account id',
    type: 'string',
    apply: 'reload',
    stepUp: true,
    help: 'OANDA account to trade.',
  },
  {
    key: 'OANDA_ENVIRONMENT',
    section: 'connections',
    label: 'OANDA environment',
    type: 'enum',
    options: ['practice', 'live'],
    default: 'practice',
    apply: 'reload',
    stepUp: true,
    help: 'practice is the paper environment.',
  },

  // --- Network (goes away with the same-origin frontend) -------------------
  {
    key: 'CORS_ORIGINS',
    section: 'network',
    label: 'Allowed browser origins',
    type: 'string',
    apply: 'restart',
    help: 'Comma-separated origins the backend accepts browser requests from.',
  },
  {
    key: 'IB_CORS_ORIGINS',
    section: 'network',
    label: 'Broker service origins',
    type: 'string',
    apply: 'restart',
    help: 'Origins the broker service accepts. Only the backend calls it.',
  },
];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

export function settingDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key);
}

export function isRegistered(key: string): boolean {
  return BY_KEY.has(key);
}

export class SettingValidationError extends Error {}

const BOOLEAN_TRUE = new Set(['true', '1', 'yes', 'on']);
const BOOLEAN_FALSE = new Set(['false', '0', 'no', 'off']);

/**
 * Checks a value against its definition and returns it in the canonical
 * string form consumers already parse (`true`/`false`, plain numbers,
 * compact JSON). Throws `SettingValidationError` with a reason a person can
 * act on.
 */
export function normalizeValue(def: SettingDef, raw: unknown): string {
  if (raw === null || raw === undefined) {
    throw new SettingValidationError(`${def.label} needs a value.`);
  }
  const text = (typeof raw === 'string' ? raw : String(raw)).trim();
  if (text.length > 4000) {
    throw new SettingValidationError(`${def.label} is too long.`);
  }

  switch (def.type) {
    case 'boolean': {
      const lower = text.toLowerCase();
      if (BOOLEAN_TRUE.has(lower)) return 'true';
      if (BOOLEAN_FALSE.has(lower)) return 'false';
      throw new SettingValidationError(`${def.label} must be true or false.`);
    }
    case 'integer':
    case 'number': {
      const n = Number(text);
      if (text === '' || !Number.isFinite(n)) {
        throw new SettingValidationError(`${def.label} must be a number.`);
      }
      if (def.type === 'integer' && !Number.isInteger(n)) {
        throw new SettingValidationError(`${def.label} must be a whole number.`);
      }
      if (def.min !== undefined && n < def.min) {
        throw new SettingValidationError(`${def.label} must be at least ${def.min}.`);
      }
      if (def.max !== undefined && n > def.max) {
        throw new SettingValidationError(`${def.label} must be at most ${def.max}.`);
      }
      return String(n);
    }
    case 'enum': {
      const options = def.options ?? [];
      const match = options.find((o) => o.toLowerCase() === text.toLowerCase());
      if (match === undefined) {
        throw new SettingValidationError(
          `${def.label} must be one of: ${options.filter(Boolean).join(', ')}.`
        );
      }
      return match;
    }
    case 'json': {
      try {
        return JSON.stringify(JSON.parse(text));
      } catch {
        throw new SettingValidationError(`${def.label} must be valid JSON.`);
      }
    }
    case 'string':
    default:
      if (!text) throw new SettingValidationError(`${def.label} needs a value.`);
      return text;
  }
}
