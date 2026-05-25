import express from 'express';
import cors, { CorsOptions } from 'cors';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import marketDataRoutes from './routes/marketData.js';
import accountRoutes from './routes/account.js';
import settingsRoutes from './routes/settings.js';
import axios from 'axios';
import { dbService } from './services/database.js';
import { cacheService } from './services/cache.js';
import { createStreamingBridge } from './services/streamingBridge.js';
import { createBackfillScheduler } from './services/backfillScheduler.js';
import { createAuthMiddleware, checkSocketAuth } from './middleware/auth.js';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
const IB_SERVICE_URL = process.env.IB_SERVICE_URL || 'http://ib_service:8000';

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
    origin: allowAnyOrigin ? '*' : ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

app.use(cors(corsOptions));
app.use(express.json());

// Bearer-token auth. The middleware is a no-op (with a startup warning)
// when API_TOKEN is not set, so existing deployments keep working until
// they roll out a token.
app.use(createAuthMiddleware());

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------
app.get('/api/health', async (_req, res) => {
  const [dbConnected, redisConnected, ibResult] = await Promise.all([
    dbService.testConnection().catch(() => false),
    cacheService.ping().catch(() => false),
    axios
      .get(`${IB_SERVICE_URL}/health`, { timeout: 5000 })
      .then((r) => ({ ok: true as const, data: r.data }))
      .catch((e: any) => ({ ok: false as const, error: e?.message || 'unknown' })),
  ]);

  const overall = dbConnected && ibResult.ok;
  const cacheStatus = cacheService.status();

  res.status(overall ? 200 : 503).json({
    status: overall ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    services: {
      backend: { status: 'running', port: PORT },
      database: {
        status: dbConnected ? 'connected' : 'disconnected',
        connected: dbConnected,
      },
      ib_service: ibResult.ok
        ? {
            status: ibResult.data?.status || 'unknown',
            connected: ibResult.data?.connection?.ib_gateway?.connected || false,
            url: IB_SERVICE_URL,
          }
        : {
            status: 'error',
            connected: false,
            url: IB_SERVICE_URL,
            error: ibResult.error,
          },
      cache: {
        status: cacheStatus.enabled ? (redisConnected ? 'connected' : 'disconnected') : 'disabled',
        connected: redisConnected,
        host: cacheStatus.host,
        port: cacheStatus.port,
        last_error: cacheStatus.last_error,
      },
      streaming: streamingBridge.status(),
      backfill: backfillScheduler.status(),
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
// Opt-in via BACKFILL_ENABLED — see services/backfillScheduler.ts.
const backfillScheduler = createBackfillScheduler();

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
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend server running on port ${PORT}`);
  console.log(`IB Service URL: ${IB_SERVICE_URL}`);

  void streamingBridge.start().catch((err) => {
    console.warn('Streaming bridge failed to start:', err);
  });

  backfillScheduler.start();

  void dbService
    .testConnection()
    .then((connected) => {
      if (connected) {
        console.log('Database connection established');
      } else {
        console.warn('Database connection failed - some features may be limited');
      }
    })
    .catch((error) => console.error('Database connection error:', error));

  void cacheService
    .ping()
    .then((ok) => {
      if (ok) {
        console.log('Redis cache reachable');
      } else if (cacheService.status().enabled) {
        console.warn(
          'Redis cache unreachable — caching disabled at runtime, ' +
            'requests will pass through directly'
        );
      }
    })
    .catch((err) => console.warn('Redis cache check error:', err));
});

export default app;
