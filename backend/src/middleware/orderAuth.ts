/**
 * Order-endpoint authorization: a "trader" role (RBAC) plus a TOTP second
 * factor (MFA), layered on top of the shared bearer-token auth. Both are
 * opt-in and default-off so existing deployments are unaffected until
 * configured — matching the `LIVE_TRADING_ENABLED` / `ORDER_MAX_*` pattern.
 *
 * Applied to the mutating order routes only (create / cancel / modify); the
 * read-only `/config` and `/audit` endpoints stay open (behind normal auth).
 *
 *   - RBAC: when `TRADING_TOKENS` (a comma-separated allowlist) is set, the
 *     request must present a matching `X-Trading-Token` header. Holding a
 *     trading token *is* the trader role — it's a separate credential from
 *     the general `API_TOKEN`, so a viewer can't place orders.
 *   - MFA: when `ORDER_MFA_SECRET` is set, the request must present a valid
 *     `X-MFA-Code` (6-digit TOTP).
 *
 * RBAC runs first (authorization), then MFA (proof of second factor).
 */
import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';

import { logger } from '../services/logger.js';
import { isMfaConfigured, verifyTotp } from '../services/totp.js';

function timingSafeEqualStr(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function tradingTokens(): string[] {
  return (process.env.TRADING_TOKENS || '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** True when the trader-role check is active (a `TRADING_TOKENS` list is set). */
export function isTradingAuthRequired(): boolean {
  return tradingTokens().length > 0;
}

/** True when order-endpoint MFA is active (an `ORDER_MFA_SECRET` is set). */
export function isMfaRequired(): boolean {
  return isMfaConfigured();
}

function headerValue(req: Request, name: string): string {
  const raw = req.headers[name];
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw) && raw.length > 0) return String(raw[0]).trim();
  return '';
}

export function orderAuth(req: Request, res: Response, next: NextFunction) {
  // --- RBAC: trader role -------------------------------------------------
  const allowed = tradingTokens();
  if (allowed.length > 0) {
    const supplied = headerValue(req, 'x-trading-token');
    const ok = supplied.length > 0 && allowed.some((t) => timingSafeEqualStr(supplied, t));
    if (!ok) {
      logger.warn({ path: req.path, method: req.method }, 'order request missing trader role');
      return res.status(403).json({
        error: 'Forbidden',
        detail: 'A valid trading token (X-Trading-Token) is required for order operations.',
        timestamp: new Date().toISOString(),
      });
    }
  }

  // --- MFA: TOTP second factor ------------------------------------------
  if (isMfaConfigured()) {
    const code = headerValue(req, 'x-mfa-code');
    if (!code) {
      return res.status(401).json({
        error: 'MFA required',
        detail: 'A one-time code (X-MFA-Code) is required for order operations.',
        timestamp: new Date().toISOString(),
      });
    }
    if (!verifyTotp((process.env.ORDER_MFA_SECRET || '').trim(), code)) {
      logger.warn({ path: req.path, method: req.method }, 'order request failed MFA');
      return res.status(401).json({
        error: 'Invalid MFA code',
        detail: 'The one-time code (X-MFA-Code) was missing or incorrect.',
        timestamp: new Date().toISOString(),
      });
    }
  }

  return next();
}
