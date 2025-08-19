import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import marketDataRoutes from './routes/marketData.js';
import accountRoutes from './routes/account.js';
import settingsRoutes from './routes/settings.js';
import axios from 'axios';
import { dbService } from './services/database.js';

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

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    // Check IB service health
    const ibResponse = await axios.get(`${IB_SERVICE_URL}/health`, { timeout: 5000 });
    
    // Check database health
    const dbConnected = await dbService.testConnection();
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        backend: {
          status: 'running',
          port: PORT
        },
        database: {
          status: dbConnected ? 'connected' : 'disconnected',
          connected: dbConnected
        },
        ib_service: {
          status: ibResponse.data?.status || 'unknown',
          connected: ibResponse.data?.connection?.ib_gateway?.connected || false,
          url: IB_SERVICE_URL
        }
      }
    });
  } catch (error) {
    // Check database health even if IB service fails
    const dbConnected = await dbService.testConnection();
    
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      services: {
        backend: {
          status: 'running',
          port: PORT
        },
        database: {
          status: dbConnected ? 'connected' : 'disconnected',
          connected: dbConnected
        },
        ib_service: {
          status: 'error',
          connected: false,
          url: IB_SERVICE_URL,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    });
  }
});

// Database health check endpoint
app.get('/api/database/health', async (req, res) => {
  try {
    const connected = await dbService.testConnection();
    
    if (connected) {
      res.json({
        status: 'healthy',
        database: 'connected',
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(503).json({
        status: 'unhealthy',
        database: 'disconnected',
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      database: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
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
      database_health: '/api/database/health',
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
  console.log('SIGTERM received, shutting down gracefully');
  await dbService.close();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully');
  await dbService.close();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend server running on port ${PORT}`);
  console.log(`IB Service URL: ${IB_SERVICE_URL}`);
  
  // Test database connection on startup
  dbService.testConnection().then(connected => {
    if (connected) {
      console.log('Database connection established');
    } else {
      console.warn('Database connection failed - some features may be limited');
    }
  }).catch(error => {
    console.error('Database connection error:', error);
  });
});

export default app;
