import express from 'express';
import type { Request, Response } from 'express';
import axios from 'axios';
import { marketDataService, type Contract, type CandlestickBar, type TechnicalIndicator } from '../services/marketDataService.js';

const router = express.Router();
const IB_SERVICE_URL = process.env.IB_SERVICE_URL || 'http://ib_service:8000';

// Interface for market data request parameters
interface MarketDataQuery {
  symbol: string;
  timeframe: string;
  period: string;
}

// Interface for search request parameters
interface SearchQuery {
  symbol: string;
  secType: string;
  exchange?: string;
  currency?: string;
  searchByName?: boolean;
  account_mode?: string;
}

// Interface for advanced search request parameters
interface AdvancedSearchQuery {
  symbol?: string;
  secType: string;
  exchange?: string;
  currency?: string;
  expiry?: string;
  strike?: number;
  right?: string;
  multiplier?: string;
  includeExpired?: boolean;
  searchByName?: boolean;
  account_mode?: string;
}



// Helper function to check if data query is enabled via headers
function isDataQueryEnabled(req: Request): boolean {
  const enabled = req.headers['x-data-query-enabled'];
  if (typeof enabled === 'string') {
    return enabled.toLowerCase() === 'true';
  }
  if (Array.isArray(enabled)) {
    return enabled[0]?.toLowerCase() === 'true';
  }
  return false;
}

// Helper function to handle disabled data query response
function handleDisabledDataQuery(res: Response, message: string) {
  return res.status(200).json({
    disabled: true,
    message: message,
    timestamp: new Date().toISOString()
  });
}

// Contract search endpoint
router.post('/search', async (req: Request, res: Response) => {
  try {
    const { symbol, secType, exchange, currency, searchByName, account_mode } = req.body as SearchQuery;

    // Validate required parameters
    if (!symbol || !secType) {
      return res.status(400).json({
        error: 'Missing required parameters',
        required: ['symbol', 'secType'],
        received: { symbol, secType, exchange, currency, searchByName }
      });
    }

    // Validate symbol - basic validation
    if (typeof symbol !== 'string' || symbol.trim().length === 0) {
      return res.status(400).json({
        error: 'Invalid symbol format. Symbol must be a non-empty string.',
        symbol: symbol
      });
    }

    // Validate security type
    const validSecTypes = ['STK', 'OPT', 'FUT', 'CASH', 'BOND', 'CFD', 'CMDTY', 'CRYPTO', 'WAR', 'FUND', 'IND', 'BAG'];
    if (!validSecTypes.includes(secType)) {
      return res.status(400).json({
        error: 'Invalid security type',
        valid_secTypes: validSecTypes,
        received: secType
      });
    }

    // Check if data querying is enabled
    if (!isDataQueryEnabled(req)) {
      return handleDisabledDataQuery(res, 'Market data search is disabled');
    }

    console.log(`Searching for contract: ${symbol} (${secType}) on ${exchange || 'any exchange'}`);

    const response = await axios.post(`${IB_SERVICE_URL}/market-data/search`, {
      symbol: symbol,
      secType: secType,
      exchange: exchange,
      currency: currency,
      searchByName: searchByName,
      account_mode: account_mode
    }, {
      timeout: 30000, // 30 second timeout for search
      headers: {
        'Connection': 'close'
      }
    });

    console.log(`Found ${response.data?.contracts?.length || 0} contracts for ${symbol}`);

    // Store contracts in database for future reference
    if (response.data?.contracts && Array.isArray(response.data.contracts)) {
      for (const contract of response.data.contracts) {
        try {
          const contractData: Contract = {
            symbol: contract.symbol,
            secType: contract.secType,
            exchange: contract.exchange,
            currency: contract.currency,
            multiplier: contract.multiplier,
            expiry: contract.expiry,
            strike: contract.strike,
            right: contract.right,
            localSymbol: contract.localSymbol,
            contractId: contract.contractId
          };
          
          await marketDataService.getOrCreateContract(contractData);
        } catch (error) {
          console.error('Error storing contract in database:', error);
          // Continue processing other contracts
        }
      }
    }

    res.json(response.data);

  } catch (error: any) {
    console.error('Error in contract search:', error);
    
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
      errorMessage = error.message || 'Failed to search for contracts';
    }
    
    res.status(statusCode).json({
      error: 'Failed to search for contracts',
      message: errorMessage,
      timestamp: new Date().toISOString()
    });
  }
});

