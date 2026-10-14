/**
 * /api/settings — the Settings page's API.
 *
 *   GET    /api/settings          every registered setting, where its value
 *                                 comes from, and whether it can be changed
 *   GET    /api/settings/audit    the change log, newest first (?key=, ?limit=)
 *   PUT    /api/settings/:key     { value, reason? } — store a value
 *   DELETE /api/settings/:key     { reason? } — back to the default
 *
 * Secret values are never returned: a secret shows only whether it is set.
 * Bootstrap values (database, encryption key, service token, ports) are not
 * registered, so they are neither listed nor writable.
 *
 * Changing a setting marked `step_up` needs the same trader role and MFA code
 * as placing an order (`orderAuth`), so the browser password alone cannot
 * raise a cap or loosen a gate.
 */
import { NextFunction, Request, Response, Router } from 'express';

import { configService, SettingWriteError } from '../config/configService.js';
import { SECTIONS, settingDef } from '../config/registry.js';
import { isMfaRequired, isTradingAuthRequired, orderAuth } from '../middleware/orderAuth.js';
import { logger } from '../services/logger.js';

const router = Router();

function actor(req: Request): string {
  return req.headers.authorization || req.headers['x-api-token'] ? 'api token' : 'browser';
}

function reasonOf(req: Request): string | null {
  const raw = req.body?.reason;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, 500) : null;
}

/** Applies the order step-up to settings that are marked for it. */
function stepUp(req: Request, res: Response, next: NextFunction) {
  const def = settingDef(req.params.key);
  if (def?.stepUp) return orderAuth(req, res, next);
  return next();
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

router.put('/:key', stepUp, async (req: Request, res: Response) => {
  const { key } = req.params;
  try {
    await configService.set(key, req.body?.value, {
      actor: actor(req),
      ip: req.ip ?? null,
      reason: reasonOf(req),
    });
    logger.info({ key, actor: actor(req) }, 'settings: value saved');
    const view = configService.describe().find((s) => s.key === key);
    return res.json({ setting: view });
  } catch (err) {
    return sendError(res, err, key);
  }
});

router.delete('/:key', stepUp, async (req: Request, res: Response) => {
  const { key } = req.params;
  try {
    await configService.clear(key, {
      actor: actor(req),
      ip: req.ip ?? null,
      reason: reasonOf(req),
    });
    logger.info({ key, actor: actor(req) }, 'settings: value cleared');
    const view = configService.describe().find((s) => s.key === key);
    return res.json({ setting: view });
  } catch (err) {
    return sendError(res, err, key);
  }
});

export default router;
