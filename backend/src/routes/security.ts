/**
 * /api/security — the Security tab: login password, API and trading tokens,
 * and the order MFA secret (see services/credentials.ts).
 *
 *   GET    /api/security                  what is set, and where (never a secret)
 *   PUT    /api/security/password         { current, password }
 *   POST   /api/security/tokens           { kind: api|trading, label } → the token, once
 *   DELETE /api/security/tokens/:id       revoke
 *   POST   /api/security/mfa              start enrolment → { secret, otpauth_uri }
 *   POST   /api/security/mfa/confirm      { code } → MFA is on
 *   DELETE /api/security/mfa              MFA off
 *
 * The step-up runs the same way as on settings: anything that adds a way in
 * (a new token, a new MFA secret) or removes a safeguard (MFA off) needs the
 * trading token and current MFA code, once those exist. Revoking a token
 * makes things safer and needs only the login. Changing the password needs
 * the current one. Every change is alerted.
 */
import { Request, Response, Router } from 'express';

import { isMfaRequired, isTradingAuthRequired, orderAuth } from '../middleware/orderAuth.js';
import {
  credentials,
  CredentialError,
  MIN_PASSWORD_LENGTH,
  type TokenKind,
} from '../services/credentials.js';
import { logger } from '../services/logger.js';
import { notifier } from '../services/notifier.js';
import { verifyTotp } from '../services/totp.js';

const router = Router();

const ISSUER = 'TradingApp';

function actor(req: Request): string {
  return req.headers.authorization || req.headers['x-api-token'] ? 'api token' : 'browser';
}

function ctx(req: Request) {
  return { actor: actor(req), ip: req.ip ?? null };
}

function announce(req: Request, title: string, critical = false) {
  void notifier
    .notify({
      key: `security:${title}:${Date.now()}`,
      severity: critical ? 'critical' : 'warning',
      title,
      context: { by: actor(req), ip: req.ip ?? 'unknown' },
    })
    .catch((err) => logger.warn({ err: (err as Error)?.message }, 'security: alert failed'));
}

function sendError(res: Response, err: unknown) {
  if (err instanceof CredentialError) return res.status(err.status).json({ error: err.message });
  logger.error({ err: (err as Error)?.message }, 'security: change failed');
  return res.status(500).json({ error: 'The change could not be saved.' });
}

function tokenKind(raw: unknown): TokenKind | null {
  return raw === 'api' || raw === 'trading' ? raw : null;
}

router.get('/', (_req: Request, res: Response) => {
  res.json({
    password: { source: credentials.passwordSource(), min_length: MIN_PASSWORD_LENGTH },
    tokens: {
      api: credentials.listTokens('api'),
      trading: credentials.listTokens('trading'),
      env: {
        api: credentials.envTokenCount('api'),
        trading: credentials.envTokenCount('trading'),
      },
    },
    mfa: { source: credentials.mfaSource() },
    auth: {
      trading_auth_required: isTradingAuthRequired(),
      mfa_required: isMfaRequired(),
    },
    status: credentials.status(),
  });
});

router.put('/password', async (req: Request, res: Response) => {
  if (
    credentials.passwordSource() === 'database' &&
    !credentials.verifyPassword(req.body?.current)
  ) {
    return res.status(403).json({ error: 'The current password is wrong.' });
  }
  try {
    await credentials.setPassword(req.body?.password, ctx(req));
    announce(req, 'Login password changed');
    // The new session key signed this browser out too; the next request
    // goes back to the login page, where the new password works.
    return res.json({ ok: true, signed_out: true });
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/tokens', orderAuth, async (req: Request, res: Response) => {
  const kind = tokenKind(req.body?.kind);
  if (!kind) return res.status(400).json({ error: 'kind must be api or trading.' });
  try {
    const { token, view } = await credentials.createToken(kind, req.body?.label, ctx(req));
    announce(req, `${kind === 'api' ? 'API' : 'Trading'} token created: ${view.label}`);
    return res.status(201).json({ token, view });
  } catch (err) {
    return sendError(res, err);
  }
});

router.delete('/tokens/:id', async (req: Request, res: Response) => {
  try {
    const view = await credentials.revokeToken(req.params.id, ctx(req));
    announce(req, `${view.kind === 'api' ? 'API' : 'Trading'} token revoked: ${view.label}`);
    return res.json({ revoked: view });
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/mfa', orderAuth, (req: Request, res: Response) => {
  try {
    const secret = credentials.beginMfa();
    const label = encodeURIComponent(`${ISSUER}:orders`);
    const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${ISSUER}&algorithm=SHA1&digits=6&period=30`;
    return res.json({ secret, otpauth_uri: uri });
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/mfa/confirm', async (req: Request, res: Response) => {
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  try {
    await credentials.confirmMfa((secret) => verifyTotp(secret, code), ctx(req));
    announce(req, 'Order MFA set up');
    return res.json({ ok: true });
  } catch (err) {
    return sendError(res, err);
  }
});

router.delete('/mfa', orderAuth, async (req: Request, res: Response) => {
  try {
    await credentials.removeMfa(ctx(req));
    announce(req, 'Order MFA removed; live trading is closed until it is set up again', true);
    return res.json({ ok: true });
  } catch (err) {
    return sendError(res, err);
  }
});

export default router;
