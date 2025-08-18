import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import marketDataRoutes from './routes/marketData.js';
import accountRoutes from './routes/account.js';
import settingsRoutes from './routes/settings.js';
import axios from 'axios';

// Database imports
import { 
  initializeDatabase, 
  testPostgresConnection, 
  closePostgresConnection 
} from './database/postgres.js';
import { 
  initializeRedis, 
  testRedisConnection, 
  closeRedisConnection 
} from './database/redis.js';

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = (process.env.PORT ? parseInt(process.env.PORT, 10) : 4000);
const IB_SERVICE_URL = process.env.IB_SERVICE_URL || 'http://ib_service:8000';

// Middleware
app.use(cors());
app.use(express.json());

// Initialize database connections
async function initializeDatabases(): Promise<void> {
  try {
    console.log('🔄 Initializing database connections...');
    
    // Initialize PostgreSQL
    console.log('📊 Initializing PostgreSQL connection...');
    const postgresConnected = await testPostgresConnection();
    if (postgresConnected) {
      await initializeDatabase();
      console.log('✅ PostgreSQL initialized successfully');
    } else {
      console.warn('⚠️ PostgreSQL connection failed - continuing without database');
    }
    
    // Initialize Redis
    console.log('🔴 Initializing Redis connection...');
    try {
      await initializeRedis();
      console.log('✅ Redis initialized successfully');
    } catch (error) {
      console.warn('⚠️ Redis connection failed - continuing without cache');
    }
    
    console.log('✅ Database initialization completed');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    // Continue without databases if they're not available
  }
}

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    // Check IB service health
    const ibResponse = await axios.get(`${IB_SERVICE_URL}/health`, { timeout: 5000 });
    
    // Check database connections
    const postgresStatus = await testPostgresConnection();
    const redisStatus = await testRedisConnection();
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        backend: {
          status: 'running',
          port: PORT
        },
        ib_service: {
          status: ibResponse.data?.status || 'unknown',
          connected: ibResponse.data?.connection?.ib_gateway?.connected || false,
          url: IB_SERVICE_URL
        },
        postgres: {
          status: postgresStatus ? 'connected' : 'disconnected',
          host: process.env.POSTGRES_HOST
        },
        redis: {
          status: redisStatus ? 'connected' : 'disconnected',
          host: process.env.REDIS_HOST
        }
      }
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      services: {
        backend: {
          status: 'running',
          port: PORT
        },
        ib_service: {
          status: 'error',
          connected: false,
          url: IB_SERVICE_URL,
          error: error instanceof Error ? error.message : 'Unknown error'
        },
        postgres: {
          status: 'unknown',
          host: process.env.POSTGRES_HOST
        },
        redis: {
          status: 'unknown',
          host: process.env.REDIS_HOST
        }
      }
    });
  }
});

// Routes
app.use('/api/market-data', marketDataRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/settings', settingsRoutes);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'TradingApp Backend API',
    version: '1.0.0',
    endpoints: {
      health: '/api/health',
      market_data: '/api/market-data',
      settings: '/api/settings'
    }
  });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // Handle market data subscription
  socket.on('subscribe-market-data', async (data) => {
    const { symbol, timeframe } = data;
    console.log(`Client ${socket.id} subscribing to ${symbol} - ${timeframe}`);
    
    try {
      // Subscribe to IB service
      await axios.post(`${IB_SERVICE_URL}/market-data/subscribe`, {
        symbol: symbol,
        timeframe: timeframe
      });
      
      socket.join(`market-data-${symbol}`);
      socket.emit('subscription-confirmed', { symbol, timeframe });
    } catch (error) {
      console.error('Subscription error:', error);
      socket.emit('subscription-error', { 
        symbol, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  });

  // Handle market data unsubscription
  socket.on('unsubscribe-market-data', async (data) => {
    const { symbol } = data;
    console.log(`Client ${socket.id} unsubscribing from ${symbol}`);
    
    try {
      await axios.post(`${IB_SERVICE_URL}/market-data/unsubscribe`, {
        symbol: symbol
      });
      
      socket.leave(`market-data-${symbol}`);
      socket.emit('unsubscription-confirmed', { symbol });
    } catch (error) {
      console.error('Unsubscription error:', error);
      socket.emit('unsubscription-error', { 
        symbol, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    }
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🔄 Received SIGTERM, shutting down gracefully...');
  
  try {
    await closePostgresConnection();
    await closeRedisConnection();
    console.log('✅ Database connections closed');
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
  }
  
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🔄 Received SIGINT, shutting down gracefully...');
  
  try {
    await closePostgresConnection();
    await closeRedisConnection();
    console.log('✅ Database connections closed');
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
  }
  
  process.exit(0);
});

// Start server
async function startServer() {
  try {
    // Initialize databases first
    await initializeDatabases();
    
    // Start the server
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ Backend server running on port ${PORT}`);
      console.log(`📊 IB Service URL: ${IB_SERVICE_URL}`);
      console.log(`📊 PostgreSQL Host: ${process.env.POSTGRES_HOST || 'not configured'}`);
      console.log(`🔴 Redis Host: ${process.env.REDIS_HOST || 'not configured'}`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

export default app;
