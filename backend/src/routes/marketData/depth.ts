/**
 * GET /api/market-data/depth: the order book of one instrument, from a
 * broker that publishes one (cTrader). Never cached: a book is only useful
 * as it is now.
 */
import express from 'express';
import type { Request, Response } from 'express';
import axios from 'axios';
import { BROKER_SERVICE_URL } from './shared.js';

const router = express.Router();

export const DEPTH_DEFAULT_LEVELS = 10;
export const DEPTH_MAX_LEVELS = 50;

router.get('/depth', async (req: Request, res: Response) => {
  const symbol = typeof req.query.symbol === 'string' ? req.query.symbol.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._#/-]{0,31}$/.test(symbol)) {
    return res.status(400).json({ error: 'symbol is required' });
  }
  const levels = req.query.levels === undefined ? DEPTH_DEFAULT_LEVELS : Number(req.query.levels);
  if (!Number.isInteger(levels) || levels < 1 || levels > DEPTH_MAX_LEVELS) {
    return res
      .status(400)
      .json({ error: `levels must be a whole number from 1 to ${DEPTH_MAX_LEVELS}` });
  }
  // Optional connection: the broker platform and its account.
  const name = (v: unknown) =>
    typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(v) ? v : undefined;
  try {
    const response = await axios.get(`${BROKER_SERVICE_URL}/market-data/depth`, {
      params: {
        symbol,
        levels,
        source: name(req.query.source),
        account: name(req.query.account),
      },
      timeout: 15_000,
    });
    res.json(response.data);
  } catch (error: any) {
    const upstream = error?.response;
    if (upstream?.status) {
      // 501: this broker has no order book. 503: it sent none just now.
      return res.status(upstream.status).json({
        error: upstream.data?.detail || upstream.data?.error || 'Depth of market failed',
      });
    }
    res.status(502).json({ error: 'The broker service did not answer' });
  }
});

export default router;
