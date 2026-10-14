/**
 * Broker connections for the UI (Settings > Connections and the header badge).
 *
 *   GET    /api/brokers/status            every connection in effect, in broker
 *                                         priority order, with its last check
 *   POST   /api/brokers/:label/test       check one connection now
 *   GET    /api/brokers/connections       connections added in the app (no secrets)
 *   POST   /api/brokers/connections       add one, then check it
 *   PUT    /api/brokers/connections/:id   change one (blank secrets keep theirs),
 *                                         then check it
 *   DELETE /api/brokers/connections/:id   remove one
 *   PUT    /api/brokers/priority          { priority: [platform, ...] }
 *
 * The broker service owns the checks (broker_service/probes.py); the status
 * and test routes only relay them. A test is read-only at the venue, so it
 * needs a signed-in user, not the trader role. Adding, changing, removing or
 * reranking a broker decides where orders go, so those need the same trader
 * role and MFA as placing an order.
 */

import express from 'express';
import type { Request, Response } from 'express';
import axios from 'axios';
import { logger } from '../services/logger.js';
import { configService, SettingWriteError } from '../config/configService.js';
import { encryptionKey } from '../config/secretBox.js';
import { isMfaRequired, isTradingAuthRequired, orderAuth } from '../middleware/orderAuth.js';
import { BrokerConnectionError, PLATFORMS } from '../services/brokerConnections.js';
import { brokerConnectionStore, brokerSync } from '../services/brokerConnectionsRuntime.js';
import { brokerPriorityFromConfig } from '../services/brokerSync.js';

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

async function testConnection(label: string) {
  // A venue's own HTTP timeout is 30 s; allow for it.
  const r = await axios.post(
    `${BROKER_SERVICE_URL}/connections/${encodeURIComponent(label)}/test`,
    null,
    { timeout: 40000 }
  );
  return r.data;
}

router.post('/:label/test', async (req: Request, res: Response) => {
  const label = String(req.params.label || '').toLowerCase();
  if (!LABEL_PATTERN.test(label)) {
    return res.status(400).json({ error: 'label must look like platform:account' });
  }
  try {
    res.json(await testConnection(label));
  } catch (error) {
    relayError(res, error, 'broker test');
  }
});

/**
 * Check a connection that was just saved, so a wrong key or address shows at
 * once. The save stands either way; this only reports. Null when the broker
 * service has not taken the new set yet (`sync_error` says why).
 */
async function checkAfterSave(
  label: string,
  syncError: string | null
): Promise<{ check: unknown; check_error: string | null }> {
  if (syncError) return { check: null, check_error: null };
  try {
    const body = await testConnection(label);
    return { check: body?.check ?? null, check_error: null };
  } catch (err: any) {
    const message = String(err?.response?.data?.detail ?? err?.message ?? err);
    logger.warn({ connection: label, err: message }, 'broker check after save failed');
    return { check: null, check_error: message };
  }
}

function actor(req: Request): string {
  return req.headers.authorization || req.headers['x-api-token'] ? 'api token' : 'browser';
}

function encryptionReady(): boolean {
  try {
    return encryptionKey() !== null;
  } catch {
    return false;
  }
}

function sendWriteError(res: Response, err: unknown) {
  if (err instanceof BrokerConnectionError || err instanceof SettingWriteError) {
    return res.status(err.status).json({ error: err.message });
  }
  logger.error({ err: (err as Error)?.message }, 'broker connection write failed');
  return res.status(500).json({ error: 'The connection could not be saved.' });
}

/**
 * Send the new set to the broker service now. The save already stands; a
 * failure here is reported with it, and the background sync keeps retrying.
 */
async function pushNow(): Promise<string | null> {
  try {
    await brokerSync.sync(true);
    return null;
  } catch (err: any) {
    const message = String(err?.response?.data?.detail ?? err?.message ?? err);
    logger.warn({ err: message }, 'broker connection sync after save failed');
    return message;
  }
}

function idParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new BrokerConnectionError('Bad connection id.', 400);
  return id;
}

router.get('/connections', async (_req: Request, res: Response) => {
  try {
    res.json({
      connections: await brokerConnectionStore.list(),
      platforms: PLATFORMS,
      priority: brokerPriorityFromConfig(),
      priority_locked: configService.source('BROKER_PRIORITY') === 'environment',
      encryption_ready: encryptionReady(),
      auth: {
        trading_auth_required: isTradingAuthRequired(),
        mfa_required: isMfaRequired(),
      },
    });
  } catch (err) {
    logger.error({ err: (err as Error)?.message }, 'broker connections read failed');
    res.status(503).json({ error: 'Broker connections could not be read.' });
  }
});

router.post('/connections', orderAuth, async (req: Request, res: Response) => {
  try {
    const connection = await brokerConnectionStore.create(req.body ?? {}, {
      actor: actor(req),
      ip: req.ip ?? null,
    });
    logger.info({ connection: connection.label, actor: actor(req) }, 'broker connection added');
    const syncError = await pushNow();
    res.status(201).json({
      connection,
      sync_error: syncError,
      ...(await checkAfterSave(connection.label, syncError)),
    });
  } catch (err) {
    sendWriteError(res, err);
  }
});

router.put('/connections/:id', orderAuth, async (req: Request, res: Response) => {
  try {
    const connection = await brokerConnectionStore.update(idParam(req), req.body ?? {}, {
      actor: actor(req),
      ip: req.ip ?? null,
    });
    logger.info({ connection: connection.label, actor: actor(req) }, 'broker connection changed');
    const syncError = await pushNow();
    res.json({
      connection,
      sync_error: syncError,
      ...(await checkAfterSave(connection.label, syncError)),
    });
  } catch (err) {
    sendWriteError(res, err);
  }
});

router.delete('/connections/:id', orderAuth, async (req: Request, res: Response) => {
  try {
    await brokerConnectionStore.remove(idParam(req), { actor: actor(req), ip: req.ip ?? null });
    logger.info({ id: req.params.id, actor: actor(req) }, 'broker connection removed');
    res.json({ ok: true, sync_error: await pushNow() });
  } catch (err) {
    sendWriteError(res, err);
  }
});

router.put('/priority', orderAuth, async (req: Request, res: Response) => {
  const raw = req.body?.priority;
  const list = Array.isArray(raw) ? raw.map((p) => String(p).trim().toLowerCase()) : [];
  const known = list.filter(
    (p, i) => (PLATFORMS as readonly string[]).includes(p) && list.indexOf(p) === i
  );
  if (known.length === 0 || known.length !== list.length) {
    return res
      .status(400)
      .json({ error: `priority must list brokers from: ${PLATFORMS.join(', ')}.` });
  }
  const full = [...known, ...PLATFORMS.filter((p) => !known.includes(p))];
  try {
    await configService.set('BROKER_PRIORITY', full.join(','), {
      actor: actor(req),
      ip: req.ip ?? null,
      reason: null,
    });
    res.json({ priority: full, sync_error: await pushNow() });
  } catch (err) {
    sendWriteError(res, err);
  }
});

export default router;
