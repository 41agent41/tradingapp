/**
 * Bar-close stop management (Component E — E-3).
 *
 * Once a stop lives at the broker, keeping it current is a small, strictly
 * bounded job: on each closed bar, for each open position, compute the stop the
 * rules now want and move it **only if it is more protective** than the one the
 * venue already holds.
 *
 * That last clause is the whole design. A ratcheting trail normally needs
 * carried state — a high-water mark that must survive restarts, be rebuilt on
 * recovery, and never drift from reality. With the stop at the broker there is
 * nothing to carry: the venue's current stop *is* the high-water mark, and
 * "never move it backwards" is a comparison against it. The most reliable
 * holder of that fact is the system that will act on it.
 *
 * Cadence follows E4/E5: decisions happen at bar close, and the floor timeframe
 * is 5 minutes, so this issues at most one modify per position per bar. That
 * keeps it well inside broker modify-rate limits without any throttling of its
 * own.
 */

import { logger } from './logger.js';
import { connectionLabel, type Connection } from './orderTypes.js';

/** A position as the venue reports it, with whatever protection it carries. */
export interface OpenPosition {
  symbol: string;
  /** Signed: negative is short. */
  size: number;
  avgPrice: number;
  /** The stop currently attached at the venue, or null when it has none. */
  stopLoss: number | null;
}

export interface TrailDecision {
  /** Whether a modify should be sent. */
  move: boolean;
  /** The stop to move to, when `move` is true. */
  stopPrice?: number;
  reason: string;
}

/**
 * Should the venue's stop move to `desired`?
 *
 * Pure, so the ratchet is testable without a venue. Returns a reason in every
 * branch — a trail that quietly does nothing is indistinguishable from one that
 * is broken, and this runs on every bar of every open position.
 */
export function decideTrail(
  desired: number | null,
  current: number | null,
  size: number,
  minDistance = 0,
  referencePrice?: number
): TrailDecision {
  if (size === 0) return { move: false, reason: 'no open position' };
  if (desired == null || !Number.isFinite(desired) || desired <= 0) {
    return { move: false, reason: 'no stop resolved for this bar' };
  }

  const long = size > 0;

  // A trail must never cross the market. `bar_extreme` on a sharp reversal can
  // resolve past price, and sending that stop would close the position at
  // market under the guise of protecting it.
  if (referencePrice != null && Number.isFinite(referencePrice)) {
    if (long && desired >= referencePrice) {
      return { move: false, reason: `trail ${desired} is at or above price ${referencePrice}` };
    }
    if (!long && desired <= referencePrice) {
      return { move: false, reason: `trail ${desired} is at or below price ${referencePrice}` };
    }
    if (minDistance > 0 && Math.abs(referencePrice - desired) < minDistance) {
      // The venue would reject it, and a rejected modify leaves the old stop
      // in place — so skipping is the same outcome with less noise.
      return {
        move: false,
        reason: `trail ${desired} is inside the venue's minimum distance (${minDistance})`,
      };
    }
  }

  if (current == null) {
    return { move: true, stopPrice: desired, reason: 'position has no stop at the venue' };
  }

  // The ratchet. The broker holds the high-water mark; this is the comparison
  // against it.
  const tighter = long ? desired > current : desired < current;
  if (!tighter) {
    return { move: false, reason: `trail ${desired} is not tighter than ${current}` };
  }
  return { move: true, stopPrice: desired, reason: `tightening ${current} → ${desired}` };
}

export interface StopManagerDeps {
  /** Move an open position's stop at the venue. */
  modifyStop(connection: Connection, symbol: string, stopPrice: number): Promise<void>;
}

export interface TrailRequest {
  connection: Connection;
  position: OpenPosition;
  /** The stop the rules want for this bar, from the rule engine's trail. */
  desiredStop: number | null;
  /** The bar's close, for the cross-the-market and min-distance checks. */
  referencePrice: number;
  minDistance?: number;
}

/**
 * Apply one bar's trail decision, returning what happened.
 *
 * Never throws: a venue that refuses a modify leaves the previous stop in
 * place, which is a degraded but *protected* state. Failing the whole
 * evaluation over it would be worse — it would stop the strategy managing
 * positions it can still manage.
 */
export async function applyTrail(
  deps: StopManagerDeps,
  request: TrailRequest
): Promise<{ moved: boolean; reason: string; error?: string }> {
  const { connection, position, desiredStop, referencePrice } = request;
  const decision = decideTrail(
    desiredStop,
    position.stopLoss,
    position.size,
    request.minDistance ?? 0,
    referencePrice
  );
  if (!decision.move || decision.stopPrice == null) {
    return { moved: false, reason: decision.reason };
  }

  try {
    await deps.modifyStop(connection, position.symbol, decision.stopPrice);
    logger.info(
      {
        connection: connectionLabel(connection.broker, connection.brokerAccount),
        symbol: position.symbol,
        from: position.stopLoss,
        to: decision.stopPrice,
      },
      'trailing stop moved'
    );
    return { moved: true, reason: decision.reason };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      {
        connection: connectionLabel(connection.broker, connection.brokerAccount),
        symbol: position.symbol,
        desired: decision.stopPrice,
        err: message,
      },
      'trailing stop modify failed — the previous stop remains in place'
    );
    return { moved: false, reason: decision.reason, error: message };
  }
}
