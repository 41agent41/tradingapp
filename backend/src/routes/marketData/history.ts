import express from 'express';
import type { Request, Response } from 'express';
import axios from 'axios';
import {
  marketDataService,
  type Contract,
  type CandlestickBar,
} from '../../services/marketDataService.js';
import {
  BROKER_SERVICE_URL,
  VALID_TIMEFRAMES,
  isDataQueryEnabled,
  handleDisabledDataQuery,
  resolveBroker,
  type MarketDataQuery,
} from './shared.js';

const router = express.Router();

// Historical data endpoint - now with database integration
router.get('/history', async (req: Request, res: Response) => {
  try {
    // Check if data querying is enabled
    if (!isDataQueryEnabled(req)) {
      return handleDisabledDataQuery(res, 'Historical market data querying is disabled');
    }

    const {
      symbol,
      timeframe,
      period,
      account_mode,
      start_date,
      end_date,
      secType,
      exchange,
      currency,
      include_indicators = 'false',
      use_database = 'true',
      source,
      broker,
    } = req.query as Partial<
      MarketDataQuery & {
        start_date?: string;
        end_date?: string;
        account_mode?: string;
        secType?: string;
        exchange?: string;
        currency?: string;
        include_indicators?: string;
        use_database?: string;
        source?: string;
        broker?: string;
      }
    >;
    const venue = resolveBroker(source ?? broker);

    // Validate required parameters
    if (!symbol || !timeframe) {
      return res.status(400).json({
        error: 'Missing required parameters',
        required: ['symbol', 'timeframe'],
        received: { symbol, timeframe, period, start_date, end_date },
      });
    }

    // Validate timeframe
    if (!VALID_TIMEFRAMES.includes(timeframe)) {
      return res.status(400).json({
        error: 'Invalid timeframe',
        valid_timeframes: VALID_TIMEFRAMES,
        received: timeframe,
      });
    }

    const includeIndicators = include_indicators === 'true';
    // The DB cache stores raw OHLCV only (indicators are computed on demand —
    // GAP_ANALYSIS §3.2). When indicators are requested we skip the cache and
    // go straight to the IB service, which computes them.
    const useDatabase = use_database === 'true' && !includeIndicators;

    if (useDatabase) {
      try {
        // Try to get data from database first
        const startDate = start_date
          ? new Date(start_date)
          : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
        const endDate = end_date ? new Date(end_date) : new Date();

        const dbData = await marketDataService.getHistoricalData(
          symbol,
          timeframe,
          startDate,
          endDate
        );

        if (dbData.length > 0) {
          console.log(`Retrieved ${dbData.length} bars from database for ${symbol} ${timeframe}`);

          return res.json({
            symbol: symbol,
            timeframe: timeframe,
            data: dbData,
            source: 'database',
            count: dbData.length,
            start_date: startDate.toISOString(),
            end_date: endDate.toISOString(),
            timestamp: new Date().toISOString(),
          });
        }
      } catch (dbError) {
        console.warn('Database query failed, falling back to IB service:', dbError);
      }
    }

    // Fallback to IB service
    console.log(`Fetching historical data from IB service: ${symbol} ${timeframe} ${period}`);

    const response = await axios.get(`${BROKER_SERVICE_URL}/market-data/history`, {
      params: {
        symbol: symbol,
        timeframe: timeframe,
        period: period,
        account_mode: account_mode,
        start_date: start_date,
        end_date: end_date,
        secType: secType,
        exchange: exchange,
        currency: currency,
        include_indicators: include_indicators,
        source: venue,
      },
      timeout: 60000, // 60 second timeout for historical data
      headers: {
        Connection: 'close',
      },
    });

    console.log(`Retrieved ${response.data?.bars?.length || 0} bars from IB service for ${symbol}`);

    // Cache the fetched bars in the database.
    //
    // The IB service returns its bars under `bars` with a numeric `timestamp`
    // (unix seconds) — see broker_service `HistoricalDataResponse`. Indicators are
    // intentionally NOT persisted (GAP_ANALYSIS §3.2); only raw OHLCV is stored.
    const ibBars = Array.isArray(response.data?.bars) ? response.data.bars : [];
    if (ibBars.length > 0) {
      try {
        // Get or create contract (broker-scoped catalogue, B1)
        const contractData: Contract = {
          broker: venue,
          symbol: symbol,
          secType: secType || 'STK',
          exchange: exchange,
          currency: currency,
        };

        const contractId = await marketDataService.getOrCreateContract(contractData);

        // Convert data format and store
        const bars: CandlestickBar[] = ibBars.map((bar: any) => ({
          timestamp: new Date(bar.timestamp * 1000), // Convert Unix timestamp to Date
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
          wap: bar.wap,
          count: bar.count,
        }));

        const storeResult = await marketDataService.storeCandlestickData(
          contractId,
          timeframe,
          bars
        );
        console.log(
          `Stored ${storeResult.inserted} new bars, updated ${storeResult.updated} bars for ${symbol} ${timeframe}`
        );

        // Record data-quality metrics for the batch (best-effort).
        try {
          await marketDataService.recordDataQuality(contractId, timeframe, bars);
        } catch (qualityError) {
          console.warn(
            `Failed to record data-quality metrics for ${symbol} ${timeframe}:`,
            qualityError
          );
        }
      } catch (storeError) {
        console.error('Error storing data in database:', storeError);
        // Continue with response even if storage fails
      }
    }

    res.json({
      ...response.data,
      source: 'broker_service',
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Error fetching historical data:', error);

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
      errorMessage = error.message || 'Failed to fetch historical data';
    }

    res.status(statusCode).json({
      error: 'Failed to fetch historical data',
      message: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
