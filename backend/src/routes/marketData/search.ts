import express from 'express';
import type { Request, Response } from 'express';
import axios from 'axios';
import { marketDataService, type Contract } from '../../services/marketDataService.js';
import {
  IB_SERVICE_URL,
  VALID_SEC_TYPES,
  isDataQueryEnabled,
  handleDisabledDataQuery,
  resolveBroker,
  type SearchQuery,
  type AdvancedSearchQuery,
} from './shared.js';

const router = express.Router();

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
      `${IB_SERVICE_URL}/market-data/search`,
      {
        symbol: symbol,
        secType: secType,
        exchange: exchange,
        currency: currency,
        searchByName: searchByName,
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

    console.log(`Found ${response.data?.contracts?.length || 0} contracts for ${symbol}`);

    // Store contracts in database for future reference
    if (response.data?.contracts && Array.isArray(response.data.contracts)) {
      for (const contract of response.data.contracts) {
        try {
          const contractData: Contract = {
            broker: venue,
            symbol: contract.symbol,
            secType: contract.secType,
            exchange: contract.exchange,
            currency: contract.currency,
            multiplier: contract.multiplier,
            expiry: contract.expiry,
            strike: contract.strike,
            right: contract.right,
            localSymbol: contract.localSymbol,
            contractId: contract.contractId,
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
      `${IB_SERVICE_URL}/market-data/search/advanced`,
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
        searchByName: searchByName,
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

    console.log(`Advanced search found ${response.data?.contracts?.length || 0} contracts`);

    // Store contracts in database
    if (response.data?.contracts && Array.isArray(response.data.contracts)) {
      for (const contract of response.data.contracts) {
        try {
          const contractData: Contract = {
            broker: venue,
            symbol: contract.symbol,
            secType: contract.secType,
            exchange: contract.exchange,
            currency: contract.currency,
            multiplier: contract.multiplier,
            expiry: contract.expiry,
            strike: contract.strike,
            right: contract.right,
            localSymbol: contract.localSymbol,
            contractId: contract.contractId,
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
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
