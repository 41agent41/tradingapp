/**
 * Systematic-strategy routes (Systematic Trading roadmap — Phase 2 / A2).
 *
 *   POST /api/strategies/definitions      — create a rule-set definition
 *   GET  /api/strategies/definitions      — list definitions
 *   GET  /api/strategies/definitions/:id  — one definition
 *   POST /api/strategies/runs             — start a signal-only run for a definition
 *   GET  /api/strategies/runs             — list runs (optional ?status=)
 *   GET  /api/strategies/runs/:id         — one run
 *   POST /api/strategies/runs/:id/stop    — stop a run
 *   GET  /api/strategies/runs/:id/signals — recorded signals for a run
 *   POST /api/strategies/evaluate         — ad-hoc evaluate (proxies ib_service)
 *
 * The runner itself lives in services/strategyRunner.ts; these routes only
 * manage definitions/runs and read back signals. No orders are placed.
 */
import express from 'express';
import type { Request, Response } from 'express';
import axios from 'axios';
import { dbService } from '../services/database.js';
import { StrategyRepository } from '../services/strategyRepository.js';

const router = express.Router();
const IB_SERVICE_URL = process.env.IB_SERVICE_URL || 'http://ib_service:8000';

const repo = new StrategyRepository(dbService);

const VALID_TIMEFRAMES = new Set([
  'tick',
  '1min',
  '5min',
  '15min',
  '30min',
  '1hour',
  '4hour',
  '8hour',
  '1day',
]);
const VALID_ACCOUNT_MODES = new Set(['paper', 'live']);

function fail(res: Response, status: number, error: string, detail?: unknown) {
  res.status(status).json({ error, detail, timestamp: new Date().toISOString() });
}

// --- definitions ----------------------------------------------------------- //

router.post('/definitions', async (req: Request, res: Response) => {
  try {
    const { name, symbol, timeframe, broker, rule_set } = req.body || {};
    if (!name || !symbol || !timeframe || !rule_set) {
      return fail(res, 400, 'Missing required fields', {
        required: ['name', 'symbol', 'timeframe', 'rule_set'],
      });
    }
    if (!VALID_TIMEFRAMES.has(timeframe)) {
      return fail(res, 400, 'Invalid timeframe', { valid: [...VALID_TIMEFRAMES] });
    }
    if (typeof rule_set !== 'object' || Array.isArray(rule_set) || !('entry' in rule_set)) {
      return fail(res, 400, "rule_set must be an object with an 'entry' group");
    }
    const row = await repo.createDefinition({ name, symbol, timeframe, broker, rule_set });
    res.status(201).json(row);
  } catch (error: any) {
    fail(res, 500, 'Failed to create definition', error?.message ?? 'unknown');
  }
});

router.get('/definitions', async (req: Request, res: Response) => {
  try {
    const rows = await repo.listDefinitions(
      typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
      typeof req.query.offset === 'string' ? Number(req.query.offset) : undefined
    );
    res.json({ definitions: rows, count: rows.length });
  } catch (error: any) {
    fail(res, 500, 'Failed to list definitions', error?.message ?? 'unknown');
  }
});

router.get('/definitions/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid definition id');
  try {
    const row = await repo.findDefinition(id);
    if (!row) return fail(res, 404, 'Definition not found', { id });
    res.json(row);
  } catch (error: any) {
    fail(res, 500, 'Failed to fetch definition', error?.message ?? 'unknown');
  }
});

// --- runs ------------------------------------------------------------------ //

router.post('/runs', async (req: Request, res: Response) => {
  try {
    const { definition_id, account_mode } = req.body || {};
    const defId = Number(definition_id);
    if (!Number.isInteger(defId) || defId <= 0) {
      return fail(res, 400, 'definition_id is required');
    }
    const mode = account_mode ?? 'paper';
    if (!VALID_ACCOUNT_MODES.has(mode)) {
      return fail(res, 400, 'Invalid account_mode', { valid: [...VALID_ACCOUNT_MODES] });
    }
    const definition = await repo.findDefinition(defId);
    if (!definition) return fail(res, 404, 'Definition not found', { definition_id: defId });

    // Carry the definition's sizing/risk onto the run for the A3 layer.
    const ruleSet = (definition.rule_set ?? {}) as Record<string, unknown>;
    const row = await repo.createRun({
      definition_id: defId,
      broker: definition.broker,
      account_mode: mode,
      sizing: (ruleSet.sizing as Record<string, unknown>) ?? {},
      risk: (ruleSet.risk as Record<string, unknown>) ?? {},
    });
    res.status(201).json(row);
  } catch (error: any) {
    fail(res, 500, 'Failed to start run', error?.message ?? 'unknown');
  }
});

router.get('/runs', async (req: Request, res: Response) => {
  try {
    const rows = await repo.listRuns({
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
      limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
      offset: typeof req.query.offset === 'string' ? Number(req.query.offset) : undefined,
    });
    res.json({ runs: rows, count: rows.length });
  } catch (error: any) {
    fail(res, 500, 'Failed to list runs', error?.message ?? 'unknown');
  }
});

router.get('/runs/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid run id');
  try {
    const row = await repo.findRun(id);
    if (!row) return fail(res, 404, 'Run not found', { id });
    res.json(row);
  } catch (error: any) {
    fail(res, 500, 'Failed to fetch run', error?.message ?? 'unknown');
  }
});

router.post('/runs/:id/stop', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid run id');
  try {
    const row = await repo.updateRunStatus(id, 'stopped');
    if (!row) return fail(res, 404, 'Run not found', { id });
    res.json(row);
  } catch (error: any) {
    fail(res, 500, 'Failed to stop run', error?.message ?? 'unknown');
  }
});

router.get('/runs/:id/signals', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid run id');
  try {
    const rows = await repo.listSignals(
      id,
      typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined
    );
    res.json({ signals: rows, count: rows.length });
  } catch (error: any) {
    fail(res, 500, 'Failed to list signals', error?.message ?? 'unknown');
  }
});

// --- ad-hoc evaluate (proxy) ----------------------------------------------- //

router.post('/evaluate', async (req: Request, res: Response) => {
  try {
    const response = await axios.post(`${IB_SERVICE_URL}/strategies/evaluate`, req.body ?? {}, {
      timeout: 30000,
      headers: { Connection: 'close' },
    });
    res.json(response.data);
  } catch (error: any) {
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }
    fail(res, 502, 'Failed to reach IB service', error?.message ?? 'unknown');
  }
});

export default router;
