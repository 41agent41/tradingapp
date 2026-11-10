/**
 * Bar replay (E-04): the stored bars a replay plays.
 *
 *   GET /api/market-data/replay?symbol=&timeframe=&start=[&source=&account=&secType=&limit=]
 *
 * Answers the stored 1-minute bars from `start` and the bars of the
 * timeframe before it. Nothing is fetched from a broker: a replay shows what
 * the database holds.
 */
import express from 'express';
import type { Request, Response } from 'express';

import { BacktestDataError, REPLAY_MAX_MINUTES } from '../../services/backtestData.js';
import { storedBars } from '../../services/storedBars.js';
import { resolveBroker } from './shared.js';

const router = express.Router();
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

router.get('/replay', async (req: Request, res: Response) => {
  try {
    const q = req.query;
    const symbol = text(q.symbol).toUpperCase();
    if (!symbol) return res.status(400).json({ error: 'symbol is required' });
    const start = new Date(text(q.start));
    if (!text(q.start) || Number.isNaN(start.getTime())) {
      return res
        .status(400)
        .json({ error: 'start is required: a date and time, such as 2026-01-05T08:00:00Z' });
    }
    const limit = q.limit === undefined ? REPLAY_MAX_MINUTES : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      return res.status(400).json({ error: 'limit must be a whole number of 1-minute bars' });
    }
    const bars = await storedBars.replay(
      {
        broker: resolveBroker(text(q.source) || text(q.broker)),
        account: text(q.account).toLowerCase() || undefined,
        symbol,
        secType: text(q.secType).toUpperCase() || 'STK',
      },
      text(q.timeframe) || '5min',
      start,
      limit
    );
    res.json(bars);
  } catch (error) {
    if (error instanceof BacktestDataError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('Error loading replay bars:', error);
    res.status(500).json({ error: 'Failed to load replay bars' });
  }
});

export default router;
