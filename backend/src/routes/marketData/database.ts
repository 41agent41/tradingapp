import express from 'express';
import type { Request, Response } from 'express';
import { marketDataService } from '../../services/marketDataService.js';
import { isDataQueryEnabled, handleDisabledDataQuery } from './shared.js';

const router = express.Router();

// Database statistics endpoint
router.get('/database/stats', async (req: Request, res: Response) => {
  try {
    const { symbol, broker } = req.query as { symbol?: string; broker?: string };

    const stats = await marketDataService.getDataCollectionStats(symbol, broker);

    res.json({
      stats: stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Error getting database stats:', error);

    res.status(500).json({
      error: 'Failed to get database statistics',
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Upload historical data to database endpoint
router.post('/upload', async (req: Request, res: Response) => {
  try {
    const { symbol, timeframe, bars, account_mode, secType, exchange, currency } = req.body;

    // Validate required parameters
    if (!symbol || !timeframe || !bars || !Array.isArray(bars)) {
      return res.status(400).json({
        error: 'Missing required parameters',
        required: ['symbol', 'timeframe', 'bars'],
        received: { symbol, timeframe, bars: bars ? 'array' : 'missing' },
      });
    }

    // Check if data querying is enabled
    if (!isDataQueryEnabled(req)) {
      return handleDisabledDataQuery(res, 'Data upload is disabled');
    }

    console.log(`Uploading ${bars.length} bars for ${symbol} ${timeframe} to database`);

    // Upload data to database using market data service
    const result = await marketDataService.uploadHistoricalData({
      symbol,
      timeframe,
      bars,
      account_mode: account_mode || 'paper',
      secType: secType || 'STK',
      exchange: exchange || 'SMART',
      currency: currency || 'USD',
    });

    console.log(
      `Successfully uploaded ${result.uploaded_count} records for ${symbol} ${timeframe}`
    );

    res.json({
      message: 'Data uploaded successfully',
      uploaded_count: result.uploaded_count,
      skipped_count: result.skipped_count,
      symbol,
      timeframe,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Error uploading data to database:', error);

    let errorMessage = 'Unknown error';
    let statusCode = 500;

    if (error.code === 'ECONNREFUSED') {
      errorMessage = 'Database connection refused';
      statusCode = 503;
    } else if (error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
      errorMessage = 'Database operation timed out';
      statusCode = 504;
    } else if (error.response?.status) {
      statusCode = error.response.status;
      errorMessage = error.response.data?.error || error.response.statusText;
    } else {
      errorMessage = error.message || 'Failed to upload data to database';
    }

    res.status(statusCode).json({
      error: 'Failed to upload data to database',
      message: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }
});

// Clean old data endpoint
router.post('/database/clean', async (_req: Request, res: Response) => {
  try {
    const result = await marketDataService.cleanOldData();

    res.json({
      message: 'Data cleanup completed',
      result: result,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Error cleaning old data:', error);

    res.status(500).json({
      error: 'Failed to clean old data',
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
