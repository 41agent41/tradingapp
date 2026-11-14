/**
 * GET /api/market-data/sentiment: the share of a broker's clients holding one
 * instrument long and short, from a broker that publishes it (IG). Never
 * cached here: it is read on request.
 */
import express from 'express';
import type { Request, Response } from 'express';
import axios from 'axios';
import { BROKER_SERVICE_URL } from './shared.js';

const router = express.Router();

router.get('/sentiment', async (req: Request, res: Response) => {
  const symbol = typeof req.query.symbol === 'string' ? req.query.symbol.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._#/-]{0,31}$/.test(symbol)) {
    return res.status(400).json({ error: 'symbol is required' });
  }
  // Optional connection: the broker platform and its account.
  const name = (v: unknown) =>
    typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(v) ? v : undefined;
  try {
    const response = await axios.get(`${BROKER_SERVICE_URL}/market-data/sentiment`, {
      params: { symbol, source: name(req.query.source), account: name(req.query.account) },
      timeout: 15_000,
    });
    res.json(response.data);
  } catch (error: any) {
    const upstream = error?.response;
    if (upstream?.status) {
      // 501: this broker publishes none. 404: it has none for this market.
      return res.status(upstream.status).json({
        error: upstream.data?.detail || upstream.data?.error || 'Client sentiment failed',
      });
    }
    res.status(502).json({ error: 'The broker service did not answer' });
  }
});

export default router;
