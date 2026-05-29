/**
 * Market-data router.
 *
 * This file used to hold every market-data endpoint (~870 lines). It has been
 * split into one module per resource under `routes/marketData/` (GAP_ANALYSIS
 * §3.4); this file just re-assembles them into the single router mounted at
 * `/api/market-data` in `index.ts`, so the public API surface is unchanged.
 */
import express from 'express';
import searchRoutes from './marketData/search.js';
import historyRoutes from './marketData/history.js';
import realtimeRoutes from './marketData/realtime.js';
import indicatorsRoutes from './marketData/indicators.js';
import databaseRoutes from './marketData/database.js';

const router = express.Router();

// Each sub-router declares its own full subpath (e.g. '/search', '/history'),
// so mounting them all at the router root preserves the original paths.
router.use(searchRoutes);
router.use(historyRoutes);
router.use(realtimeRoutes);
router.use(indicatorsRoutes);
router.use(databaseRoutes);

export default router;
