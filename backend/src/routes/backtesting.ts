/**
 * Backtesting proxy routes (GAP_ANALYSIS §5).
 *
 * The backtesting engine and strategies live in the IB service
 * (`ib_service/backtesting.py`, exposed at `/backtesting/*`). Going through
 * the backend keeps the feature behind the same auth/CORS perimeter as the
 * rest of the API and gives the frontend a single origin to talk to.
 *
 *   GET  /api/backtesting/strategies — list available strategies (cached)
 *   POST /api/backtesting/run        — run a backtest over historical data
 *   GET  /api/backtesting/runs       — list persisted runs (slim rows)
 *   GET  /api/backtesting/runs/:id   — full record for one persisted run
 */
import express from 'express';
import type { Request, Response } from 'express';
import axios from 'axios';
import { cacheService } from '../services/cache.js';
import { dbService } from '../services/database.js';
import { BacktestRunRepository } from '../services/backtestRunRepository.js';

const router = express.Router();
const IB_SERVICE_URL = process.env.IB_SERVICE_URL || 'http://ib_service:8000';

const VALID_TIMEFRAMES = [
  'tick',
  '1min',
  '5min',
  '15min',
  '30min',
  '1hour',
  '4hour',
  '8hour',
  '1day',
];

const runs = new BacktestRunRepository(dbService);

// Translate an axios error from the IB service into a client response using
// the same shape the other proxy routes use.
function sendProxyError(res: Response, error: any, label: string) {
  let errorMessage = 'Unknown error';
  let statusCode = 500;

  if (error.code === 'ECONNREFUSED') {
    errorMessage = 'IB Service connection refused - service may be starting up';
    statusCode = 503;
  } else if (error.code === 'ETIMEDOUT' || error.message?.includes('timeout')) {
    errorMessage = 'IB Service timeout - backtest may be fetching a large history';
    statusCode = 504;
  } else if (error.response) {
    errorMessage = error.response.data?.detail || error.response.statusText || 'IB Service error';
    statusCode = error.response.status;
  } else {
    errorMessage = error.message || 'Failed to connect to IB Service';
  }

  res.status(statusCode).json({
    error: label,
    detail: errorMessage,
    ib_service_status: statusCode,
    timestamp: new Date().toISOString(),
  });
}

// List the strategies the engine knows about. The catalogue is static for a
// given deployment, so it is cached for an hour.
router.get('/strategies', async (_req: Request, res: Response) => {
  try {
    const data = await cacheService.wrap('backtesting:strategies', 3600, async () => {
      const response = await axios.get(`${IB_SERVICE_URL}/backtesting/strategies`, {
        timeout: 5000,
      });
      return response.data;
    });
    res.json(data);
  } catch (error: any) {
    console.error('Error fetching backtesting strategies:', error);
    sendProxyError(res, error, 'Failed to fetch backtesting strategies');
  }
});

// Run a backtest. The IB service endpoint takes its parameters as query
// params (they are plain FastAPI function args, not a request body), so the
// validated values are forwarded via `params` on a bodyless POST.
router.post('/run', async (req: Request, res: Response) => {
  try {
    const {
      symbol,
      strategy,
      timeframe = '1hour',
      period = '1Y',
      initial_capital = 100000,
      commission = 0.001,
      start_date,
      end_date,
    } = req.body || {};

    if (!symbol || !strategy) {
      return res.status(400).json({
        error: 'Missing required parameters',
        required: ['symbol', 'strategy'],
        received: { symbol, strategy },
      });
    }

    if (!VALID_TIMEFRAMES.includes(timeframe)) {
      return res.status(400).json({
        error: 'Invalid timeframe',
        valid: VALID_TIMEFRAMES,
        received: timeframe,
      });
    }

    const capital = Number(initial_capital);
    if (!Number.isFinite(capital) || capital <= 0) {
      return res.status(400).json({ error: 'initial_capital must be a positive number' });
    }

    const comm = Number(commission);
    if (!Number.isFinite(comm) || comm < 0 || comm > 1) {
      return res.status(400).json({ error: 'commission must be a fraction between 0 and 1' });
    }

    // A custom date range is optional; only forward it when both ends are set.
    const hasRange = Boolean(start_date && end_date);

    console.log(
      `Running backtest: ${symbol} ${strategy} ${timeframe} ` +
        (hasRange ? `${start_date}..${end_date}` : period)
    );

    const response = await axios.post(`${IB_SERVICE_URL}/backtesting/run`, null, {
      params: {
        symbol,
        strategy,
        timeframe,
        period,
        initial_capital: capital,
        commission: comm,
        ...(hasRange ? { start_date, end_date } : {}),
      },
      timeout: 120000, // backtests pull historical data from IB and can be slow
      headers: { Connection: 'close' },
    });

    const payload = response.data ?? {};

    // Persist the run. We intentionally do not fail the request if the
    // insert errors — the run itself succeeded; the persistence is a side
    // effect, not the user's contract.
    let persisted_id: number | null = null;
    try {
      const row = await runs.insert({
        strategy,
        symbol,
        timeframe,
        period: hasRange ? 'CUSTOM' : period,
        start_date: hasRange ? start_date : null,
        end_date: hasRange ? end_date : null,
        initial_capital: capital,
        commission: comm,
        params: payload.params ?? {},
        metrics: payload.metrics ?? {},
        equity_curve: payload.equity_curve ?? [],
        trades: payload.trades ?? [],
      });
      persisted_id = row.id;
    } catch (persistError: any) {
      console.error('Failed to persist backtest run:', persistError?.message ?? persistError);
    }

    res.json({ ...payload, persisted_id });
  } catch (error: any) {
    console.error('Error running backtest:', error);
    sendProxyError(res, error, 'Failed to run backtest');
  }
});

router.get('/runs', async (req: Request, res: Response) => {
  try {
    const rows = await runs.list({
      symbol: typeof req.query.symbol === 'string' ? req.query.symbol : undefined,
      strategy: typeof req.query.strategy === 'string' ? req.query.strategy : undefined,
      limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
      offset: typeof req.query.offset === 'string' ? Number(req.query.offset) : undefined,
    });
    res.json({ runs: rows, count: rows.length });
  } catch (error: any) {
    console.error('Error listing backtest runs:', error);
    res.status(500).json({
      error: 'Failed to list backtest runs',
      detail: error?.message ?? 'unknown',
      timestamp: new Date().toISOString(),
    });
  }
});

router.get('/runs/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid run id' });
  }
  try {
    const row = await runs.findById(id);
    if (!row) return res.status(404).json({ error: 'Backtest run not found', id });
    res.json(row);
  } catch (error: any) {
    console.error('Error fetching backtest run:', error);
    res.status(500).json({
      error: 'Failed to fetch backtest run',
      detail: error?.message ?? 'unknown',
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
