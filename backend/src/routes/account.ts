import express from 'express';
import type { Request, Response } from 'express';
import axios from 'axios';

import { dbService } from '../services/database.js';
import { ExecutionRepository } from '../services/executionRepository.js';
import { realisedPnl } from '../services/realisedPnl.js';
import { DEFAULT_BROKER_ACCOUNT } from '../services/orderTypes.js';

const router = express.Router();
const BROKER_SERVICE_URL = process.env.BROKER_SERVICE_URL || 'http://broker_service:8000';

// Interface for account data - basic required fields only for optimal performance
interface AccountSummary {
  account_id: string;
  net_liquidation?: number; // Basic required field
  currency: string; // Basic required field
  last_updated: string;

  // Optional fields (not requested in basic mode)
  total_cash_value?: number;
  buying_power?: number;
  maintenance_margin?: number;
}

interface Position {
  symbol: string;
  position: number;
  market_price?: number;
  market_value?: number;
  average_cost?: number;
  unrealized_pnl?: number;
  currency: string;
}

interface Order {
  // A string, not a number — IB's order ids are numeric but Alpaca's are UUIDs
  // and OANDA's are numeric strings, so the venue-agnostic shape is the wider
  // type.
  order_id: string;
  symbol: string;
  action: string;
  quantity: number;
  order_type: string;
  status: string;
  filled_quantity?: number;
  remaining_quantity?: number;
  avg_fill_price?: number;
}

interface _AccountData {
  account: AccountSummary;
  positions: Position[];
  orders: Order[];
  last_updated: string;
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
    timestamp: new Date().toISOString(),
  });
}

// Get account summary
router.get('/summary', async (req: Request, res: Response) => {
  try {
    // Check if data querying is enabled
    if (!isDataQueryEnabled(req)) {
      return handleDisabledDataQuery(res, 'Account summary data querying is disabled');
    }

    // Broker-scoped: the summary comes from the venue named by `?broker=`,
    // defaulting to IB. It is also where `pct_equity` sizing gets its equity.
    const broker = typeof req.query.broker === 'string' ? req.query.broker.toLowerCase() : 'ib';
    const account =
      typeof req.query.account === 'string' ? req.query.account.toLowerCase() : undefined;

    console.log(`Fetching account summary from broker service (broker=${broker})`);

    const response = await axios.get(`${BROKER_SERVICE_URL}/account/summary`, {
      params: { broker, account },
      timeout: 20000, // 20 second timeout for account data
      headers: {
        Connection: 'close',
      },
    });

    console.log('Successfully fetched account summary');
    res.json(response.data);
  } catch (error: any) {
    console.error('Error fetching account summary:', error);

    let errorMessage = 'Unknown error';
    let statusCode = 500;

    if (error.code === 'ECONNREFUSED') {
      errorMessage = 'IB Service connection refused - service may be starting up';
      statusCode = 503;
    } else if (error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
      errorMessage = 'IB Service timeout - service may be busy';
      statusCode = 504;
    } else if (error.response) {
      errorMessage = error.response.data?.detail || error.response.statusText || 'IB Service error';
      statusCode = error.response.status;
    } else {
      errorMessage = error.message || 'Failed to connect to IB Service';
    }

    res.status(statusCode).json({
      error: 'Failed to fetch account summary',
      detail: errorMessage,
      broker_service_status: statusCode,
      broker_service_url: BROKER_SERVICE_URL,
      timestamp: new Date().toISOString(),
    });
  }
});