// Advanced search endpoint
router.post('/search/advanced', async (req: Request, res: Response) => {
  try {
    const {
      symbol,
      secType,
      exchange,
      currency,
      expiry,
      strike,
      right,
      multiplier,
      includeExpired,
      searchByName,
      account_mode
    } = req.body as AdvancedSearchQuery;

    // Validate required parameters
    if (!secType) {
      return res.status(400).json({
        error: 'Missing required parameter: secType',
        received: { secType, symbol, exchange, currency, expiry, strike, right, multiplier }
      });
    }

    // Check if data querying is enabled
    if (!isDataQueryEnabled(req)) {
      return handleDisabledDataQuery(res, 'Advanced market data search is disabled');
    }

    console.log(`Advanced search for: ${secType} ${symbol || ''} on ${exchange || 'any exchange'}`);

    const response = await axios.post(`${IB_SERVICE_URL}/market-data/search/advanced`, {
      symbol: symbol,
      secType: secType,
      exchange: exchange,
      currency: currency,
      expiry: expiry,
      strike: strike,
      right: right,
      multiplier: multiplier,
      includeExpired: includeExpired,
      searchByName: searchByName,
      account_mode: account_mode
    }, {
      timeout: 30000,
      headers: {
        'Connection': 'close'
      }
    });

    console.log(`Advanced search found ${response.data?.contracts?.length || 0} contracts`);

    // Store contracts in database
    if (response.data?.contracts && Array.isArray(response.data.contracts)) {
      for (const contract of response.data.contracts) {
        try {
          const contractData: Contract = {
            symbol: contract.symbol,
            secType: contract.secType,
            exchange: contract.exchange,
            currency: contract.currency,
            multiplier: contract.multiplier,
            expiry: contract.expiry,
            strike: contract.strike,
            right: contract.right,
            localSymbol: contract.localSymbol,
            contractId: contract.contractId
          };
          
          await marketDataService.getOrCreateContract(contractData);
        } catch (error) {
          console.error('Error storing contract in database:', error);
        }
      }
    }

    res.json(response.data);

  } catch (error: any) {
    console.error('Error in advanced contract search:', error);
    
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
      errorMessage = error.message || 'Failed to perform advanced search';
    }
    
    res.status(statusCode).json({
      error: 'Failed to perform advanced search',
      message: errorMessage,
      timestamp: new Date().toISOString()
    });
  }
});

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
      use_database = 'true'
    } = req.query as Partial<MarketDataQuery & {
      start_date?: string;
      end_date?: string;
      account_mode?: string;
      secType?: string;
      exchange?: string;
      currency?: string;
      include_indicators?: string;
      use_database?: string;
    }>;

    // Validate required parameters
    if (!symbol || !timeframe) {
      return res.status(400).json({
        error: 'Missing required parameters',
        required: ['symbol', 'timeframe'],
        received: { symbol, timeframe, period, start_date, end_date }
      });
    }

    // Validate timeframe
    const validTimeframes = ['1min', '5min', '15min', '30min', '1hour', '4hour', '8hour', '1day'];
    if (!validTimeframes.includes(timeframe)) {
      return res.status(400).json({
        error: 'Invalid timeframe',
        valid_timeframes: validTimeframes,
        received: timeframe
      });
    }

    // Check if we should use database first
    const useDatabase = use_database === 'true';
    const includeIndicators = include_indicators === 'true';

    if (useDatabase) {
      try {
        // Try to get data from database first
        const startDate = start_date ? new Date(start_date) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
        const endDate = end_date ? new Date(end_date) : new Date();
        
        const dbData = await marketDataService.getHistoricalData(
          symbol,
          timeframe,
          startDate,
          endDate,
          includeIndicators
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
            timestamp: new Date().toISOString()
          });
        }
      } catch (dbError) {
        console.warn('Database query failed, falling back to IB service:', dbError);
      }
    }

    // Fallback to IB service
    console.log(`Fetching historical data from IB service: ${symbol} ${timeframe} ${period}`);

    const response = await axios.get(`${IB_SERVICE_URL}/market-data/history`, {
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
        include_indicators: include_indicators
      },
      timeout: 60000, // 60 second timeout for historical data
      headers: {
        'Connection': 'close'
      }
    });

    console.log(`Retrieved ${response.data?.data?.length || 0} bars from IB service for ${symbol}`);

    // Store data in database if we have valid data
    if (response.data?.data && Array.isArray(response.data.data) && response.data.data.length > 0) {
      try {
        // Get or create contract
        const contractData: Contract = {
          symbol: symbol,
          secType: secType || 'STK',
          exchange: exchange,
          currency: currency
        };
        
        const contractId = await marketDataService.getOrCreateContract(contractData);
        
        // Convert data format and store
        const bars: CandlestickBar[] = response.data.data.map((bar: any) => ({
          timestamp: new Date(bar.time * 1000), // Convert Unix timestamp to Date
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
          wap: bar.wap,
          count: bar.count
        }));

        const storeResult = await marketDataService.storeCandlestickData(contractId, timeframe, bars);
        console.log(`Stored ${storeResult.inserted} new bars, updated ${storeResult.updated} bars for ${symbol} ${timeframe}`);

        // Store technical indicators if included
        if (includeIndicators && response.data?.indicators) {
          for (const bar of response.data.data) {
            const timestamp = new Date(bar.time * 1000);
            const indicators: TechnicalIndicator[] = [];
            
            if (bar.sma_20) indicators.push({ name: 'SMA', period: 20, value: bar.sma_20 });
            if (bar.sma_50) indicators.push({ name: 'SMA', period: 50, value: bar.sma_50 });
            if (bar.ema_12) indicators.push({ name: 'EMA', period: 12, value: bar.ema_12 });
            if (bar.ema_26) indicators.push({ name: 'EMA', period: 26, value: bar.ema_26 });
            if (bar.rsi) indicators.push({ name: 'RSI', period: 14, value: bar.rsi });
            if (bar.macd) indicators.push({ name: 'MACD', period: 12, value: bar.macd });
            if (bar.macd_signal) indicators.push({ name: 'MACD_SIGNAL', period: 26, value: bar.macd_signal });
            if (bar.bb_upper) indicators.push({ name: 'BB_UPPER', period: 20, value: bar.bb_upper });
            if (bar.bb_middle) indicators.push({ name: 'BB_MIDDLE', period: 20, value: bar.bb_middle });
            if (bar.bb_lower) indicators.push({ name: 'BB_LOWER', period: 20, value: bar.bb_lower });

            if (indicators.length > 0) {
              await marketDataService.storeTechnicalIndicators(contractId, timeframe, timestamp, indicators);
            }
          }
        }

      } catch (storeError) {
        console.error('Error storing data in database:', storeError);
        // Continue with response even if storage fails
      }
    }

    res.json({
      ...response.data,
      source: 'ib_service',
      timestamp: new Date().toISOString()
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
      timestamp: new Date().toISOString()
    });
  }
});

