import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import marketDataRoutes from './routes/marketData.js';
import accountRoutes from './routes/account.js';
import settingsRoutes from './routes/settings.js';
import axios from 'axios';

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

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend server running on port ${PORT}`);
  console.log(`IB Service URL: ${IB_SERVICE_URL}`);
});

export default app;
