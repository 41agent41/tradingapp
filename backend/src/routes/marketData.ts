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

// Interface for candlestick data
interface CandlestickBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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

    console.log(`Searching contracts for ${symbol} - ${secType}`);

    // Request contract search from IB service
    const searchPayload = {
      symbol: symbol.trim().toUpperCase(),
      secType: secType,
      exchange: exchange || 'SMART',
      currency: currency || 'USD',
      name: searchByName || false,
      account_mode: account_mode || 'paper' // Default to paper trading
    };

    const response = await axios.post(`${IB_SERVICE_URL}/contract/search`, searchPayload, {
      timeout: 30000 // 30 second timeout for search
    });

    if (response.data.error) {
      return res.status(500).json({
        error: 'IB Service returned error',
        detail: response.data.error,
        ib_service_url: `${IB_SERVICE_URL}/contract/search`
      });
    }

    // Process and filter results based on additional criteria
    let results = response.data.results || response.data || [];
    
    // Ensure results is an array
    if (!Array.isArray(results)) {
      results = [];
    }

    // Filter by exchange if specified
    if (exchange && exchange !== 'SMART') {
      results = results.filter((contract: any) => {
        // Check if exchange matches in sections or description
        if (contract.sections) {
          return contract.sections.some((section: any) => 
            section.exchange && section.exchange.includes(exchange)
          );
        }
        return contract.description && contract.description.includes(exchange);
      });
    }

    // Filter by currency if specified
    if (currency) {
      results = results.filter((contract: any) => {
        return contract.currency === currency || 
               contract.description?.includes(currency) ||
               !contract.currency; // Include contracts without currency specified
      });
    }

    // Transform results to a consistent format
    const transformedResults = results.map((contract: any) => {
      // Extract the relevant section for the requested secType
      let relevantSection = null;
      if (contract.sections) {
        relevantSection = contract.sections.find((section: any) => section.secType === secType);
      }

      return {
        conid: contract.conid,
        symbol: contract.symbol,
        companyName: contract.companyName || contract.symbol,
        description: contract.description || '',
        secType: secType,
        currency: contract.currency || currency || '',
        exchange: relevantSection?.exchange || contract.exchange || exchange || '',
        sections: contract.sections || []
      };
    });

    // Return the processed results
    res.json({
      symbol: symbol.toUpperCase(),
      secType,
      exchange: exchange || 'ANY',
      currency: currency || 'ANY',
      searchByName: searchByName || false,
      results: transformedResults,
      count: transformedResults.length,
      source: 'Interactive Brokers',
      last_updated: new Date().toISOString()
    });

  } catch (error: any) {
    console.error('Error searching contracts:', error);
    
    const errorMessage = error.response?.data?.detail || error.message || 'Unknown error';
    const statusCode = error.response?.status || 500;
    
    res.status(statusCode).json({
      error: 'Failed to search contracts',
      detail: errorMessage,
      ib_service_status: statusCode,
      ib_service_url: `${IB_SERVICE_URL}/contract/search`,
      symbol: req.body.symbol,
      secType: req.body.secType
    });
  }
});

