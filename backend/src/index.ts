import express from 'express';
import cors, { CorsOptions } from 'cors';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import marketDataRoutes from './routes/marketData.js';
import accountRoutes from './routes/account.js';
import settingsRoutes from './routes/settings.js';
import securityRoutes from './routes/security.js';
import backtestingRoutes from './routes/backtesting.js';
import exportRoutes from './routes/export.js';
import ordersRoutes from './routes/orders.js';
import strategiesRoutes from './routes/strategies.js';
import watchlistRoutes from './routes/watchlist.js';
import priceAlertsRoutes from './routes/priceAlerts.js';
import authRoutes from './routes/auth.js';
import axios from 'axios';
import { dbService } from './services/database.js';
import { cacheService } from './services/cache.js';
import { createStreamingBridge, streamingEnabled } from './services/streamingBridge.js';
import {
  BACKFILL_SETTING_KEYS,
  backfillSettings,
  createBackfillScheduler,
} from './services/backfillScheduler.js';
import {
  RUNNER_SETTING_KEYS,
  createStrategyRunner,
  runnerSettings,
} from './services/strategyRunner.js';
import {
  EXECUTIONS_SETTING_KEYS,
  createExecutionsPoller,
  executionsSettings,
} from './services/executionsPoller.js';
import {
  HEARTBEAT_SETTING_KEYS,
  Heartbeat,
  heartbeatOptionsFromEnv,
} from './services/heartbeat.js';
import { checkConnectionSchema, reportSchemaGuard } from './services/schemaGuard.js';
import { createAuthMiddleware, checkSocketAuth } from './middleware/auth.js';
import { observabilityMiddleware } from './middleware/observability.js';
import { logger, currentRequestId } from './services/logger.js';
import { registry } from './services/metrics.js';
import { checkStartupConfig, heartbeatWarnings } from './services/startupChecks.js';
import { configService } from './config/configService.js';
import { startDefaultBrokerRefresh } from './services/brokerDefault.js';
import { brokersFromHealth, defaultBrokerProblem } from './services/brokerStatus.js';
import brokersRoutes from './routes/brokers.js';
import { brokerSync } from './services/brokerConnectionsRuntime.js';
import { BROKER_SETTING_KEYS } from './services/brokerSync.js';
import { credentials } from './services/credentials.js';
import { announceSetupCode } from './services/setupCode.js';
import { isLiveTradingEnabled, liveTradingSafeguardsMissing } from './services/orderTypes.js';
import { StartupGate } from './services/startupGate.js';

// Refuse to start on an unsafe configuration (open API, default secrets, live
// trading without MFA, an unimplemented kill-switch action). See the module.
{
  const { errors, warnings } = checkStartupConfig();
  for (const w of warnings) console.warn(`[startup] ${w}`);
  if (errors.length > 0) {
    for (const e of errors) console.error(`[startup] refusing to start: ${e}`);
    process.exit(1);
  }
}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
const BROKER_SERVICE_URL = process.env.BROKER_SERVICE_URL || 'http://broker_service:8000';
const BROKER_SERVICE_TOKEN = (process.env.BROKER_SERVICE_TOKEN || '').trim();

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
// `CORS_ORIGINS` is a comma-separated list of origins that the backend
// will accept browser requests from. Setting `CORS_ORIGINS=*` is
// supported for development but discouraged in production.
//
// Previously: `app.use(cors())` accepted any origin — see GAP_ANALYSIS.md
// §3.7.
const rawOrigins = (process.env.CORS_ORIGINS || '').trim();
const ALLOWED_ORIGINS: string[] = rawOrigins
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const allowAnyOrigin = ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes('*');

