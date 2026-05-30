/**
 * Structured logging + per-request context (GAP_ANALYSIS §6).
 *
 * - `logger` is a pino root logger; modules call `logger.info({...}, '...')`
 *   instead of `console.log(...)`.
 * - `requestContext` is an AsyncLocalStorage holding the per-request id, so
 *   any downstream code (DB calls, axios calls to the IB service) can read
 *   the current request id without it being threaded through every signature.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import pino, { type Logger } from 'pino';

const LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

export const logger: Logger = pino({
  level: LEVEL,
  base: { service: 'backend' },
  redact: {
    paths: ['req.headers.authorization', 'req.headers["x-api-token"]', 'password', '*.password'],
    censor: '[redacted]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export interface RequestContext {
  requestId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

export function newRequestId(): string {
  return randomUUID();
}
