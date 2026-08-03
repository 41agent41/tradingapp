/**
 * Order management routes (Tier 4 item 9).
 *
 *   POST   /api/orders            — create
 *   DELETE /api/orders/:id        — cancel
 *   PUT    /api/orders/:id        — modify
 *   GET    /api/orders/audit      — list persisted attempts (blotter)
 *   GET    /api/orders/config     — surface the live-trading gate + enums
 *
 * Defence in depth: every mutating route validates with
 * `validateOrder` (orderTypes.ts), checks the live-trading gate, writes
 * an audit row before the IB-service call, then updates the audit row
 * with the outcome. The IB service repeats the gate check (see
 * `ib_service/orders.py`). Creates additionally pass an opt-in
 * position-limit guard (`ORDER_MAX_POSITION`) computed from the audit log.
 */
import express from 'express';
import type { Request, Response } from 'express';
import axios from 'axios';

import { dbService } from '../services/database.js';
import { logger, currentRequestId } from '../services/logger.js';
import { orderAuth, isMfaRequired, isTradingAuthRequired } from '../middleware/orderAuth.js';
import { OrderAuditRepository } from '../services/orderAuditRepository.js';
import {
  isLiveTradingEnabled,
  isAccountMode,
  validateOrder,
  positionCap,
  positionLookbackHours,
  checkPositionLimit,
} from '../services/orderTypes.js';

const router = express.Router();
const IB_SERVICE_URL = process.env.IB_SERVICE_URL || 'http://ib_service:8000';
const audit = new OrderAuditRepository(dbService);

function sendProxyError(res: Response, error: any, label: string) {
  let detail = 'Unknown error';
  let statusCode = 500;
  if (error.code === 'ECONNREFUSED') {
    detail = 'IB Service connection refused';
    statusCode = 503;
  } else if (error.response) {
    detail = error.response.data?.detail || error.response.statusText || 'IB Service error';
    statusCode = error.response.status;
  } else {
    detail = error.message || 'Failed to call IB Service';
  }
  res.status(statusCode).json({
    error: label,
    detail,
    ib_service_status: statusCode,
    timestamp: new Date().toISOString(),
  });
}

// -------------------------------------------------------------------------
// Surface the gate + enums so the frontend can decide what to render.
// -------------------------------------------------------------------------
router.get('/config', async (_req: Request, res: Response) => {
  try {
    const ib = await axios.get(`${IB_SERVICE_URL}/orders/config`, { timeout: 5000 });
    res.json({
      live_trading_enabled: isLiveTradingEnabled() && (ib.data?.live_trading_enabled ?? false),
      backend_live_enabled: isLiveTradingEnabled(),
      ib_live_enabled: ib.data?.live_trading_enabled ?? false,
      order_types: ib.data?.order_types ?? ['MKT', 'LMT', 'STP', 'STP_LMT'],
      tif: ib.data?.tif ?? ['DAY', 'GTC', 'IOC', 'FOK'],
      actions: ib.data?.actions ?? ['BUY', 'SELL'],
      position_limit_enabled: positionCap() > 0,
      position_cap: positionCap(),
      trading_auth_required: isTradingAuthRequired(),
      mfa_required: isMfaRequired(),
    });
  } catch (error: any) {
    // Config doesn't need to fail loudly; fall back to the defaults so the
    // UI can still render the read-only blotter.
    logger.warn({ err: String(error?.message ?? error) }, 'orders config probe failed');
    res.json({
      live_trading_enabled: false,
      backend_live_enabled: isLiveTradingEnabled(),
      ib_live_enabled: false,
      order_types: ['MKT', 'LMT', 'STP', 'STP_LMT'],
      tif: ['DAY', 'GTC', 'IOC', 'FOK'],
      actions: ['BUY', 'SELL'],
      trading_auth_required: isTradingAuthRequired(),
      mfa_required: isMfaRequired(),
    });
  }
});

