/**
 * Request body size limits (S-11) and the metrics scrape token (S-09).
 */
import crypto from 'crypto';
import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export const DEFAULT_BODY_LIMIT = '100kb';
export const LARGE_BODY_LIMIT = '25mb';
/**
 * The only routes that take a large JSON body: the Parquet export posts the
 * whole dataframe back from the browser (capped at 200k rows in
 * routes/export.ts), and the upload stores the bars of a download.
 */
export const LARGE_BODY_PATHS = ['/api/export', '/api/market-data/upload'] as const;

export function takesLargeBody(path: string): boolean {
  return LARGE_BODY_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

/** JSON body parsing: 100 KB everywhere, 25 MB on the two routes above. */
export function jsonBody(): RequestHandler {
  const small = express.json({ limit: DEFAULT_BODY_LIMIT });
  const large = express.json({ limit: LARGE_BODY_LIMIT });
  return (req, res, next) => (takesLargeBody(req.path) ? large : small)(req, res, next);
}

/** Answers a body over the limit, or one that is not JSON, in the API's own
 *  shape instead of Express's HTML page. Other errors pass through. */
export function bodyErrors() {
  return (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    const type = (err as { type?: string } | null)?.type;
    if (type === 'entity.too.large') {
      res.status(413).json({
        error: 'Request body too large',
        message: `This route takes at most ${DEFAULT_BODY_LIMIT} of JSON.`,
      });
      return;
    }
    if (type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Request body is not valid JSON' });
      return;
    }
    next(err);
  };
}

function same(a: string, b: string): boolean {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Guards `/metrics`. With `METRICS_TOKEN` set, the scrape must send it as
 * `Authorization: Bearer <token>`; with it unset the endpoint stays open, as
 * it was, so an existing Prometheus keeps working until a token is chosen.
 */
export function metricsGuard(token: () => string | undefined = () => process.env.METRICS_TOKEN) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const wanted = (token() ?? '').trim();
    if (!wanted) return next();
    const header = req.headers.authorization ?? '';
    const sent = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (sent && same(sent, wanted)) return next();
    res.setHeader('WWW-Authenticate', 'Bearer');
    res.status(401).type('text/plain').send('metrics need the scrape token\n');
  };
}
