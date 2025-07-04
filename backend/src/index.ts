import express from 'express';
import type { Request, Response } from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import settingsRouter from './routes/settings';
import marketDataRouter from './routes/marketData';
import bodyParser from 'body-parser';
import cors from 'cors';
import axios from 'axios';

const app = express();
const server = createServer(app);

// Parse CORS origins from environment variable or use defaults
const corsOrigins = process.env.CORS_ORIGINS 
  ? process.env.CORS_ORIGINS.split(',').map(origin => origin.trim())
  : ['http://localhost:3000'];

const io = new Server(server, {
  cors: {
    origin: corsOrigins,
    methods: ['GET', 'POST']
  }
});

const PORT = parseInt(process.env.PORT || '4000', 10);
const HOST = '0.0.0.0';
const IB_SERVICE_URL = process.env.IB_SERVICE_URL || 'http://ib_service:8000';

// Configure CORS to allow requests from frontend
app.use(cors({
  origin: corsOrigins,
  credentials: true
}));

app.use(bodyParser.json());

// Track active market data subscriptions
const activeSubscriptions = new Set<string>();

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
  
  // Handle market data subscription
  socket.on('subscribe-market-data', async (data) => {
    const { symbol, timeframe } = data;
    console.log(`Client ${socket.id} subscribing to ${symbol} - ${timeframe}`);
    
    try {
      // Subscribe to market data via IB service
      await axios.post(`${IB_SERVICE_URL}/market-data/subscribe`, {
        symbol: symbol.toUpperCase(),
        timeframe: timeframe || 'tick'
      });
      
      socket.emit('subscription-confirmed', { symbol, timeframe });
      activeSubscriptions.add(symbol.toUpperCase());
    } catch (error) {
      console.error('Error subscribing to market data:', error);
      socket.emit('subscription-error', { symbol, timeframe, error: 'Failed to subscribe' });
    }
  });
  
  // Handle market data unsubscription
  socket.on('unsubscribe-market-data', async (data) => {
    const { symbol } = data;
    console.log(`Client ${socket.id} unsubscribing from ${symbol}`);
    
    try {
      await axios.post(`${IB_SERVICE_URL}/market-data/unsubscribe`, {
        symbol: symbol.toUpperCase()
      });
      
      socket.emit('unsubscription-confirmed', { symbol });
      activeSubscriptions.delete(symbol.toUpperCase());
    } catch (error) {
      console.error('Error unsubscribing from market data:', error);
      socket.emit('unsubscription-error', { symbol, error: 'Failed to unsubscribe' });
    }
  });
  
  // Send initial data when client connects
  fetchAndEmitAccountData();
});

// Function to fetch and emit account data
async function fetchAndEmitAccountData() {
  try {
    const [accountResponse, positionsResponse, ordersResponse] = await Promise.all([
      axios.get(`${IB_SERVICE_URL}/account`).catch(err => ({ data: { error: err.message } })),
      axios.get(`${IB_SERVICE_URL}/positions`).catch(err => ({ data: { error: err.message } })),
      axios.get(`${IB_SERVICE_URL}/orders`).catch(err => ({ data: { error: err.message } }))
    ]);

    const data = {
      account: accountResponse.data,
      positions: positionsResponse.data,
      orders: ordersResponse.data,
      timestamp: new Date().toISOString()
    };

    io.emit('accountData', data);
  } catch (error) {
    console.error('Error fetching account data:', error);
    io.emit('accountData', { 
      error: 'Failed to fetch account data',
      timestamp: new Date().toISOString()
    });
  }
}

// Function to fetch and emit real-time market data for active subscriptions
async function fetchAndEmitMarketData() {
  try {
    if (activeSubscriptions.size === 0) {
      return; // No active subscriptions
    }

    // Fetch real-time data for all active symbols
    const promises = Array.from(activeSubscriptions).map(async (symbol) => {
      try {
        const response = await axios.get(`${IB_SERVICE_URL}/market-data/realtime?symbol=${symbol}`);
        
        if (response.data && !response.data.error) {
          // Emit real-time market data to all connected clients
          io.emit('market-data-update', {
            symbol: symbol,
            data: response.data,
            timestamp: new Date().toISOString()
          });
        }
      } catch (error) {
        console.error(`Error fetching real-time data for ${symbol}:`, error);
      }
    });

    await Promise.all(promises);
  } catch (error) {
    console.error('Error in fetchAndEmitMarketData:', error);
  }
}

