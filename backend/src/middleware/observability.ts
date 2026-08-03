/**
 * Edge observability middleware (GAP_ANALYSIS §6).
 *
 * Combines three concerns into one middleware so the order is correct:
 *
 *   1. Accept `X-Request-Id` from the caller if present; otherwise mint a
 *      fresh UUID.
 *   2. Echo it back on the response (so callers can correlate logs).
 *   3. Push it into AsyncLocalStorage for the duration of the request, so
 *      downstream code (DB layer, axios calls to ib_service, logger) can
 *      read it without it being threaded through every signature.
 *   4. Time the request and observe into the prom-client histogram.
 *   5. Log one structured line per request when the response finishes.
 */
import type { NextFunction, Request, Response } from 'express';
import { httpRequestDuration } from '../services/metrics.js';
import { logger, newRequestId, requestContext } from '../services/logger.js';

const HEADER = 'x-request-id';

export function observabilityMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const headerVal = req.header(HEADER);
    const requestId =
      typeof headerVal === 'string' && headerVal.trim().length > 0 && headerVal.length <= 128
        ? headerVal.trim()
        : newRequestId();

    res.setHeader('X-Request-Id', requestId);

    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
      // Use the matched route pattern when express has resolved it; otherwise
      // bucket by path so high-cardinality URLs (ids) don't explode the
      // metric label set.
      const route = (req.route?.path as string) || req.baseUrl || 'unknown';
      httpRequestDuration.labels(req.method, route, String(res.statusCode)).observe(durationSec);

      logger.info(
        {
          req: {
            id: requestId,
            method: req.method,
            url: req.originalUrl,
            route,
          },
          res: { statusCode: res.statusCode },
          duration_ms: Math.round(durationSec * 1000),
        },
        'request completed'
      );
    });

    requestContext.run({ requestId }, () => next());
  };
}