// Advanced contract search endpoint
router.post('/advanced-search', async (req: Request, res: Response) => {
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
        error: 'Missing required parameters',
        required: ['secType'],
        received: { secType, symbol, exchange, currency, expiry, strike, right, multiplier, includeExpired, searchByName }
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

    console.log(`Advanced search for ${symbol || 'ALL'} - ${secType}`);

    // Request advanced contract search from IB service
    const searchPayload = {
      symbol: symbol ? symbol.trim().toUpperCase() : '',
      secType: secType,
      exchange: exchange || 'SMART',
      currency: currency || 'USD',
      expiry: expiry || '',
      strike: strike || 0,
      right: right || '',
      multiplier: multiplier || '',
      includeExpired: includeExpired || false,
      name: searchByName || false,
      account_mode: account_mode || 'paper'
    };

    const response = await axios.post(`${IB_SERVICE_URL}/contract/advanced-search`, searchPayload, {
      timeout: 30000 // 30 second timeout for advanced search
    });

    if (response.data.error) {
      return res.status(500).json({
        error: 'IB Service returned error',
        detail: response.data.error,
        ib_service_url: `${IB_SERVICE_URL}/contract/advanced-search`
      });
    }

    // Process results
    let results = response.data.results || response.data || [];
    
    // Ensure results is an array
    if (!Array.isArray(results)) {
      results = [];
    }

    // Transform results to a consistent format
    const transformedResults = results.map((contract: any) => {
      return {
        conid: contract.conid,
        symbol: contract.symbol,
        companyName: contract.companyName || contract.symbol,
        description: contract.description || '',
        secType: secType,
        currency: contract.currency || currency || '',
        exchange: contract.exchange || exchange || '',
        primaryExchange: contract.primaryExchange || '',
        localSymbol: contract.localSymbol || '',
        tradingClass: contract.tradingClass || '',
        multiplier: contract.multiplier || '',
        strike: contract.strike || '',
        right: contract.right || '',
        expiry: contract.expiry || '',
        includeExpired: contract.includeExpired || false,
        comboLegsDescrip: contract.comboLegsDescrip || '',
        contractMonth: contract.contractMonth || '',
        industry: contract.industry || '',
        category: contract.category || '',
        subcategory: contract.subcategory || '',
        timeZoneId: contract.timeZoneId || '',
        tradingHours: contract.tradingHours || '',
        liquidHours: contract.liquidHours || '',
        evRule: contract.evRule || '',
        evMultiplier: contract.evMultiplier || '',
        secIdList: contract.secIdList || [],
        aggGroup: contract.aggGroup || '',
        underSymbol: contract.underSymbol || '',
        underSecType: contract.underSecType || '',
        marketRuleIds: contract.marketRuleIds || '',
        realExpirationDate: contract.realExpirationDate || '',
        lastTradingDay: contract.lastTradingDay || '',
        stockType: contract.stockType || '',
        minSize: contract.minSize || '',
        sizeIncrement: contract.sizeIncrement || '',
        suggestedSizeIncrement: contract.suggestedSizeIncrement || '',
        sections: contract.sections || []
      };
    });

    // Return the processed results
    res.json({
      symbol: symbol ? symbol.toUpperCase() : 'ALL',
      secType,
      exchange: exchange || 'ANY',
      currency: currency || 'ANY',
      expiry: expiry || 'ANY',
      strike: strike || 'ANY',
      right: right || 'ANY',
      multiplier: multiplier || 'ANY',
      includeExpired: includeExpired || false,
      searchByName: searchByName || false,
      results: transformedResults,
      count: transformedResults.length,
      source: 'Interactive Brokers',
      last_updated: new Date().toISOString()
    });

  } catch (error: any) {
    console.error('Error in advanced contract search:', error);
    
    const errorMessage = error.response?.data?.detail || error.message || 'Unknown error';
    const statusCode = error.response?.status || 500;
    
    res.status(statusCode).json({
      error: 'Failed to perform advanced contract search',
      detail: errorMessage,
      ib_service_status: statusCode,
      ib_service_url: `${IB_SERVICE_URL}/contract/advanced-search`,
      search_params: req.body
    });
  }
});

// Get historical market data
router.get('/history', async (req: Request, res: Response) => {
  try {
    // Check if data querying is enabled
    if (!isDataQueryEnabled(req)) {
      return handleDisabledDataQuery(res, 'Historical market data querying is disabled');
    }

    const { symbol, timeframe, period, account_mode } = req.query as Partial<MarketDataQuery & { account_mode?: string }>;

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

    const accountMode = account_mode || 'paper'; // Default to paper trading
    console.log(`Fetching historical data for ${symbol} - ${timeframe} - ${period} (${accountMode} mode)`);

    // Request historical data from IB service
    const response = await axios.get(`${IB_SERVICE_URL}/market-data/history`, {
      params: {
        symbol: symbol.toUpperCase(),
        timeframe,
        period,
        account_mode: accountMode
      },
      timeout: 20000 // Reduced to 20 seconds for better consistency
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
  const { symbol, account_mode } = req.query;

  if (!symbol) {
    return res.status(400).json({
      error: 'Symbol parameter is required'
    });
  }

  // Check if data querying is enabled
  if (!isDataQueryEnabled(req)) {
    return handleDisabledDataQuery(res, 'Real-time market data querying is disabled');
  }

  try {
    const accountMode = account_mode || 'paper'; // Default to paper trading
    console.log(`Fetching ${accountMode} data for ${symbol} from ${IB_SERVICE_URL}`);

    const response = await axios.get(`${IB_SERVICE_URL}/market-data/realtime`, {
      params: { 
        symbol: (symbol as string).toUpperCase(),
        account_mode: accountMode
      },
      timeout: 15000, // Reduced to 15 seconds to align with frontend
      headers: {
        'Connection': 'close'
      }
    });

    console.log(`Successfully fetched data for ${symbol}:`, response.data);
    res.json(response.data);

  } catch (error: any) {
    console.error('Error fetching real-time market data:', error);
    
    let errorMessage = 'Unknown error';
    let statusCode = 500;
    
    if (error.code === 'ECONNREFUSED') {
      errorMessage = 'IB Service connection refused - service may be starting up';
      statusCode = 503;
    } else if (error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
      errorMessage = 'IB Service timeout - service may be busy or starting up';
      statusCode = 504;
    } else if (error.response) {
      errorMessage = error.response.data?.detail || error.response.statusText || 'IB Service error';
      statusCode = error.response.status;
    } else {
      errorMessage = error.message || 'Failed to connect to IB Service';
    }
    
    res.status(statusCode).json({
      error: 'Failed to fetch real-time market data',
      detail: errorMessage,
      ib_service_status: statusCode,
      ib_service_url: IB_SERVICE_URL,
      symbol: symbol,
      timestamp: new Date().toISOString()
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