// Set up periodic data updates
setInterval(fetchAndEmitAccountData, 5000);
setInterval(fetchAndEmitMarketData, 1000); // Real-time data every second

// Root route with API information
app.get('/', (_req: Request, res: Response) => {
  res.json({
    message: 'TradingApp Backend API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      settings: '/api/settings',
      account: '/api/account',
      positions: '/api/positions', 
      orders: '/api/orders'
    },
    socketio: {
      enabled: true,
      events: ['accountData']
    },
    documentation: 'This is the backend API for TradingApp. Use the frontend for the web interface.'
  });
});

// API routes to proxy IB service data
app.get('/api/account', async (_req: Request, res: Response) => {
  try {
    const response = await axios.get(`${IB_SERVICE_URL}/account`);
    res.json(response.data);
  } catch (error: any) {
    console.error('Error fetching account data:', error);
    const errorMessage = error.response?.data?.detail || error.message || 'Unknown error';
    const statusCode = error.response?.status || 500;
    res.status(statusCode).json({ 
      error: 'Failed to fetch account data',
      detail: errorMessage,
      ib_service_status: statusCode,
      ib_service_url: `${IB_SERVICE_URL}/account`
    });
  }
});

app.get('/api/positions', async (_req: Request, res: Response) => {
  try {
    const response = await axios.get(`${IB_SERVICE_URL}/positions`);
    res.json(response.data);
  } catch (error: any) {
    console.error('Error fetching positions data:', error);
    const errorMessage = error.response?.data?.detail || error.message || 'Unknown error';
    const statusCode = error.response?.status || 500;
    res.status(statusCode).json({ 
      error: 'Failed to fetch positions data',
      detail: errorMessage,
      ib_service_status: statusCode
    });
  }
});

app.get('/api/orders', async (_req: Request, res: Response) => {
  try {
    const response = await axios.get(`${IB_SERVICE_URL}/orders`);
    res.json(response.data);
  } catch (error: any) {
    console.error('Error fetching orders data:', error);
    const errorMessage = error.response?.data?.detail || error.message || 'Unknown error';
    const statusCode = error.response?.status || 500;
    res.status(statusCode).json({ 
      error: 'Failed to fetch orders data',
      detail: errorMessage,
      ib_service_status: statusCode
    });
  }
});

// Add debug endpoints to check IB service status
app.get('/api/ib-status', async (_req: Request, res: Response) => {
  try {
    const response = await axios.get(`${IB_SERVICE_URL}/health`);
    res.json({
      ib_service_reachable: true,
      ib_service_health: response.data
    });
  } catch (error: any) {
    console.error('Error checking IB service health:', error);
    res.status(500).json({
      ib_service_reachable: false,
      error: error.message,
      ib_service_url: `${IB_SERVICE_URL}/health`
    });
  }
});

app.get('/api/ib-connection', async (_req: Request, res: Response) => {
  try {
    const response = await axios.get(`${IB_SERVICE_URL}/connection`);
    res.json(response.data);
  } catch (error: any) {
    console.error('Error checking IB connection status:', error);
    res.status(500).json({
      error: 'Failed to check IB connection',
      detail: error.message
    });
  }
});

app.post('/api/ib-connect', async (_req: Request, res: Response) => {
  try {
    const response = await axios.post(`${IB_SERVICE_URL}/connect`);
    res.json(response.data);
  } catch (error: any) {
    console.error('Error connecting to IB Gateway:', error);
    const errorMessage = error.response?.data?.detail || error.message || 'Unknown error';
    const statusCode = error.response?.status || 500;
    res.status(statusCode).json({
      error: 'Failed to connect to IB Gateway',
      detail: errorMessage
    });
  }
});

app.use('/api/settings', settingsRouter);
app.use('/api/market-data', marketDataRouter);

app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));

server.listen(PORT, HOST, () => {
  console.log(`Backend listening on ${HOST}:${PORT}`);
  console.log(`CORS enabled for: ${corsOrigins.join(', ')}`);
  console.log(`Socket.io enabled for real-time updates`);
  console.log(`IB Service URL: ${IB_SERVICE_URL}`);
  console.log(`API Documentation available at: http://${HOST}:${PORT}/`);
});
