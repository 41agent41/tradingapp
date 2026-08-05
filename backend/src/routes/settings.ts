import { Router, Request, Response } from 'express';

const router = Router();

// Explicit allow-list of environment-variable names that may be returned
// to the client. Anything outside this list — and in particular anything
// matching the deny patterns below — is never echoed back.
//
// If you need to expose a new value to the frontend, add it here AND make
// sure it does not contain any credential / token material.
const ALLOWED_KEYS = new Set<string>([
  // High-level deployment context
  'NODE_ENV',
  'ENVIRONMENT',
  'SERVER_IP',
  'TZ',

  // Public service endpoints (these are visible to the browser anyway)
  'FRONTEND_PORT',
  'BACKEND_PORT',
  'BROKER_SERVICE_PORT',
  'NEXT_PUBLIC_API_URL',
  'CORS_ORIGINS',

  // Non-credential IB Gateway configuration. Note: `IB_HOST` is the
  // gateway hostname which is operationally useful but is *not* a secret.
  'IB_HOST',
  'IB_PORT',
  'IB_CLIENT_ID',
  'IB_TIMEOUT',
  'IB_TIMEZONE',
  'DATA_TIMEZONE',
  'EXPECTED_TIMESTAMP_FORMAT',

  // Postgres connection metadata (host / port / db / user). The password
  // is deliberately excluded via the deny patterns below.
  'POSTGRES_HOST',
  'POSTGRES_PORT',
  'POSTGRES_USER',
  'POSTGRES_DB',
  'POSTGRES_SSL',

  // Redis connection metadata (no password)
  'REDIS_HOST',
  'REDIS_PORT',
]);

// Belt-and-braces deny patterns. Even if a future contributor mistakenly
// adds something like `POSTGRES_PASSWORD` to `ALLOWED_KEYS`, these
// patterns will still strip it.
const DENY_PATTERNS: RegExp[] = [
  /SECRET/i,
  /PASSWORD/i,
  /PASSWD/i,
  /TOKEN/i,
  /API[_-]?KEY/i,
  /PRIVATE[_-]?KEY/i,
  /CREDENTIAL/i,
  /SESSION/i,
  /JWT/i,
];

function isDenied(key: string): boolean {
  return DENY_PATTERNS.some((p) => p.test(key));
}

/**
 * GET /api/settings
 *
 * Returns the subset of `process.env` that is on the allow-list and is
 * not blocked by the deny patterns. The endpoint deliberately does NOT
 * read the `.env` file from disk — `process.env` already contains every
 * key Docker Compose injected into the container and that is the source
 * of truth at runtime.
 *
 * The legacy implementation read /app/.env and returned the parsed
 * contents wholesale, which leaked `JWT_SECRET`, `SESSION_SECRET`,
 * `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, etc. See GAP_ANALYSIS.md §3.6.
 */
router.get('/', (_req: Request, res: Response) => {
  try {
    const safe: Record<string, string> = {};

    for (const key of ALLOWED_KEYS) {
      const value = process.env[key];
      if (value === undefined || value === '') continue;
      if (isDenied(key)) continue; // defence-in-depth
      safe[key] = value;
    }

    res.json({
      settings: safe,
      // Make the contract explicit so frontends know they cannot rely on
      // additional keys being returned.
      meta: {
        allowed_keys: Array.from(ALLOWED_KEYS).sort(),
        note: 'Only allow-listed, non-credential environment variables are returned.',
      },
    });
  } catch (error) {
    console.error('Error reading settings:', error);
    res.status(500).json({ error: 'Failed to read settings' });
  }
});

export default router;
