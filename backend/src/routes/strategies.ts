/**
 * Systematic-strategy routes (Systematic Trading roadmap — Phase 2 / A2).
 *
 *   POST /api/strategies/definitions      — create a rule-set definition
 *   GET  /api/strategies/definitions      — list definitions
 *   GET  /api/strategies/definitions/:id  — one definition
 *   POST /api/strategies/runs             — start a signal-only run for a definition
 *   POST /api/strategies/definitions/:id/deploy — deploy to N connections (C-3)
 *   GET  /api/strategies/groups/:id       — a group and its legs
 *   POST /api/strategies/groups/:id/stop  — stop every leg of a group
 *   POST /api/strategies/connections/:broker/:account/stop — panic-stop a connection
 *   GET  /api/strategies/fleet            — every connection + grouped legs (C-5)
 *   GET  /api/strategies/runs             — list runs (optional ?status=)
 *   GET  /api/strategies/runs/:id         — one run
 *   POST /api/strategies/runs/:id/stop    — stop a run
 *   GET  /api/strategies/runs/:id/signals — recorded signals for a run
 *   POST /api/strategies/evaluate         — ad-hoc evaluate (proxies broker_service)
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
const BROKER_SERVICE_URL = process.env.BROKER_SERVICE_URL || 'http://broker_service:8000';

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
const VALID_SEC_TYPES = new Set([
  'STK',
  'OPT',
  'FUT',
  'CASH',
  'BOND',
  'CFD',
  'CMDTY',
  'CRYPTO',
  'WAR',
  'FUND',
  'IND',
  'BAG',
]);

function fail(res: Response, status: number, error: string, detail?: unknown) {
  res.status(status).json({ error, detail, timestamp: new Date().toISOString() });
}

// --- definitions ----------------------------------------------------------- //

router.post('/definitions', async (req: Request, res: Response) => {
  try {
    const { name, symbol, timeframe, broker, sec_type, exchange, currency, rule_set } =
      req.body || {};
    if (!name || !symbol || !timeframe || !rule_set) {
      return fail(res, 400, 'Missing required fields', {
        required: ['name', 'symbol', 'timeframe', 'rule_set'],
      });
    }
    if (!VALID_TIMEFRAMES.has(timeframe)) {
      return fail(res, 400, 'Invalid timeframe', { valid: [...VALID_TIMEFRAMES] });
    }
    const secType = String(sec_type ?? 'STK').toUpperCase();
    if (!VALID_SEC_TYPES.has(secType)) {
      return fail(res, 400, 'Invalid sec_type', { valid: [...VALID_SEC_TYPES] });
    }
    if (typeof rule_set !== 'object' || Array.isArray(rule_set) || !('entry' in rule_set)) {
      return fail(res, 400, "rule_set must be an object with an 'entry' group");
    }
    const row = await repo.createDefinition({
      name,
      symbol,
      timeframe,
      broker,
      sec_type: secType,
      exchange: exchange ? String(exchange) : undefined,
      currency: currency ? String(currency) : undefined,
      rule_set,
    });
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


// --- fleet view (Component C — C-5) ---------------------------------------- //

/**
 * The whole fleet in one call: every connection, its health and declared mode,
 * and every active run grouped by the definition it came from.
 *
 * One endpoint rather than several because the operational question is a
 * single one — "is anything wrong?" — and answering it by fanning out across
 * connections/, runs/ and groups/ in the browser means a half-loaded screen
 * shows a half-true answer. A connection that cannot be read reports its own
 * error alongside the ones that responded.
 */
