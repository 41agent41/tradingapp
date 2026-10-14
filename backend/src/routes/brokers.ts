/**
 * Broker connection status for the UI (Settings page and header badge).
 *
 *   GET  /api/brokers/status        every configured connection, in broker
 *                                   priority order, with its last check
 *   POST /api/brokers/:label/test   check one connection now
 *
 * The broker service owns the checks (broker_service/probes.py); these routes
 * only relay them. A test is read-only at the venue (an account read or a
 * socket connect), so it needs a signed-in user, not the trader role.
 */

import express from 'express';
import type { Request, Response } from 'express';
import axios from 'axios';
import { logger } from '../services/logger.js';

const router = express.Router();
const BROKER_SERVICE_URL = process.env.BROKER_SERVICE_URL || 'http://broker_service:8000';
// A connection is `<platform>:<account>`; anything else never reaches the broker service.
const LABEL_PATTERN = /^[a-z0-9]+:[a-z0-9][a-z0-9_-]*$/;

function relayError(res: Response, error: any, what: string) {
  const status = error?.response?.status ?? 503;
  const detail = error?.response?.data?.detail ?? error?.message ?? 'broker service unreachable';
  logger.warn({ status, detail: String(detail) }, `${what} failed`);
  res.status(status).json({ error: String(detail) });
}

router.get('/status', async (_req: Request, res: Response) => {
  try {
    const r = await axios.get(`${BROKER_SERVICE_URL}/connections/status`, { timeout: 10000 });
    res.json(r.data);
  } catch (error) {
    relayError(res, error, 'broker status');
  }
});

router.post('/:label/test', async (req: Request, res: Response) => {
  const label = String(req.params.label || '').toLowerCase();
  if (!LABEL_PATTERN.test(label)) {
    return res.status(400).json({ error: 'label must look like platform:account' });
  }
  try {
    // A venue's own HTTP timeout is 30 s; allow for it.
    const r = await axios.post(
      `${BROKER_SERVICE_URL}/connections/${encodeURIComponent(label)}/test`,
      null,
      { timeout: 40000 }
    );
    res.json(r.data);
  } catch (error) {
    relayError(res, error, 'broker test');
  }
});

export default router;
