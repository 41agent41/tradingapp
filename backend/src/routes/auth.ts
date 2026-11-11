/**
 * Browser login for the single app user. See `services/session.ts`.
 *
 *   POST /api/auth/login    { password } → sets the HttpOnly session cookie
 *   POST /api/auth/logout   → ends this browser's session and clears it
 *   GET  /api/auth/session  → { authenticated, login_configured, setup_required }
 *   GET  /api/auth/sessions → the sessions in force
 *   DELETE /api/auth/sessions/:id → ends one of them
 *   POST /api/auth/logout-all → ends every session ("sign out everywhere")
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
  readCookie,
  recordLoginFailure,
  SESSION_COOKIE,
  sessionCookie,
  sessionId,
} from '../services/session.js';
import { sessionStore } from '../services/sessionStore.js';

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
  const agent = req.headers['user-agent'];
  const session = issueSession(Date.now(), {
    ip: clientKey(req),
    userAgent: typeof agent === 'string' ? agent : null,
  });
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

/** The session the request's cookie names, when the backend signed it. */
function currentSessionId(req: Request): string | null {
  return sessionId(readCookie(req.headers['cookie'], SESSION_COOKIE));
}

// Open to a caller that is not signed in, so a stale cookie can always be
// cleared. It ends only the session its own cookie names.
router.post('/logout', (req, res) => {
  const id = currentSessionId(req);
  if (id) sessionStore.revoke(id);
  res.setHeader('Set-Cookie', clearedSessionCookie(isHttps(req)));
  res.json({ authenticated: false });
});

// The routes below are not in OPEN_PATHS: the auth middleware has already
// checked the caller is signed in (or sent an API token).
router.get('/sessions', (req, res) => {
  res.json({ sessions: sessionStore.list(currentSessionId(req)) });
});

router.delete('/sessions/:id', (req, res) => {
  if (!sessionStore.revokeByPublicId(String(req.params.id))) {
    return res.status(404).json({ error: 'Not found', message: 'No such session.' });
  }
  logger.info({ session: req.params.id, ip: req.ip }, 'auth: session ended');
  return res.json({ ended: true });
});

router.post('/logout-all', (req, res) => {
  const ended = sessionStore.revokeAll();
  logger.info({ ended, ip: req.ip }, 'auth: every session ended');
  void notifier
    .notify({
      key: `security:logout-all:${Date.now()}`,
      severity: 'warning',
      title: 'Every browser was signed out',
      context: { sessions: ended, ip: req.ip ?? 'unknown' },
    })
    .catch(() => undefined);
  res.setHeader('Set-Cookie', clearedSessionCookie(isHttps(req)));
  res.json({ authenticated: false, ended });
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
