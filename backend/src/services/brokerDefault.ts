/**
 * Keeps the backend's default broker in step with the broker service.
 *
 * Which broker a request with no `broker` goes to depends on which brokers
 * are configured, and only the broker service knows that. Its `/health`
 * reports the choice (`providers.default`: `DEFAULT_BROKER`, else the
 * highest-priority configured broker), so the backend reads it at startup and
 * then on a timer, and `defaultBroker()` in `orderTypes.ts` answers from it.
 * A failed read keeps the last good value.
 */

import axios from 'axios';
import { logger } from './logger.js';
import { defaultBroker, setResolvedDefaultBroker } from './orderTypes.js';

const REFRESH_SECONDS = 60;

/** Read the broker service's default once. Never throws. */
export async function refreshDefaultBroker(
  brokerServiceUrl: string,
  get: (url: string) => Promise<{ data: any }> = (url) => axios.get(url, { timeout: 5000 })
): Promise<void> {
  try {
    const res = await get(`${brokerServiceUrl}/health`);
    const before = defaultBroker();
    setResolvedDefaultBroker(res.data?.providers?.default);
    const after = defaultBroker();
    if (after !== before) logger.info({ default_broker: after }, 'default broker updated');
  } catch (err) {
    logger.warn({ err: String((err as Error)?.message ?? err) }, 'default broker refresh failed');
  }
}

/** Refresh now and every minute. Returns a stop function. */
export function startDefaultBrokerRefresh(brokerServiceUrl: string): () => void {
  void refreshDefaultBroker(brokerServiceUrl);
  const timer = setInterval(
    () => void refreshDefaultBroker(brokerServiceUrl),
    REFRESH_SECONDS * 1000
  );
  timer.unref?.();
  return () => clearInterval(timer);
}
