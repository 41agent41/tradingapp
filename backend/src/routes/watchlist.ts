/**
 * Watchlist routes.
 *
 *   GET    /api/watchlist       — list, in sort_order
 *   POST   /api/watchlist       — add a symbol (idempotent — 200 if already
 *                                 present, 201 if newly added)
 *   DELETE /api/watchlist/:id   — remove
 *
 * A single flat list (no per-user scoping — see the schema comment on
 * `watchlist_items`). This is deliberately just a symbol list, not a quote
 * cache: the frontend fetches live prices from the existing
 * `/api/market-data/realtime` endpoint (already Redis-cached) per row.
 */
import express from 'express';
import type { Request, Response } from 'express';

import { dbService } from '../services/database.js';
import { WatchlistRepository } from '../services/watchlistRepository.js';
import { isBroker, BROKERS, DEFAULT_BROKER } from '../services/orderTypes.js';

const router = express.Router();
const repo = new WatchlistRepository(dbService);

function fail(res: Response, status: number, error: string, detail?: unknown) {
  res.status(status).json({ error, detail, timestamp: new Date().toISOString() });
}

router.get('/', async (_req: Request, res: Response) => {
  try {
    const rows = await repo.list();
    res.json({ items: rows, count: rows.length });
  } catch (error: any) {
    fail(res, 500, 'Failed to list watchlist', error?.message ?? 'unknown');
  }
});

router.post('/', async (req: Request, res: Response) => {
  const { symbol, broker, sec_type, exchange, currency, notes } = req.body || {};
  if (typeof symbol !== 'string' || !symbol.trim()) {
    return fail(res, 400, 'symbol is required');
  }
  if (broker !== undefined && !isBroker(broker)) {
    return fail(res, 400, 'Invalid broker', { valid: [...BROKERS] });
  }
  if (notes !== undefined && notes !== null && typeof notes !== 'string') {
    return fail(res, 400, 'notes must be a string');
  }
  try {
    const { added, row } = await repo.add({
      symbol,
      broker: broker ?? DEFAULT_BROKER,
      sec_type: typeof sec_type === 'string' && sec_type ? sec_type : undefined,
      exchange: typeof exchange === 'string' && exchange ? exchange : undefined,
      currency: typeof currency === 'string' && currency ? currency : undefined,
      notes: notes ?? null,
    });
    res.status(added ? 201 : 200).json(row);
  } catch (error: any) {
    fail(res, 500, 'Failed to add to watchlist', error?.message ?? 'unknown');
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid watchlist item id');
  try {
    const { removed } = await repo.remove(id);
    if (!removed) return fail(res, 404, 'Watchlist item not found', { id });
    res.status(204).end();
  } catch (error: any) {
    fail(res, 500, 'Failed to remove watchlist item', error?.message ?? 'unknown');
  }
});

export default router;