router.get('/fleet', async (_req: Request, res: Response) => {
  try {
    let connections: Record<string, any> = {};
    let currency: Record<string, unknown> | null = null;
    let providerError: string | null = null;
    try {
      const providers = await axios.get(`${BROKER_SERVICE_URL}/providers`, {
        timeout: 15000,
        headers: { Connection: 'close' },
      });
      connections = providers.data?.connections ?? {};
      currency = providers.data?.currency ?? null;
    } catch (err: any) {
      // Reported, not fatal. The DB half of this answer is still worth having,
      // and "the broker service is unreachable" is itself the headline.
      providerError = err?.message ?? 'broker service unreachable';
    }

    const runs = await repo.listRuns({ limit: 200 });
    const active = runs.filter((r) => r.status === 'running' || r.status === 'pending');

    // Legs grouped by the definition they came from, so one strategy across
    // several accounts reads as one row with N legs rather than N unrelated
    // runs — which is how it is actually operated.
    const byDefinition = new Map<number, any[]>();
    for (const run of active) {
      const bucket = byDefinition.get(run.definition_id);
      if (bucket) bucket.push(run);
      else byDefinition.set(run.definition_id, [run]);
    }

    const definitions = await Promise.all(
      [...byDefinition.keys()].map((id) => repo.findDefinition(id))
    );
    const definitionById = new Map(
      definitions.filter(Boolean).map((d: any) => [d.id, d])
    );

    const strategies = [...byDefinition.entries()].map(([definitionId, legs]) => {
      const definition = definitionById.get(definitionId);
      return {
        definition_id: definitionId,
        name: definition?.name ?? `definition ${definitionId}`,
        symbol: definition?.symbol ?? null,
        timeframe: definition?.timeframe ?? null,
        group_ids: [...new Set(legs.map((l) => l.run_group_id).filter((g) => g != null))],
        legs: legs.map((leg) => ({
          run_id: leg.id,
          connection: `${leg.broker}:${leg.broker_account}`,
          native_symbol: leg.native_symbol,
          account_mode: leg.account_mode,
          status: leg.status,
          is_canary: leg.is_canary,
          current_stop: leg.current_stop == null ? null : Number(leg.current_stop),
          last_evaluated_at: leg.last_evaluated_at,
          last_error: leg.last_error,
        })),
      };
    });

    const runsPerConnection: Record<string, number> = {};
    for (const run of active) {
      const label = `${run.broker}:${run.broker_account}`;
      runsPerConnection[label] = (runsPerConnection[label] ?? 0) + 1;
    }

    res.json({
      connections: Object.entries(connections).map(([label, info]: [string, any]) => ({
        connection: label,
        ...info,
        active_runs: runsPerConnection[label] ?? 0,
      })),
      currency,
      strategies,
      totals: {
        connections: Object.keys(connections).length,
        active_runs: active.length,
        pending_runs: active.filter((r) => r.status === 'pending').length,
        errored_runs: runs.filter((r) => r.status === 'error').length,
      },
      broker_service_error: providerError,
      last_updated: new Date().toISOString(),
    });
  } catch (error: any) {
    fail(res, 500, 'Failed to read fleet status', error?.message ?? 'unknown');
  }
});

// --- deploy to many connections (Component C — C-3) ------------------------ //

/**
 * Deploy one definition to N connections as a run group.
 *
 * Two things happen before anything is created, and both are refusals rather
 * than best-effort:
 *
 *  1. **Every leg's symbol is resolved** at its own connection (C-2). EURUSD is
 *     EURUSD.a at one broker and EURUSD_i at the next; a leg whose symbol
 *     cannot be resolved unambiguously is refused rather than started on a
 *     guess. By default a single unresolvable leg fails the whole deploy —
 *     with one strategy across accounts, silently running on a subset is
 *     usually not what was intended. `allow_partial` opts into starting the
 *     legs that did resolve.
 *  2. **Legs are created atomically but started in stages.** One nominated
 *     canary starts immediately; the rest are created `pending` and admitted
 *     by the runner once the canary has evaluated cleanly for `settle_seconds`.
 */
