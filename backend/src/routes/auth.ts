/**
 * Browser login for the single app user. See `services/session.ts`.
 *
 *   POST /api/auth/login    { password } → sets the HttpOnly session cookie
 *   POST /api/auth/logout   → clears it
 *   GET  /api/auth/session  → { authenticated, login_configured, setup_required }
 *   POST /api/auth/setup    { code, password } → first run only: sets the
 *                           password and signs in
 */
import express, { type Request } from 'express';

import { configService } from '../config/configService.js';
import { isAuthConfigured, isAuthenticated } from '../middleware/auth.js';
import { credentials, CredentialError } from '../services/credentials.js';
import { logger } from '../services/logger.js';
import { notifier } from '../services/notifier.js';
import { checkSetupCode, clearSetupCode } from '../services/setupCode.js';
import {
  checkPassword,
  clearedSessionCookie,
  clearLoginFailures,
  isLoginConfigured,
  issueSession,
  loginLocked,
  recordLoginFailure,
  sessionCookie,
} from '../services/session.js';

const router = express.Router();

/** Mark the cookie Secure when the browser reached us over HTTPS. */
function isHttps(req: Request): boolean {
  if (req.secure) return true;
  const proto = req.headers['x-forwarded-proto'];
  const first = (Array.isArray(proto) ? proto[0] : proto || '').split(',')[0].trim();
  return first === 'https' || configService.get('COOKIE_SECURE') === 'true';
}

function clientKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function signIn(req: Request, res: express.Response) {
  const session = issueSession();
  res.setHeader(
    'Set-Cookie',
    sessionCookie(session.value, session.expiresAt - Date.now(), isHttps(req))
  );
  return res.json({ authenticated: true, expires_at: new Date(session.expiresAt).toISOString() });
}

router.post('/login', (req, res) => {
  if (!isLoginConfigured()) {
    return res.status(409).json({
      error: 'Setup required',
      message: 'No password is set yet. Choose one on the setup screen.',
      setup_required: true,
    });
  }
  const key = clientKey(req);
  if (loginLocked(key)) {
    return res.status(429).json({
      error: 'Too many attempts',
      message: 'Too many failed logins. Try again in 15 minutes.',
    });
  }
  if (!checkPassword(req.body?.password)) {
    recordLoginFailure(key);
    return res.status(401).json({ error: 'Unauthorized', message: 'Wrong password.' });
  }
  clearLoginFailures(key);
  return signIn(req, res);
});

router.post('/setup', async (req, res) => {
  if (isLoginConfigured()) {
    return res
      .status(409)
      .json({ error: 'Already set up', message: 'Sign in with your password.' });
  }
  const key = clientKey(req);
  if (loginLocked(key)) {
    return res.status(429).json({
      error: 'Too many attempts',
      message: 'Too many wrong codes. Try again in 15 minutes.',
    });
  }
  if (!checkSetupCode(req.body?.code)) {
    recordLoginFailure(key);
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Wrong setup code. It is in the backend log: ./tradingapp.sh setup-code',
    });
  }
  try {
    await credentials.setPassword(req.body?.password, { actor: 'setup', ip: req.ip ?? null });
  } catch (err) {
    if (err instanceof CredentialError) {
      return res.status(err.status).json({ error: 'Not saved', message: err.message });
    }
    logger.error({ err: (err as Error)?.message }, 'auth: first-run setup failed');
    return res
      .status(500)
      .json({ error: 'Not saved', message: 'The password could not be saved.' });
  }
  clearSetupCode();
  clearLoginFailures(key);
  void notifier
    .notify({
      key: `security:setup:${Date.now()}`,
      severity: 'warning',
      title: 'Login password set on the setup screen',
      context: { ip: req.ip ?? 'unknown' },
    })
    .catch(() => undefined);
  return signIn(req, res);
});

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearedSessionCookie(isHttps(req)));
  res.json({ authenticated: false });
});

router.get('/session', (req, res) => {
  const configured = isAuthConfigured();
  res.json({
    // With no auth configured, development lets every caller through;
    // production lets no one through until the first-run setup is done.
    authenticated: configured
      ? isAuthenticated(req.headers, null)
      : process.env.NODE_ENV !== 'production',
    login_configured: isLoginConfigured(),
    setup_required: !isLoginConfigured() && credentials.isLoaded(),
  });
});

export default router;
