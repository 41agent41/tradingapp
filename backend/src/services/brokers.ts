/**
 * Execution **platforms** (Systematic Trading roadmap — B1). Instruments are
 * platform-scoped (no cross-platform symbol reconciliation), so `broker` is a
 * first-class dimension on every order. Each is accepted here but only served
 * once it is configured on the broker service (see
 * `broker_service/adapters.py`) — otherwise a request for it resolves to a
 * clean 501, not a 400.
 *
 * Its own module, with no imports, so the settings registry can list the
 * brokers without importing `orderTypes.ts` (which reads the settings).
 */
export const BROKERS = ['ib', 'mt5', 'alpaca', 'oanda'] as const;
export type Broker = (typeof BROKERS)[number];
