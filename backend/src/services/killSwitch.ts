/**
 * Kill switch (Component E — §6).
 *
 * **This is a detection mechanism, not a prevention one, and the design says so
 * openly.** Everything evaluates at bar close (E4), so it cannot stop price
 * gapping through a stop — by the time it looks, the fill has already
 * happened. What it can do is notice that something went wrong and stop the
 * next thing going wrong too.
 *
 * Being honest about that shapes the triggers: each one is a *detectable
 * aftermath*, not an attempt to intervene mid-bar.
 *
 *   - a position closed materially worse than its stop implied (the gap)
 *   - a position open **without** the stop its run expects
 *   - the venue's position disagrees with the app's own fills
 *   - account equity below a floor
 *
 * Actions escalate: **notify** (E-5), then **halt**, then **flatten** (E-6).
 * Starting at notify-only is not timidity — it lets the whole thing run in
 * production against real conditions with zero blast radius, so its trigger
 * accuracy can be judged from the alerts it *would* have acted on. That
 * directly answers the "hard to UAT" problem: an automated action you cannot
 * safely rehearse is one you cannot trust.
 */

import type { Alert } from './notifier.js';
import { connectionLabel, type Connection } from './orderTypes.js';

export type KillSwitchAction = 'notify' | 'halt' | 'flatten';

export type KillSwitchTriggerKind =
  'stop_gap' | 'unprotected_position' | 'position_divergence' | 'equity_floor';

export interface KillSwitchTrigger {
  kind: KillSwitchTriggerKind;
  severity: 'warning' | 'critical';
  title: string;
  detail: string;
  context: Record<string, unknown>;
}

export interface KillSwitchConfig {
  /** How far past the in-force stop a fill must land to count as a gap,
   *  expressed as a fraction of the stop distance. 0 disables the check. */
  stopGapTolerancePct: number;
  /** Absolute equity floor per connection. 0 disables. */
  equityFloor: number;
  /** What a trigger does. Notify-only until deliberately escalated. */
  action: KillSwitchAction;
}

export function killSwitchConfig(): KillSwitchConfig {
  const action = (process.env.KILL_SWITCH_ACTION || 'notify').trim().toLowerCase();
  return {
    stopGapTolerancePct: Math.max(
      0,
      Number(process.env.KILL_SWITCH_STOP_GAP_TOLERANCE_PCT ?? '25') || 0
    ),
    equityFloor: Math.max(0, Number(process.env.KILL_SWITCH_EQUITY_FLOOR ?? '0') || 0),
    action:
      action === 'halt' || action === 'flatten'
        ? (action as KillSwitchAction)
        : ('notify' as const),
  };
}

export interface KillSwitchInput {
  runId: number;
  connection: Connection;
  symbol: string;
  /** Signed position the venue reports. */
  positionSize: number;
  /** The stop currently attached at the venue, if any. */
  venueStop: number | null;
  /** The stop the app last set for this run's position, from `current_stop`. */
  recordedStop: number | null;
  /** Whether the strategy declares a stop rule at all. */
  hasStopRule: boolean;
  /** The app's fills-derived position, for the divergence check. */
  derivedSize: number | null;
  /** Price of the most recent fill on this symbol, when the position just
   *  closed — what a gap is measured against. */
  lastFillPrice: number | null;
  /** Connection equity, when known. */
  equity: number | null;
}

const DIVERGENCE_TOLERANCE = 0.0001;

/**
 * Evaluate every trigger for one run at one bar close.
 *
 * Pure, and returns *all* firing triggers rather than the first: an operator
 * woken at 3am needs the whole picture, and "position unprotected" alongside
 * "venue disagrees with our fills" is a different diagnosis from either alone.
 */
export function evaluateKillSwitch(
  input: KillSwitchInput,
  config: KillSwitchConfig
): KillSwitchTrigger[] {
  const triggers: KillSwitchTrigger[] = [];
  const label = connectionLabel(input.connection.broker, input.connection.brokerAccount);
  const base = { connection: label, symbol: input.symbol, run_id: input.runId };

  // 1. The gap. A closed position (flat now) that had a stop in force, whose
  //    exit filled materially past that stop, is the market having jumped it —
  //    the case this whole mechanism exists for.
  if (
    config.stopGapTolerancePct > 0 &&
    input.positionSize === 0 &&
    input.recordedStop != null &&
    input.lastFillPrice != null
  ) {
    const overshoot = Math.abs(input.lastFillPrice - input.recordedStop);
    const tolerance = input.recordedStop * (config.stopGapTolerancePct / 100);
    if (tolerance > 0 && overshoot > tolerance) {
      triggers.push({
        kind: 'stop_gap',
        severity: 'critical',
        title: 'Position closed well past its stop',
        detail:
          `Exit filled at ${input.lastFillPrice} against a stop of ${input.recordedStop} — ` +
          `${overshoot.toPrecision(4)} beyond it. The market likely gapped through.`,
        context: { ...base, stop: input.recordedStop, fill: input.lastFillPrice },
      });
    }
  }

  // 2. An open position with no protection. Either the venue never recorded
  //    the stop, or something removed it; both are the state E-2 refuses to
  //    let an entry create, so finding one means it arrived another way.
  if (input.positionSize !== 0 && input.hasStopRule && input.venueStop == null) {
    triggers.push({
      kind: 'unprotected_position',
      severity: 'critical',
      title: 'Open position has no stop at the venue',
      detail:
        `${input.symbol} is ${input.positionSize} with no protective stop, though the ` +
        'strategy declares one.',
      context: { ...base, position: input.positionSize },
    });
  }

  // 3. Venue and fills disagree. Benign once (a broker-side stop closed the
  //    position, or a manual trade), but a persistent mismatch means fills are
  //    being missed — which silently corrupts realised P&L and the loss caps
  //    measured from it.
  if (
    input.derivedSize != null &&
    Math.abs(input.derivedSize - input.positionSize) > DIVERGENCE_TOLERANCE
  ) {
    triggers.push({
      kind: 'position_divergence',
      severity: 'warning',
      title: 'Venue position disagrees with recorded fills',
      detail:
        `Venue reports ${input.positionSize}, our fills imply ${input.derivedSize}. ` +
        'Expected after a broker-side exit or a manual trade; persistent divergence means ' +
        'fills are being missed.',
      context: { ...base, venue: input.positionSize, derived: input.derivedSize },
    });
  }

  // 4. Equity floor.
  if (config.equityFloor > 0 && input.equity != null && input.equity < config.equityFloor) {
    triggers.push({
      kind: 'equity_floor',
      severity: 'critical',
      title: 'Account equity below its floor',
      detail: `${label} equity is ${input.equity}, below the configured floor of ${config.equityFloor}.`,
      context: { ...base, equity: input.equity, floor: config.equityFloor },
    });
  }

  return triggers;
}

/**
 * The alert for a trigger.
 *
 * The dedupe key deliberately excludes anything that changes every bar — a
 * price, a position size — so an ongoing condition is one alert rather than
 * one per bar. It includes the connection and symbol, so the same condition on
 * two accounts is two alerts, which is the distinction an operator acts on.
 */
export function triggerAlert(trigger: KillSwitchTrigger, action: KillSwitchAction): Alert {
  const connection = String(trigger.context.connection ?? 'unknown');
  const symbol = String(trigger.context.symbol ?? '');
  return {
    key: `killswitch:${trigger.kind}:${connection}:${symbol}`,
    severity: trigger.severity,
    title: trigger.title,
    detail:
      action === 'notify'
        ? `${trigger.detail}\n(notify-only — no automated action taken)`
        : trigger.detail,
    context: trigger.context,
  };
}
