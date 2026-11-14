/**
 * GET /api/market-data/ticks: a broker's own past ticks for one instrument,
 * from a broker that keeps them (cTrader, MT5). Read from the broker each
 * time: nothing is stored or cached here.
 */
import express from 'express';
import type { Request, Response } from 'express';
import axios from 'axios';
import { BROKER_SERVICE_URL } from './shared.js';

const router = express.Router();

export const TICKS_DEFAULT_LIMIT = 5000;
export const TICKS_MAX_LIMIT = 50_000;

/** An ISO 8601 time as the broker service takes it, or null. */
function instant(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 40) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

router.get('/ticks', async (req: Request, res: Response) => {
  const symbol = typeof req.query.symbol === 'string' ? req.query.symbol.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._#/-]{0,31}$/.test(symbol)) {
    return res.status(400).json({ error: 'symbol is required' });
  }
  const start = instant(req.query.start);
  if (!start) return res.status(400).json({ error: 'start must be a date and time' });
  const end = req.query.end === undefined ? undefined : instant(req.query.end);
  if (end === null) return res.status(400).json({ error: 'end must be a date and time' });
  if (end !== undefined && end <= start) {
    return res.status(400).json({ error: 'start must be before end' });
  }
  const limit = req.query.limit === undefined ? TICKS_DEFAULT_LIMIT : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > TICKS_MAX_LIMIT) {
    return res
      .status(400)
      .json({ error: `limit must be a whole number from 1 to ${TICKS_MAX_LIMIT}` });
  }
  // Optional connection: the broker platform and its account.
  const name = (v: unknown) =>
    typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(v) ? v : undefined;
  try {
    const response = await axios.get(`${BROKER_SERVICE_URL}/market-data/ticks`, {
      params: {
        symbol,
        start,
        end,
        limit,
        source: name(req.query.source),
        account: name(req.query.account),
      },
      // A long window is read from the broker a page at a time.
      timeout: 60_000,
    });
    res.json(response.data);
  } catch (error: any) {
    const upstream = error?.response;
    if (upstream?.status) {
      // 501: this broker keeps no ticks.
      return res.status(upstream.status).json({
        error: upstream.data?.detail || upstream.data?.error || 'Tick history failed',
      });
    }
    res.status(502).json({ error: 'The broker service did not answer' });
  }
});

export default router;