if (allowAnyOrigin) {
  console.warn(
    '[cors] CORS_ORIGINS is empty or wildcard ("*") — every origin will be ' +
      'accepted. Set CORS_ORIGINS to a comma-separated list of trusted ' +
      'origins (e.g. https://app.example.com).'
  );
} else {
  console.log(`[cors] allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
}

const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    // Allow same-origin / curl / server-to-server (no Origin header)
    if (!origin) return callback(null, true);
    if (allowAnyOrigin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-API-Token',
    'X-Data-Query-Enabled',
    'X-Request-Id',
    'X-Trading-Token',
    'X-MFA-Code',
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  maxAge: 86400,
};

// ---------------------------------------------------------------------------
// App + HTTP + Socket.IO setup
// ---------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    // Reflect the origin rather than '*': browsers refuse a credentialed
    // (cookie-carrying) request answered with a wildcard.
    origin: allowAnyOrigin ? true : ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// The frontend server forwards the browser's /api and /socket.io requests
// (frontend/proxy.js) and passes the browser's address in X-Forwarded-For.
// That header is believed only from the addresses listed in TRUST_PROXY
// (compose sets the frontend container's), so a caller reaching this port
// directly cannot pick the address that login lockout and the audit log see.
const TRUST_PROXY = (process.env.TRUST_PROXY || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (TRUST_PROXY.length > 0) app.set('trust proxy', TRUST_PROXY);

app.use(cors(corsOptions));
// JSON body parser. The default 100kb limit is fine for everything except
// the Parquet export, which posts the full dataframe back from the
// browser. 25 MB is plenty for the 200k-row cap enforced in routes/export.ts.
app.use(express.json({ limit: '25mb' }));

// Observability runs first so every request — including those rejected by
// auth — gets a request-id, a log line and a metric observation.
app.use(observabilityMiddleware());

// The database comes first: until it is reachable, migrated and opened by the
// encryption key, API routes answer 503 with the reason (health stays open).
const startupGate = new StartupGate(dbService);
app.use(startupGate.middleware());

// Auth: a login session cookie (browser) or API_TOKEN (scripts). Open only in
// development; startup checks refuse an unauthenticated production config.
app.use(createAuthMiddleware());
app.use('/api/auth', authRoutes);

// Propagate the per-request id into every axios call (mostly: the backend
// → broker_service hops). The interceptor reads the current AsyncLocalStorage
// store, so it works whether axios is called directly in a route or buried
// inside a service.
axios.interceptors.request.use((config) => {
  const id = currentRequestId();
  if (id && !config.headers?.['X-Request-Id']) {
    config.headers = config.headers ?? {};
    (config.headers as Record<string, string>)['X-Request-Id'] = id;
  }
  // The broker service only accepts calls carrying the shared secret. Attach
  // it to broker-service URLs only, so it never leaks to a third party.
  if (BROKER_SERVICE_TOKEN && (config.url || '').startsWith(BROKER_SERVICE_URL)) {
    config.headers = config.headers ?? {};
    (config.headers as Record<string, string>)['X-Broker-Service-Token'] = BROKER_SERVICE_TOKEN;
  }
  return config;
});

// Prometheus scrape endpoint. Intentionally unauthenticated so the scraper
// can hit it without a bearer token; if you expose this beyond the docker
// network, front it with a firewall rule.
app.get('/metrics', async (_req, res) => {
  res.setHeader('Content-Type', registry.contentType);
  res.end(await registry.metrics());
});

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------
// Readiness, for Docker and the scripts: 200 once the database is reachable,
// migrated and the encryption key checks out. Unlike /api/health it does not
// depend on the broker service or Redis, so a broker outage never holds the
// frontend back.
app.get('/api/health/ready', (_req, res) => {
  const startup = startupGate.current();
  res.status(startup.ready ? 200 : 503).json(startup);
});

app.get('/api/health', async (_req, res) => {
  const [dbConnected, redisConnected, ibResult] = await Promise.all([
    dbService.testConnection().catch(() => false),
    cacheService.ping().catch(() => false),
    axios
      .get(`${BROKER_SERVICE_URL}/health`, { timeout: 5000 })
      .then((r) => ({ ok: true as const, data: r.data }))
      .catch((e: any) => ({ ok: false as const, error: e?.message || 'unknown' })),
  ]);

  const startup = startupGate.current();
  const overall = startup.ready && dbConnected && ibResult.ok;
  const cacheStatus = cacheService.status();

  res.status(overall ? 200 : 503).json({
    status: overall ? 'healthy' : startup.ready ? 'degraded' : 'starting',
    timestamp: new Date().toISOString(),
    startup,
    services: {
      backend: { status: 'running', port: PORT },
      database: {
        status: dbConnected ? 'connected' : 'disconnected',
        connected: dbConnected,
      },
      broker_service: ibResult.ok
        ? {
            status: ibResult.data?.status || 'unknown',
            // The broker service container answering, not any broker behind it
            // (those are under `brokers`).
            connected: true,
            url: BROKER_SERVICE_URL,
          }
        : {
            status: 'error',
            connected: false,
            url: BROKER_SERVICE_URL,
            error: ibResult.error,
          },
      cache: {
        status: cacheStatus.enabled ? (redisConnected ? 'connected' : 'disconnected') : 'disabled',
        connected: redisConnected,
        host: cacheStatus.host,
        port: cacheStatus.port,
        last_error: cacheStatus.last_error,
      },
      // Each configured broker connection and its last connectivity check,
      // in broker priority order (broker_service/probes.py).
      brokers: ibResult.ok
        ? brokersFromHealth(ibResult.data?.providers)
        : { default: null, connections: [] },
      streaming: streamingBridge.status(),
      backfill: backfillScheduler.status(),
      systematic: strategyRunner.status(),
      executions: executionsPoller.status(),
      heartbeat: heartbeat.status(),
    },
  });
});

app.get('/api/database/health', async (_req, res) => {
  try {
    const connected = await dbService.testConnection();
    res.status(connected ? 200 : 503).json({
      status: connected ? 'healthy' : 'unhealthy',
      database: connected ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      database: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
});

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.use('/api/market-data', marketDataRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/security', securityRoutes);
app.use('/api/backtesting', backtestingRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/strategies', strategiesRoutes);
app.use('/api/watchlist', watchlistRoutes);
app.use('/api/alerts', priceAlertsRoutes);
app.use('/api/brokers', brokersRoutes);

app.get('/', (_req, res) => {
  res.json({
    message: 'TradingApp Backend API',
    version: '1.0.0',
    endpoints: {
      health: '/api/health',
      database_health: '/api/database/health',
      market_data: '/api/market-data',
      account: '/api/account',
      settings: '/api/settings',
      backtesting: '/api/backtesting',
      export: '/api/export',
      orders: '/api/orders',
      strategies: '/api/strategies',
    },
  });
});

// ---------------------------------------------------------------------------
// Socket.IO handshake auth + connection handling
// ---------------------------------------------------------------------------
io.use((socket, next) => {
  const err = checkSocketAuth(
    socket.handshake.auth,
    socket.handshake.headers as Record<string, string | string[] | undefined>,
    socket.handshake.query as Record<string, unknown>
  );
  if (err) {
    console.warn(`[socket] rejected connection ${socket.id}: ${err.message}`);
    return next(err);
  }
  next();
});

// Real-time streaming bridge: subscribes to Redis (where the IB
// service publishes ticks) and fans messages out to Socket.IO rooms
// of the form `market-data:<SYMBOL>`. Each Socket.IO client may call
// subscribe-market-data multiple times for different symbols; the
// bridge refcounts IB-side subscriptions so we only one-shot each
// symbol against the IB service.
const streamingBridge = createStreamingBridge(io);

// Backfill scheduler (Phase 5): periodically tops up the local store with
// recent bars for every enabled `auto_collect` row in data_collection_config.
// Opt-in via BACKFILL_ENABLED (Settings page or .env) — see
// services/backfillScheduler.ts.
const backfillScheduler = createBackfillScheduler();

// Strategy runner (Systematic Trading Phase 2, signal-only): evaluates every
// running strategy against the latest closed bar and fans signals out over
// `strategy:<runId>` Socket.IO rooms. Opt-in via SYSTEMATIC_ENABLED; it never
// places orders — that is the A3 execution layer.
const strategyRunner = createStrategyRunner({
  emit: (runId, payload) => io.to(`strategy:${runId}`).emit('strategy-signal', payload),
});

// Executions poller: syncs each active venue's fills into `order_executions`,
// so positions and realised P&L come from what actually traded rather than
// from the submitted-order estimate in `order_audit`. It is what makes a
// strategy's `max_daily_loss` cap enforceable. Opt-in via
// EXECUTIONS_SYNC_ENABLED — see services/executionsPoller.ts.
const executionsPoller = createExecutionsPoller();

// Dead-man's switch: pings a monitor off the host while the app can trade, so
// silence pages you when it cannot. Opt-in via HEARTBEAT_URL — see
// services/heartbeat.ts.
const heartbeat = new Heartbeat(
  {
    database: () => dbService.testConnection(),
    brokerService: async () => {
      await axios.get(`${BROKER_SERVICE_URL}/health`, { timeout: 5000 });
      return true;
    },
    defaultBroker: async () => {
      const res = await axios.get(`${BROKER_SERVICE_URL}/health`, { timeout: 5000 });
      return defaultBrokerProblem(brokersFromHealth(res.data?.providers));
    },
    runner: () => {
      const status = strategyRunner.status();
      return {
        enabled: status.enabled,
        intervalSeconds: status.interval_seconds,
        lastRunAt: status.last_run ? Date.parse(status.last_run) : null,
      };
    },
  },
  heartbeatOptionsFromEnv()
);

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on('subscribe-market-data', async (data) => {
    const { symbol, secType, exchange, currency, timeframe } = data || {};
    if (!symbol || typeof symbol !== 'string') {
      socket.emit('subscription-error', { error: 'symbol is required' });
      return;
    }
    console.log(
      `[socket ${socket.id}] subscribing to ${symbol}` + (timeframe ? ` (${timeframe})` : '')
    );
    try {
      const result = await streamingBridge.subscribe(socket.id, {
        symbol,
        secType,
        exchange,
        currency,
      });
      socket.join(result.room);
      socket.emit('subscription-confirmed', {
        symbol: result.symbol,
        timeframe,
        room: result.room,
        ref_count: result.refCount,
      });
    } catch (error) {
      console.error('Subscription error:', error);
      socket.emit('subscription-error', {
        symbol,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  socket.on('unsubscribe-market-data', async (data) => {
    const { symbol } = data || {};
    if (!symbol || typeof symbol !== 'string') {
      socket.emit('unsubscription-error', { error: 'symbol is required' });
      return;
    }
    console.log(`[socket ${socket.id}] unsubscribing from ${symbol}`);
    try {
      const result = await streamingBridge.unsubscribe(socket.id, { symbol });
      socket.leave(`market-data:${result.symbol}`);
      socket.emit('unsubscription-confirmed', {
        symbol: result.symbol,
        ref_count: result.refCount,
      });
    } catch (error) {
      console.error('Unsubscription error:', error);
      socket.emit('unsubscription-error', {
        symbol,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Systematic strategy signal rooms. A client watching a run joins
  // `strategy:<runId>` and receives `strategy-signal` events as the runner
  // records them. Plain broadcast rooms — no server-side refcounting needed.
  socket.on('subscribe-strategy', (data) => {
    const runId = Number((data || {}).runId);
    if (!Number.isInteger(runId) || runId <= 0) {
      socket.emit('strategy-subscription-error', { error: 'runId is required' });
      return;
    }
    socket.join(`strategy:${runId}`);
    socket.emit('strategy-subscription-confirmed', { runId, room: `strategy:${runId}` });
  });

  socket.on('unsubscribe-strategy', (data) => {
    const runId = Number((data || {}).runId);
    if (!Number.isInteger(runId) || runId <= 0) {
      socket.emit('strategy-subscription-error', { error: 'runId is required' });
      return;
    }
    socket.leave(`strategy:${runId}`);
    socket.emit('strategy-unsubscription-confirmed', { runId });
  });

  socket.on('disconnect', async () => {
    console.log(`Client disconnected: ${socket.id}`);
    try {
      await streamingBridge.releaseSocket(socket.id);
    } catch (err) {
      console.warn(`[socket] disconnect cleanup for ${socket.id} failed:`, err);
    }
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down gracefully`);
  try {
    await dbService.close();
  } catch (err) {
    console.warn('Error closing DB pool:', err);
  }
  try {
    await cacheService.close();
  } catch (err) {
    console.warn('Error closing Redis (cache):', err);
  }
  try {
    await streamingBridge.stop();
  } catch (err) {
    console.warn('Error stopping streaming bridge:', err);
  }
  try {
    backfillScheduler.stop();
  } catch (err) {
    console.warn('Error stopping backfill scheduler:', err);
  }
  try {
    strategyRunner.stop();
  } catch (err) {
    console.warn('Error stopping strategy runner:', err);
  }
  try {
    executionsPoller.stop();
  } catch (err) {
    console.warn('Error stopping executions poller:', err);
  }
  heartbeat.stop();
  stopDefaultBrokerRefresh();
  brokerSync.stop();
  configService.stop();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
let stopDefaultBrokerRefresh: () => void = () => {};

server.listen(PORT, '0.0.0.0', () => {
  logger.info({ port: PORT, broker_service: BROKER_SERVICE_URL }, 'backend listening');

  // The broker an order or run goes to when it names none (broker priority).
  stopDefaultBrokerRefresh = startDefaultBrokerRefresh(BROKER_SERVICE_URL);

  void startupGate.run();
  startupGate.onReady(startServices);

  void cacheService
    .ping()
    .then((ok) => {
      if (ok) {
        logger.info('redis cache reachable');
      } else if (cacheService.status().enabled) {
        logger.warn(
          'redis cache unreachable — caching disabled at runtime, ' +
            'requests will pass through directly'
        );
      }
    })
    .catch((err) => logger.warn({ err: String(err) }, 'redis cache check error'));
});

/** Everything that needs the database, started once it is ready. */
function startServices(): void {
  // Settings saved from the Settings page. `.env` still wins over them.
  configService.attach(dbService);
  const settingsLoaded = configService.start();

  // The login password, tokens and MFA secret managed on the Security tab.
  // With no password anywhere, print the first-run setup code.
  credentials.attach(dbService);
  const credentialsLoaded = credentials.start().then(() => {
    if (!credentials.hasPassword()) announceSetupCode();
  });
  // The broker service follows the live gate, which needs the safeguards.
  credentials.onChange(() => void brokerSync.check());

  // Broker connections added on the Settings page, sent to the broker service.
  brokerSync.start();

  // The loops below read their settings once, so they start after the stored
  // values are in (or the first read gives up), and restart when one changes.
  let systematicAllowed = false;
  void settingsLoaded.then(() => {
    for (const w of heartbeatWarnings(configService.asEnv())) logger.warn(w);

    void streamingBridge.start().catch((err) => {
      logger.warn({ err: String(err) }, 'streaming bridge failed to start');
    });
    backfillScheduler.reconfigure(backfillSettings());
    backfillScheduler.start();
    heartbeat.reconfigure(heartbeatOptionsFromEnv());
    heartbeat.start();

    configService.subscribe(['STREAMING_ENABLED'], () => {
      if (streamingEnabled()) {
        void streamingBridge.start().catch((err) => {
          logger.warn({ err: String(err) }, 'streaming bridge failed to start');
        });
      } else {
        void streamingBridge.stop();
      }
    });
    configService.subscribe(BACKFILL_SETTING_KEYS, () => {
      backfillScheduler.reconfigure(backfillSettings());
      backfillScheduler.start();
    });
    configService.subscribe(HEARTBEAT_SETTING_KEYS, () => {
      heartbeat.reconfigure(heartbeatOptionsFromEnv());
      heartbeat.start();
    });
    // The systematic services only restart if the schema guard let them start.
    configService.subscribe(RUNNER_SETTING_KEYS, () => {
      strategyRunner.reconfigure(runnerSettings());
      if (systematicAllowed) strategyRunner.start();
    });
    configService.subscribe(EXECUTIONS_SETTING_KEYS, () => {
      executionsPoller.reconfigure(executionsSettings());
      if (systematicAllowed) executionsPoller.start();
    });
    // The broker service enforces the live gate itself; send it the stored
    // values now and on every change, not only on the next background check.
    void brokerSync.check();
    configService.subscribe(BROKER_SETTING_KEYS, () => void brokerSync.check());
    void credentialsLoaded.then(() => {
      if (
        (configService.get('LIVE_TRADING_ENABLED') ?? '').toLowerCase() === 'true' &&
        !isLiveTradingEnabled()
      ) {
        logger.warn(
          { missing: liveTradingSafeguardsMissing() },
          'live trading is switched on but stays closed until a trading token and order MFA are set up'
        );
      }
    });
  });

  // Multi-connection on a pre-C-0 schema silently drops colliding fills, so
  // the systematic services do not start until the schema is verified. The
  // HTTP surface stays up either way — an operator needs /health to see why.
  void (async () => {
    let connectionCount = 1;
    try {
      const providers = await axios.get(`${BROKER_SERVICE_URL}/providers`, { timeout: 15000 });
      connectionCount = Object.keys(providers.data?.connections ?? {}).length || 1;
    } catch (err) {
      logger.warn(
        { err: String(err) },
        'could not read connection topology; assuming a single connection for the schema check'
      );
    }

    const guard = await checkConnectionSchema(dbService, connectionCount);
    if (!reportSchemaGuard(guard)) {
      logger.error(
        'systematic runner and executions poller are DISABLED until the migration is applied'
      );
      return;
    }
    await settingsLoaded;
    systematicAllowed = true;
    strategyRunner.reconfigure(runnerSettings());
    strategyRunner.start();
    executionsPoller.reconfigure(executionsSettings());
    executionsPoller.start();
  })();
}

export default app;