// -------------------------------------------------------------------------
// Create
// -------------------------------------------------------------------------
router.post('/', orderAuth, async (req: Request, res: Response) => {
  const v = validateOrder(req.body);
  if (!v.ok) {
    return res.status(400).json({ error: 'Validation failed', detail: v.errors.join('; ') });
  }
  if (v.value.account_mode === 'live' && !isLiveTradingEnabled()) {
    return res.status(403).json({
      error: 'Live trading is disabled',
      detail:
        'Set LIVE_TRADING_ENABLED=true on the backend AND the IB service to place live orders.',
    });
  }

  // Opt-in position-limit guard. Runs before we persist or forward — a
  // limit breach never reaches IB and (like a validation failure) writes no
  // audit row. Fails closed: if the net can't be computed we refuse, which
  // is consistent with the audit-insert hard dependency below.
  const cap = positionCap();
  if (cap > 0) {
    try {
      const net = await audit.netExposure(
        v.value.symbol,
        v.value.account_mode,
        positionLookbackHours()
      );
      const decision = checkPositionLimit(net, v.value.action, v.value.quantity, cap);
      if (!decision.ok) {
        return res.status(422).json({
          error: 'Position limit exceeded',
          detail: decision.detail,
          current_net: net,
          projected: decision.projected,
          cap,
        });
      }
    } catch (limitErr: any) {
      logger.error(
        { err: String(limitErr?.message ?? limitErr) },
        'position-limit check failed — refusing to place order'
      );
      return res.status(503).json({
        error: 'Position-limit check failed',
        detail: 'Could not evaluate the position limit; refusing to place an unchecked order',
      });
    }
  }

  const requestId = currentRequestId() ?? null;

  // Persist the attempt before we call IB so failures still leave a trail.
  let auditId: number | null = null;
  try {
    const row = await audit.create({
      ...v.value,
      operation: 'CREATE',
      request_id: requestId,
    });
    auditId = row.id;
  } catch (auditErr: any) {
    logger.error(
      { err: String(auditErr?.message ?? auditErr) },
      'order_audit insert failed — refusing to forward to IB'
    );
    return res.status(500).json({
      error: 'Failed to record order attempt',
      detail: 'order_audit insert failed; refusing to place an unaudited order',
    });
  }

  try {
    const ibPayload = {
      symbol: v.value.symbol,
      action: v.value.action,
      quantity: v.value.quantity,
      order_type: v.value.order_type,
      tif: v.value.tif,
      limit_price: v.value.limit_price,
      stop_price: v.value.stop_price,
      account_mode: v.value.account_mode,
      secType: v.value.sec_type,
      exchange: v.value.exchange,
      currency: v.value.currency,
      audit_id: auditId,
    };
    const ibResp = await axios.post(`${IB_SERVICE_URL}/orders`, ibPayload, { timeout: 30_000 });
    const ibBody = ibResp.data ?? {};
    await audit
      .update({
        id: auditId,
        ib_order_id: ibBody.order_id ?? null,
        status: ibBody.status ?? 'submitted',
        raw_response: ibBody,
      })
      .catch((e) => logger.warn({ err: String(e) }, 'audit update after place failed'));

    res.status(201).json({ ...ibBody, audit_id: auditId });
  } catch (error: any) {
    await audit
      .update({
        id: auditId,
        status: 'rejected',
        last_error: error?.response?.data?.detail ?? error?.message ?? 'unknown',
      })
      .catch((e) => logger.warn({ err: String(e) }, 'audit update after reject failed'));
    sendProxyError(res, error, 'Failed to place order');
  }
});

// -------------------------------------------------------------------------
// Cancel
// -------------------------------------------------------------------------
router.delete('/:id', orderAuth, async (req: Request, res: Response) => {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({ error: 'Invalid order id' });
  }

  try {
    const ibResp = await axios.delete(`${IB_SERVICE_URL}/orders/${orderId}`, { timeout: 10_000 });
    // A cancel doesn't produce a *new* audit row — it transitions the
    // existing one (matched by ib_order_id). Best-effort: update the
    // most-recent row for this id.
    try {
      const found = await dbService.query(
        'SELECT id FROM order_audit WHERE ib_order_id = $1 ORDER BY submitted_at DESC LIMIT 1',
        [orderId]
      );
      if (found.rows[0]?.id) {
        await audit.update({
          id: found.rows[0].id,
          status: 'cancel_requested',
          raw_response: ibResp.data ?? {},
        });
      }
    } catch (e) {
      logger.warn({ err: String(e) }, 'audit update after cancel failed');
    }
    res.json(ibResp.data);
  } catch (error: any) {
    sendProxyError(res, error, 'Failed to cancel order');
  }
});

