/**
 * Browser login for the single app user. See `services/session.ts`.
 *
 *   POST /api/auth/login    { password } → sets the HttpOnly session cookie
 *   POST /api/auth/logout   → clears it
 *   GET  /api/auth/session  → { authenticated, login_configured }
 */
import express, { type Request } from 'express';

import { isAuthConfigured, isAuthenticated } from '../middleware/auth.js';
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
  return first === 'https' || process.env.COOKIE_SECURE === 'true';
}

function clientKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

router.post('/login', (req, res) => {
  if (!isLoginConfigured()) {
    return res.status(503).json({
      error: 'Login is not configured',
      message: 'Set APP_PASSWORD and SESSION_SECRET in .env.',
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
  const session = issueSession();
  res.setHeader(
    'Set-Cookie',
    sessionCookie(session.value, session.expiresAt - Date.now(), isHttps(req))
  );
  return res.json({ authenticated: true, expires_at: new Date(session.expiresAt).toISOString() });
});

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearedSessionCookie(isHttps(req)));
  res.json({ authenticated: false });
});

router.get('/session', (req, res) => {
  const configured = isAuthConfigured();
  res.json({
    // With no auth configured (development) every caller is let through.
    authenticated: configured ? isAuthenticated(req.headers, null) : true,
    login_configured: isLoginConfigured(),
  });
});

export default router;
