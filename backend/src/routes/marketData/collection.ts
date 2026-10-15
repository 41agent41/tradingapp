/**
 * What market data the app collects on its own (Settings > Schedulers and
 * data), backed by `data_collection_config`:
 *
 *   GET    /api/market-data/collection        every entry, with its newest bar
 *   POST   /api/market-data/collection        add an instrument and timeframe
 *   PUT    /api/market-data/collection/:id    change its options
 *   DELETE /api/market-data/collection/:id    stop collecting (bars are kept)
 */
import express from 'express';
import type { Request, Response } from 'express';
import { dbService } from '../../services/database.js';
import { marketDataService } from '../../services/marketDataService.js';
import { logger } from '../../services/logger.js';
import {
  COLLECTION_TIMEFRAMES,
  CollectionConfigError,
  CollectionConfigRepository,
} from '../../services/collectionConfig.js';
import { BROKERS } from '../../services/brokers.js';

export function collectionRouter(
  repo = new CollectionConfigRepository(dbService, marketDataService)
) {
  const router = express.Router();

  const fail = (res: Response, err: unknown, what: string) => {
    if (err instanceof CollectionConfigError) {
      return res.status(err.status).json({ error: err.message });
    }
    logger.error({ err: (err as Error)?.message }, `data collection ${what} failed`);
    return res.status(500).json({ error: `The data collection list could not be ${what}.` });
  };

  const id = (req: Request) => {
    const n = Number(req.params.id);
    if (!Number.isInteger(n) || n <= 0) throw new CollectionConfigError('Bad id.', 400);
    return n;
  };

  router.get('/collection', async (_req, res) => {
    try {
      res.json({
        entries: await repo.list(),
        brokers: BROKERS,
        timeframes: COLLECTION_TIMEFRAMES,
      });
    } catch (err) {
      fail(res, err, 'read');
    }
  });

  router.post('/collection', async (req, res) => {
    try {
      res.status(201).json({ entry: await repo.add(req.body ?? {}) });
    } catch (err) {
      fail(res, err, 'saved');
    }
  });

  router.put('/collection/:id', async (req, res) => {
    try {
      res.json({ entry: await repo.update(id(req), req.body ?? {}) });
    } catch (err) {
      fail(res, err, 'saved');
    }
  });

  router.delete('/collection/:id', async (req, res) => {
    try {
      await repo.remove(id(req));
      res.status(204).end();
    } catch (err) {
      fail(res, err, 'saved');
    }
  });

  return router;
}

export default collectionRouter();