// -------------------------------------------------------------------------
// Modify
// -------------------------------------------------------------------------
router.put('/:id', orderAuth, async (req: Request, res: Response) => {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({ error: 'Invalid order id' });
  }

  // A modify still needs the same validation as a create (it rebuilds the
  // IB Order from scratch, so the same fields must be present).
  const v = validateOrder(req.body);
  if (!v.ok) {
    return res.status(400).json({ error: 'Validation failed', detail: v.errors.join('; ') });
  }
  if (v.value.account_mode === 'live' && !isLiveTradingEnabled()) {
    return res.status(403).json({ error: 'Live trading is disabled' });
  }

  const requestId = currentRequestId() ?? null;

  // A modify rewrites the working order's parameters — capture the *new*
  // parameters as their own audit row (operation=MODIFY) before we call
  // IB, mirroring the create path. We already know the ib_order_id here
  // (it's the path param), so tie the row to it immediately.
  let auditId: number | null = null;
  try {
    const row = await audit.create({
      ...v.value,
      operation: 'MODIFY',
      request_id: requestId,
    });
    auditId = row.id;
    await audit
      .update({ id: auditId, ib_order_id: orderId })
      .catch((e) => logger.warn({ err: String(e) }, 'audit ib_order_id update on modify failed'));
  } catch (auditErr: any) {
    logger.error(
      { err: String(auditErr?.message ?? auditErr) },
      'order_audit insert failed — refusing to forward modify to IB'
    );
    return res.status(500).json({
      error: 'Failed to record order modification',
      detail: 'order_audit insert failed; refusing to modify an unaudited order',
    });
  }

  try {
    const ibResp = await axios.put(
      `${IB_SERVICE_URL}/orders/${orderId}`,
      {
        symbol: v.value.symbol,
        action: v.value.action,
        quantity: v.value.quantity,
        order_type: v.value.order_type,
        tif: v.value.tif,
        limit_price: v.value.limit_price,
        stop_price: v.value.stop_price,
        account_mode: v.value.account_mode,
        secType: v.value.sec_type,
        exchange: v.value.exchange,
        currency: v.value.currency,
      },
      { timeout: 30_000 }
    );
    const ibBody = ibResp.data ?? {};
    await audit
      .update({
        id: auditId,
        status: ibBody.status ?? 'modify_requested',
        raw_response: ibBody,
      })
      .catch((e) => logger.warn({ err: String(e) }, 'audit update after modify failed'));
    res.json({ ...ibBody, audit_id: auditId });
  } catch (error: any) {
    await audit
      .update({
        id: auditId,
        status: 'rejected',
        last_error: error?.response?.data?.detail ?? error?.message ?? 'unknown',
      })
      .catch((e) => logger.warn({ err: String(e) }, 'audit update after modify reject failed'));
    sendProxyError(res, error, 'Failed to modify order');
  }
});

// -------------------------------------------------------------------------
// Audit listing (for the blotter)
// -------------------------------------------------------------------------
router.get('/audit', async (req: Request, res: Response) => {
  try {
    const filter: Parameters<typeof audit.list>[0] = {};
    if (typeof req.query.symbol === 'string' && req.query.symbol) filter.symbol = req.query.symbol;
    if (typeof req.query.account_mode === 'string' && isAccountMode(req.query.account_mode)) {
      filter.account_mode = req.query.account_mode;
    }
    if (typeof req.query.status === 'string' && req.query.status) filter.status = req.query.status;
    if (typeof req.query.limit === 'string') filter.limit = Number(req.query.limit);
    if (typeof req.query.offset === 'string') filter.offset = Number(req.query.offset);
    const rows = await audit.list(filter);
    res.json({ orders: rows, count: rows.length });
  } catch (error: any) {
    logger.error({ err: String(error?.message ?? error) }, 'audit list failed');
    res.status(500).json({ error: 'Failed to list orders', detail: String(error?.message) });
  }
});

export default router;
