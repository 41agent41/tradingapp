/**
 * In-app-only price alert routes.
 *
 *   GET    /api/alerts              — list (optional ?watchlist_item_id=&status=)
 *   POST   /api/alerts              — create {watchlist_item_id, condition, target_price}
 *   POST   /api/alerts/:id/trigger  — flip an active alert to 'triggered' {triggered_price}
 *   POST   /api/alerts/:id/dismiss  — flip to 'dismissed'
 *   DELETE /api/alerts/:id          — remove
 *
 * There is no server-side price watcher and no delivery channel — the
 * frontend already polls each watchlist row's quote
 * (`/api/market-data/realtime`) and calls `trigger` itself when a
 * condition crosses. This API only persists the resulting state so a
 * triggered alert survives a page refresh or shows up in another tab.
 */
import express from 'express';
import type { Request, Response } from 'express';

import { dbService } from '../services/database.js';
import { WatchlistRepository } from '../services/watchlistRepository.js';
import {
  PriceAlertRepository,
  ALERT_CONDITIONS,
  type AlertCondition,
  type AlertStatus,
} from '../services/priceAlertRepository.js';

const router = express.Router();
const alerts = new PriceAlertRepository(dbService);
const watchlist = new WatchlistRepository(dbService);

const ALERT_STATUSES: readonly AlertStatus[] = ['active', 'triggered', 'dismissed'];

function fail(res: Response, status: number, error: string, detail?: unknown) {
  res.status(status).json({ error, detail, timestamp: new Date().toISOString() });
}

function isAlertCondition(v: unknown): v is AlertCondition {
  return typeof v === 'string' && (ALERT_CONDITIONS as readonly string[]).includes(v);
}

function isAlertStatus(v: unknown): v is AlertStatus {
  return typeof v === 'string' && (ALERT_STATUSES as readonly string[]).includes(v);
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const filter: Parameters<typeof alerts.list>[0] = {};
    if (typeof req.query.watchlist_item_id === 'string') {
      const id = Number(req.query.watchlist_item_id);
      if (!Number.isInteger(id) || id <= 0) {
        return fail(res, 400, 'Invalid watchlist_item_id');
      }
      filter.watchlist_item_id = id;
    }
    if (typeof req.query.status === 'string') {
      if (!isAlertStatus(req.query.status)) {
        return fail(res, 400, 'Invalid status', { valid: ALERT_STATUSES });
      }
      filter.status = req.query.status;
    }
    const rows = await alerts.list(filter);
    res.json({ alerts: rows, count: rows.length });
  } catch (error: any) {
    fail(res, 500, 'Failed to list alerts', error?.message ?? 'unknown');
  }
});

router.post('/', async (req: Request, res: Response) => {
  const { watchlist_item_id, condition, target_price } = req.body || {};
  const itemId = Number(watchlist_item_id);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return fail(res, 400, 'watchlist_item_id is required');
  }
  if (!isAlertCondition(condition)) {
    return fail(res, 400, 'Invalid condition', { valid: ALERT_CONDITIONS });
  }
  const price = Number(target_price);
  if (!Number.isFinite(price) || price <= 0) {
    return fail(res, 400, 'target_price must be a positive number');
  }
  try {
    const item = await watchlist.find(itemId);
    if (!item) {
      return fail(res, 404, 'Watchlist item not found', { watchlist_item_id: itemId });
    }
    const row = await alerts.create({ watchlist_item_id: itemId, condition, target_price: price });
    res.status(201).json(row);
  } catch (error: any) {
    fail(res, 500, 'Failed to create alert', error?.message ?? 'unknown');
  }
});

router.post('/:id/trigger', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid alert id');
  const triggeredPrice = Number(req.body?.triggered_price);
  if (!Number.isFinite(triggeredPrice)) {
    return fail(res, 400, 'triggered_price must be a number');
  }
  try {
    const row = await alerts.trigger(id, triggeredPrice);
    if (!row) {
      // Not found, or already triggered/dismissed by a concurrent call —
      // either way there is nothing left to do, so report the current row.
      const current = await alerts.find(id);
      if (!current) return fail(res, 404, 'Alert not found', { id });
      return res.status(200).json(current);
    }
    res.status(200).json(row);
  } catch (error: any) {
    fail(res, 500, 'Failed to trigger alert', error?.message ?? 'unknown');
  }
});

router.post('/:id/dismiss', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid alert id');
  try {
    const row = await alerts.dismiss(id);
    if (!row) return fail(res, 404, 'Alert not found', { id });
    res.status(200).json(row);
  } catch (error: any) {
    fail(res, 500, 'Failed to dismiss alert', error?.message ?? 'unknown');
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid alert id');
  try {
    const { removed } = await alerts.remove(id);
    if (!removed) return fail(res, 404, 'Alert not found', { id });
    res.status(204).end();
  } catch (error: any) {
    fail(res, 500, 'Failed to remove alert', error?.message ?? 'unknown');
  }
});

export default router;