// Real-time data endpoint
router.get('/realtime', async (req: Request, res: Response) => {
  try {
    const { symbol, account_mode } = req.query;

    // Validate required parameters
    if (!symbol) {
      return res.status(400).json({
        error: 'Missing required parameter: symbol',
        received: { symbol, account_mode }
      });
    }

    // Check if data querying is enabled
    if (!isDataQueryEnabled(req)) {
      return handleDisabledDataQuery(res, 'Real-time market data querying is disabled');
    }

    console.log(`Fetching real-time data for ${symbol}`);

    const response = await axios.get(`${IB_SERVICE_URL}/market-data/realtime`, {
      params: {
        symbol: symbol,
        account_mode: account_mode
      },
      timeout: 10000, // 10 second timeout for real-time data
      headers: {
        'Connection': 'close'
      }
    });

    console.log(`Retrieved real-time data for ${symbol}`);

    res.json(response.data);

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
      timestamp: new Date().toISOString()
    });
  }
});

// Technical indicators endpoint
router.get('/indicators', async (req: Request, res: Response) => {
  try {
    const { 
      symbol, 
      timeframe, 
      period, 
      indicators, 
      account_mode,
      use_database = 'true'
    } = req.query as {
      symbol: string;
      timeframe: string;
      period: string;
      indicators: string;
      account_mode?: string;
      use_database?: string;
    };

    // Validate required parameters
    if (!symbol || !timeframe || !indicators) {
      return res.status(400).json({
        error: 'Missing required parameters',
        required: ['symbol', 'timeframe', 'indicators'],
        received: { symbol, timeframe, indicators, period, account_mode }
      });
    }

    // Check if data querying is enabled
    if (!isDataQueryEnabled(req)) {
      return handleDisabledDataQuery(res, 'Technical indicators querying is disabled');
    }

    const useDatabase = use_database === 'true';

    if (useDatabase) {
      try {
        // Try to get indicators from database
        const endDate = new Date();
        const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
        
        const dbData = await marketDataService.getHistoricalData(
          symbol,
          timeframe,
          startDate,
          endDate,
          true // Include indicators
        );

        if (dbData.length > 0) {
          console.log(`Retrieved ${dbData.length} bars with indicators from database for ${symbol} ${timeframe}`);
          
          return res.json({
            symbol: symbol,
            timeframe: timeframe,
            indicators: indicators.split(','),
            data: dbData,
            source: 'database',
            count: dbData.length,
            timestamp: new Date().toISOString()
          });
        }
      } catch (dbError) {
        console.warn('Database query failed, falling back to IB service:', dbError);
      }
    }

    // Fallback to IB service
    console.log(`Calculating technical indicators for ${symbol} ${timeframe}`);

    const response = await axios.get(`${IB_SERVICE_URL}/market-data/indicators`, {
      params: {
        symbol: symbol,
        timeframe: timeframe,
        period: period,
        indicators: indicators,
        account_mode: account_mode
      },
      timeout: 30000, // 30 second timeout for indicators
      headers: {
        'Connection': 'close'
      }
    });

    console.log(`Calculated indicators for ${symbol} ${timeframe}`);

    res.json({
      ...response.data,
      source: 'ib_service',
      timestamp: new Date().toISOString()
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
      timestamp: new Date().toISOString()
    });
  }
});

// Database statistics endpoint
router.get('/database/stats', async (req: Request, res: Response) => {
  try {
    const { symbol } = req.query as { symbol?: string };
    
    const stats = await marketDataService.getDataCollectionStats(symbol);
    
    res.json({
      stats: stats,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('Error getting database stats:', error);
    
    res.status(500).json({
      error: 'Failed to get database statistics',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Clean old data endpoint
router.post('/database/clean', async (req: Request, res: Response) => {
  try {
    const result = await marketDataService.cleanOldData();
    
    res.json({
      message: 'Data cleanup completed',
      result: result,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('Error cleaning old data:', error);
    
    res.status(500).json({
      error: 'Failed to clean old data',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

export default router; 