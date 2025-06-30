import express from 'express';
import type { Request, Response } from 'express';
import axios from 'axios';

const router = express.Router();
const IB_SERVICE_URL = process.env.IB_SERVICE_URL || 'http://ib_service:8000';

// Interface for market data request parameters
interface MarketDataQuery {
  symbol: string;
  timeframe: string;
  period: string;
}

// Interface for candlestick data
interface CandlestickBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Get historical market data
router.get('/history', async (req: Request, res: Response) => {
  try {
    const { symbol, timeframe, period } = req.query as Partial<MarketDataQuery>;

    // Validate required parameters
    if (!symbol || !timeframe || !period) {
      return res.status(400).json({
        error: 'Missing required parameters',
        required: ['symbol', 'timeframe', 'period'],
        received: { symbol, timeframe, period }
      });
    }

    // Validate symbol - basic validation
    if (!/^[A-Z]{1,10}$/.test(symbol.toUpperCase())) {
      return res.status(400).json({
        error: 'Invalid symbol format. Symbol should be 1-10 uppercase letters.',
        symbol: symbol
      });
    }

    // Validate timeframe
    const validTimeframes = ['5min', '15min', '30min', '1hour', '4hour', '8hour', '1day'];
    if (!validTimeframes.includes(timeframe)) {
      return res.status(400).json({
        error: 'Invalid timeframe',
        valid_timeframes: validTimeframes,
        received: timeframe
      });
    }

    console.log(`Fetching historical data for ${symbol} - ${timeframe} - ${period}`);

    // Request historical data from IB service
    const response = await axios.get(`${IB_SERVICE_URL}/market-data/history`, {
      params: {
        symbol: symbol.toUpperCase(),
        timeframe,
        period
      },
      timeout: 30000 // 30 second timeout for historical data
    });

    if (response.data.error) {
      return res.status(500).json({
        error: 'IB Service returned error',
        detail: response.data.error,
        ib_service_url: `${IB_SERVICE_URL}/market-data/history`
      });
    }

    // Return the data in TradingView format
    res.json({
      symbol: symbol.toUpperCase(),
      timeframe,
      period,
      bars: response.data.bars || [],
      count: response.data.bars?.length || 0,
      source: 'Interactive Brokers',
      last_updated: new Date().toISOString()
    });

  } catch (error: any) {
    console.error('Error fetching historical market data:', error);
    
    const errorMessage = error.response?.data?.detail || error.message || 'Unknown error';
    const statusCode = error.response?.status || 500;
    
    res.status(statusCode).json({
      error: 'Failed to fetch historical market data',
      detail: errorMessage,
      ib_service_status: statusCode,
      ib_service_url: `${IB_SERVICE_URL}/market-data/history`,
      symbol: req.query.symbol,
      timeframe: req.query.timeframe,
      period: req.query.period
    });
  }
});

// Get real-time market data (current price)
router.get('/realtime', async (req: Request, res: Response) => {
  try {
    const { symbol } = req.query;

    if (!symbol) {
      return res.status(400).json({
        error: 'Symbol parameter is required'
      });
    }

    console.log(`Fetching real-time data for ${symbol}`);

    const response = await axios.get(`${IB_SERVICE_URL}/market-data/realtime`, {
      params: { symbol: (symbol as string).toUpperCase() },
      timeout: 10000
    });

    res.json(response.data);

  } catch (error: any) {
    console.error('Error fetching real-time market data:', error);
    
    const errorMessage = error.response?.data?.detail || error.message || 'Unknown error';
    const statusCode = error.response?.status || 500;
    
    res.status(statusCode).json({
      error: 'Failed to fetch real-time market data',
      detail: errorMessage,
      ib_service_status: statusCode
    });
  }
});

// Subscribe to real-time market data updates
router.post('/subscribe', async (req: Request, res: Response) => {
  try {
    const { symbol, timeframe } = req.body;

    if (!symbol) {
      return res.status(400).json({
        error: 'Symbol is required in request body'
      });
    }

    console.log(`Subscribing to real-time updates for ${symbol} - ${timeframe || 'tick'}`);

    const response = await axios.post(`${IB_SERVICE_URL}/market-data/subscribe`, {
      symbol: symbol.toUpperCase(),
      timeframe: timeframe || 'tick'
    });

    res.json({
      message: `Subscribed to real-time data for ${symbol}`,
      subscription: response.data
    });

  } catch (error: any) {
    console.error('Error subscribing to market data:', error);
    
    const errorMessage = error.response?.data?.detail || error.message || 'Unknown error';
    const statusCode = error.response?.status || 500;
    
    res.status(statusCode).json({
      error: 'Failed to subscribe to market data',
      detail: errorMessage,
      ib_service_status: statusCode
    });
  }
});

// Unsubscribe from real-time market data
router.post('/unsubscribe', async (req: Request, res: Response) => {
  try {
    const { symbol } = req.body;

    if (!symbol) {
      return res.status(400).json({
        error: 'Symbol is required in request body'
      });
    }

    console.log(`Unsubscribing from real-time updates for ${symbol}`);

    const response = await axios.post(`${IB_SERVICE_URL}/market-data/unsubscribe`, {
      symbol: symbol.toUpperCase()
    });

    res.json({
      message: `Unsubscribed from real-time data for ${symbol}`,
      result: response.data
    });

  } catch (error: any) {
    console.error('Error unsubscribing from market data:', error);
    
    const errorMessage = error.response?.data?.detail || error.message || 'Unknown error';
    
    res.status(500).json({
      error: 'Failed to unsubscribe from market data',
      detail: errorMessage
    });
  }
});

export default router; 