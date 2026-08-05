import express from 'express';
import type { Request, Response } from 'express';
import axios from 'axios';
import { cacheService } from '../../services/cache.js';
import {
  BROKER_SERVICE_URL,
  REALTIME_CACHE_TTL,
  cacheKey,
  isDataQueryEnabled,
  handleDisabledDataQuery,
} from './shared.js';

const router = express.Router();

// Real-time data endpoint
router.get('/realtime', async (req: Request, res: Response) => {
  try {
    const { symbol, account_mode } = req.query;

    // Validate required parameters
    if (!symbol) {
      return res.status(400).json({
        error: 'Missing required parameter: symbol',
        received: { symbol, account_mode },
      });
    }

    // Check if data querying is enabled
    if (!isDataQueryEnabled(req)) {
      return handleDisabledDataQuery(res, 'Real-time market data querying is disabled');
    }

    console.log(`Fetching real-time data for ${symbol}`);

    // Short-TTL cache so we don't hammer IB Gateway when many clients
    // poll the same quote at once. A cache miss falls straight through
    // to the IB service call.
    const key = cacheKey(['rt', String(symbol), String(account_mode || '')]);
    const data = await cacheService.wrap(key, REALTIME_CACHE_TTL, async () => {
      const response = await axios.get(`${BROKER_SERVICE_URL}/market-data/realtime`, {
        params: { symbol, account_mode },
        timeout: 10000,
        headers: { Connection: 'close' },
      });
      return response.data;
    });

    console.log(`Retrieved real-time data for ${symbol}`);

    res.json(data);
  } catch (error: any) {
    console.error('Error fetching real-time data:', error);

    let errorMessage = 'Unknown error';
    let statusCode = 500;

    if (error.code === 'ECONNREFUSED') {
      errorMessage = 'IB Service connection refused - service may be starting up';
      statusCode = 503;
    } else if (error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
      errorMessage = 'Request timed out - IB Service may be busy';
      statusCode = 504;
    } else if (error.response?.status) {
      statusCode = error.response.status;
      errorMessage = error.response.data?.error || error.response.statusText;
    } else {
      errorMessage = error.message || 'Failed to fetch real-time data';
    }

    res.status(statusCode).json({
      error: 'Failed to fetch real-time data',
      message: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
