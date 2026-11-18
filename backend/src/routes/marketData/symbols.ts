/**
 * The symbols a broker connection can trade, from the database catalogue
 * (services/symbolCatalogue.ts).
 *
 *   GET  /symbols?source=&account=&market=&q=&limit=   the catalogue, filtered
 *   POST /symbols/refresh  { source, account }          fetch it again now
 */
import express from 'express';
import type { Request, Response } from 'express';

import { dbService } from '../../services/database.js';
import { SymbolCatalogue } from '../../services/symbolCatalogue.js';
import { resolveBroker } from './shared.js';

const ACCOUNT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function createSymbolsRouter(catalogue: SymbolCatalogue): express.Router {
  const router = express.Router();

  function connection(source: unknown, account: unknown) {
    const acct = typeof account === 'string' ? account.trim() : '';
    if (acct && !ACCOUNT_RE.test(acct)) return null;
    return { platform: resolveBroker(typeof source === 'string' ? source : ''), account: acct };
  }

  async function answer(res: Response, query: Parameters<SymbolCatalogue['list']>[0]) {
    try {
      const result = await catalogue.list(query);
      // Nothing stored and the broker unreachable: say why, as a 502.
      if (result.error && result.refreshed_at === null) {
        return res.status(502).json({ ...result, message: result.error });
      }
      res.json(result);
    } catch (error: any) {
      res.status(500).json({
        error: 'Failed to read the symbol list',
        message: error?.message ?? 'unknown',
      });
    }
  }

  router.get('/symbols', async (req: Request, res: Response) => {
    const conn = connection(req.query.source ?? req.query.broker, req.query.account);
    if (!conn) return res.status(400).json({ error: 'Invalid account name' });
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    await answer(res, {
      ...conn,
      market: str(req.query.market),
      q: str(req.query.q).slice(0, 64),
      limit: Number(req.query.limit) || undefined,
      accountMode: str(req.query.account_mode) === 'live' ? 'live' : 'paper',
    });
  });

  router.post('/symbols/refresh', async (req: Request, res: Response) => {
    const body = req.body || {};
    const conn = connection(body.source ?? body.broker, body.account);
    if (!conn) return res.status(400).json({ error: 'Invalid account name' });
    await answer(res, { ...conn, refresh: true, limit: 1 });
  });

  return router;
}

export default createSymbolsRouter(new SymbolCatalogue(dbService));
