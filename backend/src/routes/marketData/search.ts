import express from 'express';
import type { Request, Response } from 'express';
import axios from 'axios';
import { marketDataService, type Contract } from '../../services/marketDataService.js';
import {
  BROKER_SERVICE_URL,
  VALID_SEC_TYPES,
  isDataQueryEnabled,
  handleDisabledDataQuery,
  resolveBroker,
  type SearchQuery,
  type AdvancedSearchQuery,
} from './shared.js';

const router = express.Router();

/**
 * Save the contracts a broker-service search returned to the catalogue. The
 * broker service answers `{ results: [...] }`; each result's `conid` is IB's
 * numeric id, or a venue's own instrument name (OANDA's `EUR_USD`), which has
 * no numeric id to keep.
 */
async function storeContracts(venue: string, data: any): Promise<void> {
  const found = Array.isArray(data?.results) ? data.results : [];
  for (const contract of found) {
    try {
      const conid = Number(contract.conid ?? contract.contractId);
      const contractData: Contract = {
        broker: venue,
        symbol: contract.symbol,
        secType: contract.secType,
        exchange: contract.exchange,
        currency: contract.currency,
        multiplier: contract.multiplier || undefined,
        expiry: contract.expiry || undefined,
        strike: Number(contract.strike) || undefined,
        right: contract.right || undefined,
        localSymbol: contract.localSymbol || undefined,
        contractId: Number.isInteger(conid) ? conid : undefined,
      };
      await marketDataService.getOrCreateContract(contractData);
    } catch (error) {
      console.error('Error storing contract in database:', error);
      // Continue processing other contracts
    }
  }
}

// Contract search endpoint
router.post('/search', async (req: Request, res: Response) => {
  try {
    const { symbol, secType, exchange, currency, searchByName, account_mode, broker, source } =
      req.body as SearchQuery;
    const venue = resolveBroker(broker ?? source);

    // Validate required parameters
    if (!symbol || !secType) {
      return res.status(400).json({
        error: 'Missing required parameters',
        required: ['symbol', 'secType'],
        received: { symbol, secType, exchange, currency, searchByName },
      });
    }

    // Validate symbol - basic validation
    if (typeof symbol !== 'string' || symbol.trim().length === 0) {
      return res.status(400).json({
        error: 'Invalid symbol format. Symbol must be a non-empty string.',
        symbol: symbol,
      });
    }

    // Validate security type
    if (!VALID_SEC_TYPES.includes(secType)) {
      return res.status(400).json({
        error: 'Invalid security type',
        valid_secTypes: VALID_SEC_TYPES,
        received: secType,
      });
    }

    // Check if data querying is enabled
    if (!isDataQueryEnabled(req)) {
      return handleDisabledDataQuery(res, 'Market data search is disabled');
    }

    console.log(`Searching for contract: ${symbol} (${secType}) on ${exchange || 'any exchange'}`);

    const response = await axios.post(
      `${BROKER_SERVICE_URL}/contract/search`,
      {
        symbol: symbol,
        secType: secType,
        exchange: exchange,
        currency: currency,
        name: searchByName,
        account_mode: account_mode,
        source: venue,
      },
      {
        timeout: 30000, // 30 second timeout for search
        headers: {
          Connection: 'close',
        },
      }
    );

    console.log(`Found ${response.data?.results?.length || 0} contracts for ${symbol}`);

    await storeContracts(venue, response.data);

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
      timestamp: new Date().toISOString(),
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
      account_mode,
      broker,
      source,
    } = req.body as AdvancedSearchQuery;
    const venue = resolveBroker(broker ?? source);

    // Validate required parameters
    if (!secType) {
      return res.status(400).json({
        error: 'Missing required parameter: secType',
        received: { secType, symbol, exchange, currency, expiry, strike, right, multiplier },
      });
    }

    // Check if data querying is enabled
    if (!isDataQueryEnabled(req)) {
      return handleDisabledDataQuery(res, 'Advanced market data search is disabled');
    }

    console.log(`Advanced search for: ${secType} ${symbol || ''} on ${exchange || 'any exchange'}`);

    const response = await axios.post(
      `${BROKER_SERVICE_URL}/contract/advanced-search`,
      {
        symbol: symbol,
        secType: secType,
        exchange: exchange,
        currency: currency,
        expiry: expiry,
        strike: strike,
        right: right,
        multiplier: multiplier,
        includeExpired: includeExpired,
        name: searchByName,
        account_mode: account_mode,
        source: venue,
      },
      {
        timeout: 30000,
        headers: {
          Connection: 'close',
        },
      }
    );

    console.log(`Advanced search found ${response.data?.results?.length || 0} contracts`);

    await storeContracts(venue, response.data);

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
      timestamp: new Date().toISOString(),
    });
  }
});

// Symbol discovery (type-ahead): partial pattern -> matching symbols
router.post('/symbols/discover', async (req: Request, res: Response) => {
  const { pattern, secType, exchange, currency, max_results, use_fallback, account_mode } =
    req.body ?? {};
  const venue = resolveBroker(req.body?.broker ?? req.body?.source);

  if (typeof pattern !== 'string' || !pattern.trim()) {
    return res.json({ results: [], method: 'none', cached: false, count: 0 });
  }

  if (!isDataQueryEnabled(req)) {
    return handleDisabledDataQuery(res, 'Symbol discovery is disabled');
  }

  try {
    const response = await axios.post(
      `${BROKER_SERVICE_URL}/symbols/discover`,
      {
        pattern: pattern.trim(),
        secType,
        exchange,
        currency,
        max_results,
        use_fallback,
        account_mode,
        source: venue,
      },
      { timeout: 30000, headers: { Connection: 'close' } }
    );
    res.json(response.data);
  } catch (error: any) {
    const statusCode = error.code === 'ECONNREFUSED' ? 503 : (error.response?.status ?? 500);
    res.status(statusCode).json({
      error: 'Failed to discover symbols',
      message: error.response?.data?.detail || error.message || 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
