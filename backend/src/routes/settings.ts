/**
 * /api/settings — the Settings page's API.
 *
 *   GET    /api/settings          every registered setting, where its value
 *                                 comes from, and whether it can be changed
 *   GET    /api/settings/audit    the change log, newest first (?key=, ?limit=)
 *   GET    /api/settings/checklist  what a new install still needs (Getting started)
 *   PUT    /api/settings/:key     { value, reason? } — store a value
 *   DELETE /api/settings/:key     { reason? } — back to the default
 *
 * Secret values are never returned: a secret shows only whether it is set.
 * Bootstrap values (database, encryption key, service token, ports) are not
 * registered, so they are neither listed nor writable.
 *
 * Changing a setting marked `step_up` needs the same trader role and MFA code
 * as placing an order (`orderAuth`), so the browser password alone cannot
 * raise a cap or loosen a gate. A change in the setting's safer direction
 * (turning trading off, lowering a cap) skips it: stopping trading is never
 * harder than starting it.
 *
 * Turning live trading on also needs a trading token and an order MFA secret
 * to exist, and `confirm: "LIVE"` in the body, typed by the person. Every
 * saved change to a step-up setting is sent as an alert.
 */
import { NextFunction, Request, Response, Router } from 'express';

import { configService, SettingWriteError } from '../config/configService.js';
import { SECTIONS, isSaferChange, normalizeValue, settingDef } from '../config/registry.js';
import { isMfaRequired, isTradingAuthRequired, orderAuth } from '../middleware/orderAuth.js';
import { checklist, loadChecklistState } from '../services/commissioning.js';
import { logger } from '../services/logger.js';
import { notifier } from '../services/notifier.js';
import { liveTradingSafeguardsMissing } from '../services/orderTypes.js';

const router = Router();

const BROKER_SERVICE_URL = process.env.BROKER_SERVICE_URL || 'http://broker_service:8000';

function actor(req: Request): string {
  return req.headers.authorization || req.headers['x-api-token'] ? 'api token' : 'browser';
}

function reasonOf(req: Request): string | null {
  const raw = req.body?.reason;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, 500) : null;
}

/** The value a PUT asks for (normalised), or the default a DELETE restores. */
function requestedValue(req: Request): string | undefined {
  const def = settingDef(req.params.key);
  if (!def) return undefined;
  if (req.method === 'DELETE') return def.default;
  try {
    return normalizeValue(def, req.body?.value);
  } catch {
    return undefined; // the save itself reports why
  }
}

/** Applies the order step-up to settings marked for it, unless the change is safer. */
function stepUp(req: Request, res: Response, next: NextFunction) {
  const def = settingDef(req.params.key);
  if (!def?.stepUp) return next();
  const current = configService.get(def.key) ?? def.default;
  if (isSaferChange(def, current, requestedValue(req))) return next();
  return orderAuth(req, res, next);
}

/** Turning live trading on: the safeguards must exist and the person types LIVE. */
function liveGuard(req: Request, res: Response, next: NextFunction) {
  if (req.params.key !== 'LIVE_TRADING_ENABLED' || requestedValue(req) !== 'true') return next();
  const missing = liveTradingSafeguardsMissing();
  if (missing.length) {
    return res.status(409).json({
      error: `Live trading needs ${missing.join(' and ')} first. Set them up under Security.`,
      key: req.params.key,
    });
  }
  if (req.body?.confirm !== 'LIVE') {
    return res.status(400).json({
      error: 'Type LIVE to confirm turning on live trading.',
      key: req.params.key,
      confirm_required: 'LIVE',
    });
  }
  return next();
}

/** Tells the alert channels about a saved change to a step-up setting. */
function announce(req: Request, key: string, from: string | null, to: string | null) {
  const def = settingDef(key);
  if (!def?.stepUp) return;
  const shown = (v: string | null) => (def.secret ? '(secret)' : (v ?? 'default'));
  void notifier
    .notify({
      key: `settings:${key}:${Date.now()}`,
      severity: key === 'LIVE_TRADING_ENABLED' && to === 'true' ? 'critical' : 'warning',
      title: `Setting changed: ${def.label}`,
      detail: `${shown(from)} → ${shown(to)}`,
      context: { by: actor(req), ip: req.ip ?? 'unknown', reason: reasonOf(req) ?? '' },
    })
    .catch((err) => logger.warn({ key, err: (err as Error)?.message }, 'settings: alert failed'));
}

function effective(key: string): string | null {
  return configService.describe().find((s) => s.key === key)?.value ?? null;
}

function sendError(res: Response, err: unknown, key: string) {
  if (err instanceof SettingWriteError) {
    return res.status(err.status).json({ error: err.message, key });
  }
  logger.error({ key, err: (err as Error)?.message }, 'settings: write failed');
  return res.status(500).json({ error: 'The setting could not be saved.', key });
}

router.get('/', (_req: Request, res: Response) => {
  res.json({
    sections: SECTIONS,
    settings: configService.describe(),
    status: configService.status(),
    auth: {
      trading_auth_required: isTradingAuthRequired(),
      mfa_required: isMfaRequired(),
    },
  });
});

router.get('/checklist', async (_req: Request, res: Response) => {
  try {
    const items = checklist(await loadChecklistState(BROKER_SERVICE_URL));
    res.json({ items, done: items.every((i) => i.done) });
  } catch (err) {
    logger.error({ err: (err as Error)?.message }, 'settings: checklist failed');
    res.status(500).json({ error: 'The checklist could not be read.' });
  }
});

router.get('/audit', async (req: Request, res: Response) => {
  try {
    const key = typeof req.query.key === 'string' && req.query.key ? req.query.key : undefined;
    const limit = Number(req.query.limit ?? 200);
    res.json({ entries: await configService.audit(limit, key) });
  } catch (err) {
    logger.error({ err: (err as Error)?.message }, 'settings: audit read failed');
    res.status(503).json({ error: 'The settings history could not be read.' });
  }
});

router.put('/:key', stepUp, liveGuard, async (req: Request, res: Response) => {
  const { key } = req.params;
  try {
    const before = effective(key);
    await configService.set(key, req.body?.value, {
      actor: actor(req),
      ip: req.ip ?? null,
      reason: reasonOf(req),
    });
    logger.info({ key, actor: actor(req) }, 'settings: value saved');
    const view = configService.describe().find((s) => s.key === key);
    announce(req, key, before, view?.value ?? null);
    return res.json({ setting: view });
  } catch (err) {
    return sendError(res, err, key);
  }
});

router.delete('/:key', stepUp, async (req: Request, res: Response) => {
  const { key } = req.params;
  try {
    const before = effective(key);
    await configService.clear(key, {
      actor: actor(req),
      ip: req.ip ?? null,
      reason: reasonOf(req),
    });
    logger.info({ key, actor: actor(req) }, 'settings: value cleared');
    const view = configService.describe().find((s) => s.key === key);
    announce(req, key, before, view?.value ?? null);
    return res.json({ setting: view });
  } catch (err) {
    return sendError(res, err, key);
  }
});

export default router;