// Get account positions
router.get('/positions', async (req: Request, res: Response) => {
  try {
    // Check if data querying is enabled
    if (!isDataQueryEnabled(req)) {
      return handleDisabledDataQuery(res, 'Account positions data querying is disabled');
    }

    // Broker-scoped (B1): positions come from the venue named by `?broker=`,
    // defaulting to IB. Each adapter normalises its payload to the same shape.
    const broker = typeof req.query.broker === 'string' ? req.query.broker.toLowerCase() : 'ib';
    const account =
      typeof req.query.account === 'string' ? req.query.account.toLowerCase() : undefined;

    console.log(`Fetching account positions from broker service (broker=${broker})`);

    const response = await axios.get(`${BROKER_SERVICE_URL}/account/positions`, {
      params: { broker, account },
      timeout: 20000, // 20 second timeout
      headers: {
        Connection: 'close',
      },
    });

    console.log(`Successfully fetched ${response.data.length} positions`);
    res.json({
      positions: response.data,
      count: response.data.length,
      last_updated: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Error fetching account positions:', error);

    let errorMessage = 'Unknown error';
    let statusCode = 500;

    if (error.code === 'ECONNREFUSED') {
      errorMessage = 'IB Service connection refused - service may be starting up';
      statusCode = 503;
    } else if (error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
      errorMessage = 'IB Service timeout - service may be busy';
      statusCode = 504;
    } else if (error.response) {
      errorMessage = error.response.data?.detail || error.response.statusText || 'IB Service error';
      statusCode = error.response.status;
    } else {
      errorMessage = error.message || 'Failed to connect to IB Service';
    }

    res.status(statusCode).json({
      error: 'Failed to fetch account positions',
      detail: errorMessage,
      broker_service_status: statusCode,
      broker_service_url: BROKER_SERVICE_URL,
      timestamp: new Date().toISOString(),
    });
  }
});

// Get account orders
router.get('/orders', async (req: Request, res: Response) => {
  try {
    // Check if data querying is enabled
    if (!isDataQueryEnabled(req)) {
      return handleDisabledDataQuery(res, 'Account orders data querying is disabled');
    }

    const broker = typeof req.query.broker === 'string' ? req.query.broker.toLowerCase() : 'ib';
    const account =
      typeof req.query.account === 'string' ? req.query.account.toLowerCase() : undefined;

    console.log(`Fetching account orders from broker service (broker=${broker})`);

    const response = await axios.get(`${BROKER_SERVICE_URL}/account/orders`, {
      params: { broker, account },
      timeout: 20000, // 20 second timeout
      headers: {
        Connection: 'close',
      },
    });

    console.log(`Successfully fetched ${response.data.length} orders`);
    res.json({
      orders: response.data,
      count: response.data.length,
      last_updated: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Error fetching account orders:', error);

    let errorMessage = 'Unknown error';
    let statusCode = 500;

    if (error.code === 'ECONNREFUSED') {
      errorMessage = 'IB Service connection refused - service may be starting up';
      statusCode = 503;
    } else if (error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
      errorMessage = 'IB Service timeout - service may be busy';
      statusCode = 504;
    } else if (error.response) {
      errorMessage = error.response.data?.detail || error.response.statusText || 'IB Service error';
      statusCode = error.response.status;
    } else {
      errorMessage = error.message || 'Failed to connect to IB Service';
    }

    res.status(statusCode).json({
      error: 'Failed to fetch account orders',
      detail: errorMessage,
      broker_service_status: statusCode,
      broker_service_url: BROKER_SERVICE_URL,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * Fills — read from the local `order_executions` store, not live from the venue.
 *
 * Deliberately *not* a proxy to the broker service. The store is the union of
 * every poll the app has made, so it survives a venue that only serves the
 * current trading day, and its rows carry the attribution (`order_audit_id` /
 * `run_id`) that a raw venue payload has no idea about. `?fresh=true` is
 * available for a live read when the caller genuinely wants what the venue
 * says right now.
 *
 * No `x-data-query-enabled` gate: unlike the other routes here this hits
 * Postgres, not the IB Gateway, and that header exists to spare IB the load.
 */
router.get('/executions', async (req: Request, res: Response) => {
  try {
    const broker =
      typeof req.query.broker === 'string' ? req.query.broker.toLowerCase() : undefined;
    const account =
      typeof req.query.account === 'string' ? req.query.account.toLowerCase() : undefined;
    const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : undefined;
    const accountMode =
      typeof req.query.account_mode === 'string' ? req.query.account_mode : undefined;
    const runId = req.query.run_id != null ? Number(req.query.run_id) : undefined;

    if (String(req.query.fresh).toLowerCase() === 'true') {
      const response = await axios.get(`${BROKER_SERVICE_URL}/account/executions`, {
        params: { broker: broker || 'ib', account, days: Number(req.query.days) || 1 },
        timeout: 45000,
        headers: { Connection: 'close' },
      });
      return res.json({
        executions: response.data,
        count: Array.isArray(response.data) ? response.data.length : 0,
        source: 'broker',
        last_updated: new Date().toISOString(),
      });
    }

    const repo = new ExecutionRepository(dbService);
    const rows = await repo.list({
      broker,
      broker_account: account,
      symbol,
      account_mode: accountMode,
      run_id: Number.isFinite(runId) ? runId : undefined,
      limit: Number(req.query.limit) || undefined,
      offset: Number(req.query.offset) || undefined,
    });

    res.json({
      executions: rows,
      count: rows.length,
      source: 'database',
      last_updated: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Error fetching executions:', error);
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch executions',
      detail: error.response?.data?.detail || error.message || 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * Realised P&L over the stored fills, with the net position they imply.
 *
 * The numbers the platform previously could not produce: `order_audit` records
 * intent, and intent has no P&L. Scoping by `run_id` is what backs a strategy's
 * `max_daily_loss` cap; scoping by `symbol` answers "what has this instrument
 * actually made".
 */
router.get('/pnl', async (req: Request, res: Response) => {
  try {
    const broker =
      typeof req.query.broker === 'string' ? req.query.broker.toLowerCase() : undefined;
    const account =
      typeof req.query.account === 'string' ? req.query.account.toLowerCase() : undefined;
    const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : undefined;
    const accountMode =
      typeof req.query.account_mode === 'string' ? req.query.account_mode : undefined;
    const runId = req.query.run_id != null ? Number(req.query.run_id) : undefined;
    // Default to today, the window the daily-loss cap is measured over.
    const since =
      typeof req.query.since === 'string'
        ? req.query.since
        : new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString();

    const repo = new ExecutionRepository(dbService);
    const fills = await repo.listForPnl({
      broker,
      broker_account: account,
      symbol,
      account_mode: accountMode,
      run_id: Number.isFinite(runId) ? runId : undefined,
      since,
    });
    const result = realisedPnl(fills);

    res.json({
      since,
      fills: fills.length,
      realised: result.realised,
      commission: result.commission,
      by_symbol: result.bySymbol,
      last_updated: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Error computing realised P&L:', error);
    res.status(500).json({
      error: 'Failed to compute realised P&L',
      detail: error.message || 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * Compare what the app believes it holds at a venue against what the venue
 * says it holds.
 *
 * Attributing a run's position to its own fills is the right model — it stops a
 * second run on the same symbol, or a manual trade, silently changing what a
 * strategy's sizing and pyramiding rules do. But it means the sum of the parts
 * can drift from the account: a trade placed by hand belongs to no run, and a
 * corporate action belongs to no order at all. That drift is inherent, so the
 * honest response is to make it *visible* rather than to pretend it can't
 * happen.
 *
 * Reports every symbol either side knows about, with `matched: false` on any
 * row where they disagree beyond a rounding tolerance.
 */
router.get('/reconciliation', async (req: Request, res: Response) => {
  try {
    const broker = typeof req.query.broker === 'string' ? req.query.broker.toLowerCase() : 'ib';
    const account =
      typeof req.query.account === 'string' ? req.query.account.toLowerCase() : undefined;
    const accountMode =
      typeof req.query.account_mode === 'string' ? req.query.account_mode : undefined;
    // Fractional venue quantities (FX units, MT5 lots) never compare exactly.
    const tolerance = Math.abs(Number(req.query.tolerance)) || 1e-6;

    const repo = new ExecutionRepository(dbService);
    const [ours, venueResponse] = await Promise.all([
      // Scoped to the same connection as the venue read below. Comparing one
      // account's venue positions against another account's recorded ones
      // reports mismatches that are purely an artefact of the mismatch in
      // scope (C-4).
      repo.netPositionsByBroker(broker, accountMode, account ?? DEFAULT_BROKER_ACCOUNT),
      axios.get(`${BROKER_SERVICE_URL}/account/positions`, {
        params: { broker, account },
        timeout: 20000,
        headers: { Connection: 'close' },
      }),
    ]);

    const theirs: Record<string, number> = {};
    for (const row of Array.isArray(venueResponse.data) ? venueResponse.data : []) {
      const symbol = String(row?.symbol ?? '').toUpperCase();
      if (symbol) theirs[symbol] = Number(row?.position) || 0;
    }

    const symbols = [...new Set([...Object.keys(ours), ...Object.keys(theirs)])].sort();
    const positions = symbols.map((symbol) => {
      const recorded = ours[symbol] ?? 0;
      const venue = theirs[symbol] ?? 0;
      const difference = recorded - venue;
      return { symbol, recorded, venue, difference, matched: Math.abs(difference) <= tolerance };
    });

    res.json({
      broker,
      account: account ?? DEFAULT_BROKER_ACCOUNT,
      connection: `${broker}:${account ?? DEFAULT_BROKER_ACCOUNT}`,
      account_mode: accountMode ?? null,
      positions,
      mismatches: positions.filter((p) => !p.matched).length,
      last_updated: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Error reconciling positions:', error);
    res.status(error.response?.status || 500).json({
      error: 'Failed to reconcile positions',
      detail: error.response?.data?.detail || error.message || 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
});

// Get all account data in one call
/**
 * Reconcile **every configured connection** in one call (C-4).
 *
 * The per-connection route above answers "is this account in sync?". Running
 * a fleet, the question is "is any account out of sync?" — and asking it one
 * connection at a time means an operator has to already suspect which.
 *
 * Never fails as a whole: a connection that cannot be read reports its own
 * error alongside the ones that reconciled, because "four are fine, this one
 * is unreachable" is the actionable answer.
 */
router.get('/reconciliation/all', async (req: Request, res: Response) => {
  try {
    const tolerance = Math.abs(Number(req.query.tolerance)) || 1e-6;
    const repo = new ExecutionRepository(dbService);

    const providers = await axios.get(`${BROKER_SERVICE_URL}/providers`, {
      timeout: 15000,
      headers: { Connection: 'close' },
    });
    const connections = Object.values(
      (providers.data?.connections ?? {}) as Record<
        string,
        { platform: string; account: string; broker?: boolean }
      >
    ).filter((c) => c.broker !== false);

    const reports = await Promise.all(
      connections.map(async (conn) => {
        const label = `${conn.platform}:${conn.account}`;
        try {
          const [ours, venueResponse] = await Promise.all([
            repo.netPositionsByBroker(conn.platform, undefined, conn.account),
            axios.get(`${BROKER_SERVICE_URL}/account/positions`, {
              params: { broker: conn.platform, account: conn.account },
              timeout: 20000,
              headers: { Connection: 'close' },
            }),
          ]);

          const theirs: Record<string, number> = {};
          for (const row of Array.isArray(venueResponse.data) ? venueResponse.data : []) {
            const symbol = String(row?.symbol ?? '').toUpperCase();
            if (symbol) theirs[symbol] = Number(row?.position) || 0;
          }

          const symbols = [...new Set([...Object.keys(ours), ...Object.keys(theirs)])].sort();
          const positions = symbols.map((symbol) => {
            const recorded = ours[symbol] ?? 0;
            const venue = theirs[symbol] ?? 0;
            const difference = recorded - venue;
            return {
              symbol,
              recorded,
              venue,
              difference,
              matched: Math.abs(difference) <= tolerance,
            };
          });

          return {
            connection: label,
            ok: true,
            positions,
            mismatches: positions.filter((p) => !p.matched).length,
          };
        } catch (err: any) {
          return {
            connection: label,
            ok: false,
            error: err?.response?.data?.detail || err?.message || 'unknown',
          };
        }
      })
    );

    res.json({
      connections: reports,
      checked: reports.length,
      unreachable: reports.filter((r) => !r.ok).length,
      with_mismatches: reports.filter((r) => r.ok && (r.mismatches ?? 0) > 0).length,
      last_updated: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({
      error: 'Failed to reconcile connections',
      detail: error.message || 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
});

router.get('/all', async (req: Request, res: Response) => {
  try {
    // Check if data querying is enabled
    if (!isDataQueryEnabled(req)) {
      return handleDisabledDataQuery(res, 'All account data querying is disabled');
    }

    const broker = typeof req.query.broker === 'string' ? req.query.broker.toLowerCase() : 'ib';
    const account =
      typeof req.query.account === 'string' ? req.query.account.toLowerCase() : undefined;

    console.log(`Fetching all account data from broker service (broker=${broker})`);

    const response = await axios.get(`${BROKER_SERVICE_URL}/account/all`, {
      params: { broker, account },
      timeout: 30000, // 30 second timeout for comprehensive data
      headers: {
        Connection: 'close',
      },
    });

    console.log('Successfully fetched all account data');
    res.json(response.data);
  } catch (error: any) {
    console.error('Error fetching all account data:', error);

    let errorMessage = 'Unknown error';
    let statusCode = 500;

    if (error.code === 'ECONNREFUSED') {
      errorMessage = 'IB Service connection refused - service may be starting up';
      statusCode = 503;
    } else if (error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
      errorMessage = 'IB Service timeout - service may be busy';
      statusCode = 504;
    } else if (error.response) {
      errorMessage = error.response.data?.detail || error.response.statusText || 'IB Service error';
      statusCode = error.response.status;
    } else {
      errorMessage = error.message || 'Failed to connect to IB Service';
    }

    res.status(statusCode).json({
      error: 'Failed to fetch all account data',
      detail: errorMessage,
      broker_service_status: statusCode,
      broker_service_url: BROKER_SERVICE_URL,
      timestamp: new Date().toISOString(),
    });
  }
});

// Get IB connection status (moved from other routes for account independence)
router.get('/connection', async (req: Request, res: Response) => {
  try {
    console.log('Checking IB Gateway connection status');

    const response = await axios.get(`${BROKER_SERVICE_URL}/connection`, {
      timeout: 10000, // 10 second timeout for connection check
      headers: {
        Connection: 'close',
      },
    });

    console.log('Successfully retrieved connection status');
    res.json(response.data);
  } catch (error: any) {
    console.error('Error checking IB connection:', error);

    let errorMessage = 'Unknown error';
    let statusCode = 500;

    if (error.code === 'ECONNREFUSED') {
      errorMessage = 'IB Service connection refused - service may be starting up';
      statusCode = 503;
    } else if (error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
      errorMessage = 'IB Service timeout - service may be busy';
      statusCode = 504;
    } else if (error.response) {
      errorMessage = error.response.data?.detail || error.response.statusText || 'IB Service error';
      statusCode = error.response.status;
    } else {
      errorMessage = error.message || 'Failed to connect to IB Service';
    }

    res.status(statusCode).json({
      error: 'Failed to check IB connection',
      detail: errorMessage,
      connected: false,
      broker_service_status: statusCode,
      broker_service_url: BROKER_SERVICE_URL,
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
