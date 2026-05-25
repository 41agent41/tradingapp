import express from 'express';
import type { Request, Response } from 'express';
import axios from 'axios';
import { cacheService } from '../../services/cache.js';
import { IB_SERVICE_URL, isDataQueryEnabled, handleDisabledDataQuery } from './shared.js';

const router = express.Router();

// Technical indicators endpoint.
//
// Indicators are computed on demand by the IB service (ib_service/indicators.py)
// and are NOT persisted in the database — the canonical schema omits the
// `technical_indicators` table (GAP_ANALYSIS §3.2). This endpoint therefore
// always proxies to the IB service rather than reading a DB cache.
router.get('/indicators', async (req: Request, res: Response) => {
  try {
    const { symbol, timeframe, period, indicators, account_mode } = req.query as {
      symbol: string;
      timeframe: string;
      period: string;
      indicators: string;
      account_mode?: string;
    };

    // Validate required parameters
    if (!symbol || !timeframe || !indicators) {
      return res.status(400).json({
        error: 'Missing required parameters',
        required: ['symbol', 'timeframe', 'indicators'],
        received: { symbol, timeframe, indicators, period, account_mode },
      });
    }

    // Check if data querying is enabled
    if (!isDataQueryEnabled(req)) {
      return handleDisabledDataQuery(res, 'Technical indicators querying is disabled');
    }

    console.log(`Calculating technical indicators for ${symbol} ${timeframe}`);

    const response = await axios.get(`${IB_SERVICE_URL}/market-data/indicators`, {
      params: {
        symbol: symbol,
        timeframe: timeframe,
        period: period,
        indicators: indicators,
        account_mode: account_mode,
      },
      timeout: 30000, // 30 second timeout for indicators
      headers: {
        Connection: 'close',
      },
    });

    console.log(`Calculated indicators for ${symbol} ${timeframe}`);

    res.json({
      ...response.data,
      source: 'ib_service',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Error calculating technical indicators:', error);

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
      errorMessage = error.message || 'Failed to calculate technical indicators';
    }

    res.status(statusCode).json({
      error: 'Failed to calculate technical indicators',
      message: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }
});

// Proxy: list available technical indicators from the IB service.
// Frontend code historically hit the IB service on :8000 directly to get
// this catalogue, which bypassed CORS and auth. Going through the
// backend keeps everything behind the same security perimeter.
router.get('/indicators/available', async (_req: Request, res: Response) => {
  try {
    const data = await cacheService.wrap('indicators:available', 3600, async () => {
      const response = await axios.get(`${IB_SERVICE_URL}/indicators/available`, {
        timeout: 5000,
      });
      return response.data;
    });
    res.json(data);
  } catch (error: any) {
    console.error('Error fetching available indicators:', error);
    res.status(502).json({
      error: 'Failed to fetch available indicators',
      message: error?.message || 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
