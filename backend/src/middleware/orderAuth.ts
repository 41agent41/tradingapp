/**
 * Order-endpoint authorization: a "trader" role (RBAC) plus a TOTP second
 * factor (MFA), layered on top of the shared bearer-token auth. Both are
 * opt-in and default-off so existing deployments are unaffected until
 * configured — matching the `LIVE_TRADING_ENABLED` / `ORDER_MAX_*` pattern.
 *
 * Applied to the mutating order routes only (create / cancel / modify); the
 * read-only `/config` and `/audit` endpoints stay open (behind normal auth).
 *
 *   - RBAC: once any trading token exists (`TRADING_TOKENS` in `.env`, or one
 *     created on the Security tab), the request must present a matching
 *     `X-Trading-Token` header. Holding a trading token *is* the trader role —
 *     it's a separate credential from the API token, so a viewer can't place
 *     orders.
 *   - MFA: once an MFA secret is set (`ORDER_MFA_SECRET`, or enrolled on the
 *     Security tab), the request must present a valid `X-MFA-Code` (6-digit
 *     TOTP).
 *
 * RBAC runs first (authorization), then MFA (proof of second factor).
 */
import type { NextFunction, Request, Response } from 'express';

import { credentials } from '../services/credentials.js';
import { logger } from '../services/logger.js';
import { isMfaConfigured, verifyTotp } from '../services/totp.js';

/**
 * Marks a 401 that is about the MFA code, not the login, so the page shows
 * the error instead of sending the browser to the login screen.
 */
export const STEP_UP_HEADER = 'X-Step-Up-Required';

/** True when the trader-role check is active (any trading token exists). */
export function isTradingAuthRequired(): boolean {
  return credentials.hasTokens('trading');
}

/** True when order-endpoint MFA is active (an MFA secret is set). */
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
  if (isTradingAuthRequired()) {
    if (!credentials.matchToken('trading', headerValue(req, 'x-trading-token'))) {
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
      return res.status(401).set(STEP_UP_HEADER, 'mfa').json({
        error: 'MFA required',
        detail: 'A one-time code (X-MFA-Code) is required for order operations.',
        timestamp: new Date().toISOString(),
      });
    }
    if (!verifyTotp(credentials.mfaSecret(), code)) {
      logger.warn({ path: req.path, method: req.method }, 'order request failed MFA');
      return res.status(401).set(STEP_UP_HEADER, 'mfa').json({
        error: 'Invalid MFA code',
        detail: 'The one-time code (X-MFA-Code) was missing or incorrect.',
        timestamp: new Date().toISOString(),
      });
    }
  }

  return next();
}