router.post('/definitions/:id/deploy', async (req: Request, res: Response) => {
  try {
    const defId = Number(req.params.id);
    if (!Number.isInteger(defId) || defId <= 0) return fail(res, 400, 'Invalid definition id');

    const definition = await repo.findDefinition(defId);
    if (!definition) return fail(res, 404, 'Definition not found', { definition_id: defId });

    const body = req.body || {};
    const targets = Array.isArray(body.targets) ? body.targets : [];
    if (targets.length === 0) {
      return fail(res, 400, 'targets is required', {
        shape: '[{ broker, account, account_mode?, sizing?, risk?, canary? }]',
      });
    }

    for (const t of targets) {
      if (t?.account_mode && !VALID_ACCOUNT_MODES.has(t.account_mode)) {
        return fail(res, 400, 'Invalid account_mode on a target', {
          valid: [...VALID_ACCOUNT_MODES],
        });
      }
    }

    // Exactly one canary. Not defaultable: the canary is the account that takes
    // the first real risk from an unproven edit, so it is named deliberately.
    const canaryTargets = targets.filter((t: any) => t?.canary);
    if (canaryTargets.length !== 1) {
      return fail(res, 400, 'Exactly one target must be marked canary', {
        marked: canaryTargets.length,
        why: 'the canary takes the first risk from an unproven rule-set, so it is chosen, not defaulted',
      });
    }

    // Resolve every leg's native symbol at its own connection.
    let preview: any;
    try {
      const response = await axios.post(
        `${BROKER_SERVICE_URL}/instrument/resolve/preview`,
        {
          symbol: definition.symbol,
          targets: targets.map((t: any) => ({ broker: t.broker, account: t.account })),
          include_spec: false,
        },
        { timeout: 60000, headers: { Connection: 'close' } }
      );
      preview = response.data;
    } catch (err: any) {
      return fail(res, 502, 'Symbol resolution failed', err?.message ?? 'unknown');
    }

    const results: any[] = Array.isArray(preview?.results) ? preview.results : [];
    const refused = results.filter((r) => !r.ok);
    if (refused.length > 0 && !body.allow_partial) {
      return fail(res, 422, 'Some connections could not resolve the instrument', {
        symbol: definition.symbol,
        refused: refused.map((r) => ({
          broker: r.broker,
          account: r.account,
          error: r.error,
        })),
        hint: 'add a symbol_map entry for those connections, or pass allow_partial to start the rest',
      });
    }

    const resolvedByKey = new Map<string, any>(
      results.filter((r) => r.ok).map((r) => [`${r.broker}:${r.account ?? ''}`, r])
    );

    const legs = targets
      .map((t: any) => {
        const resolved = resolvedByKey.get(`${t.broker}:${t.account ?? ''}`);
        if (!resolved) return null;
        const ruleSet = (definition.rule_set ?? {}) as Record<string, unknown>;
        return {
          broker: resolved.broker,
          broker_account: resolved.account,
          native_symbol: resolved.native,
          account_mode: t.account_mode ?? 'paper',
          // Per-leg sizing and risk must be able to differ: a $10k challenge
          // account and a $200k live account cannot share a fixed size.
          sizing: t.sizing ?? (ruleSet.sizing as Record<string, unknown>) ?? {},
          risk: t.risk ?? (ruleSet.risk as Record<string, unknown>) ?? {},
          is_canary: Boolean(t.canary),
        };
      })
      .filter(Boolean);

    if (legs.length === 0) {
      return fail(res, 422, 'No connection could resolve the instrument', {
        symbol: definition.symbol,
      });
    }
    if (!legs.some((l: any) => l.is_canary)) {
      // The nominated canary was itself refused; promoting another silently
      // would move the first risk to an account the operator did not choose.
      return fail(res, 422, 'The nominated canary connection could not resolve the instrument', {
        symbol: definition.symbol,
      });
    }

    const settleSeconds = Number.isFinite(Number(body.settle_seconds))
      ? Number(body.settle_seconds)
      : undefined;

    const { group, runs } = await repo.createGroup({
      definition_id: defId,
      legs: legs as any,
      settle_seconds: settleSeconds,
    });

    res.status(201).json({
      group,
      runs,
      refused: refused.map((r) => ({ broker: r.broker, account: r.account, error: r.error })),
    });
  } catch (error: any) {
    fail(res, 500, 'Failed to deploy definition', error?.message ?? 'unknown');
  }
});

router.get('/groups/:id', async (req: Request, res: Response) => {
  try {
    const groupId = Number(req.params.id);
    if (!Number.isInteger(groupId) || groupId <= 0) return fail(res, 400, 'Invalid group id');
    const runs = await repo.listGroupRuns(groupId);
    if (runs.length === 0) return fail(res, 404, 'Group not found', { group_id: groupId });
    res.json({ group_id: groupId, runs, count: runs.length });
  } catch (error: any) {
    fail(res, 500, 'Failed to read group', error?.message ?? 'unknown');
  }
});

router.post('/groups/:id/stop', async (req: Request, res: Response) => {
  try {
    const groupId = Number(req.params.id);
    if (!Number.isInteger(groupId) || groupId <= 0) return fail(res, 400, 'Invalid group id');
    const stopped = await repo.stopGroup(groupId);
    res.json({ group_id: groupId, stopped });
  } catch (error: any) {
    fail(res, 500, 'Failed to stop group', error?.message ?? 'unknown');
  }
});

/** Panic stop: halt every run on one connection, whatever group they belong to. */
router.post('/connections/:broker/:account/stop', async (req: Request, res: Response) => {
  try {
    const broker = String(req.params.broker || '').toLowerCase();
    const account = String(req.params.account || '').toLowerCase();
    if (!broker || !account) return fail(res, 400, 'broker and account are required');
    const stopped = await repo.stopConnection(broker, account);
    res.json({ connection: `${broker}:${account}`, stopped });
  } catch (error: any) {
    fail(res, 500, 'Failed to stop connection', error?.message ?? 'unknown');
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
    const response = await axios.post(`${BROKER_SERVICE_URL}/strategies/evaluate`, req.body ?? {}, {
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
