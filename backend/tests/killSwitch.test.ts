/**
 * Tests for the kill switch (Component E — E-5).
 *
 * The mechanism is honest about being *detection*, not prevention: with
 * decisions at bar close it cannot stop a gap, only notice one. So the cases
 * below are about noticing correctly — and, just as importantly, about not
 * crying wolf, because an alert channel that fires on every bar gets muted and
 * a muted channel looks like coverage.
 */
import { evaluateKillSwitch, triggerAlert } from '../src/services/killSwitch.js';

const connection = { broker: 'mt5', brokerAccount: 'icmarkets' };
const config = { stopGapTolerancePct: 25, equityFloor: 5000, action: 'notify' as const };

function input(overrides = {}) {
  return {
    runId: 1,
    connection,
    symbol: 'EURUSD.a',
    positionSize: 0,
    venueStop: null,
    recordedStop: null,
    hasStopRule: false,
    derivedSize: null,
    lastFillPrice: null,
    equity: null,
    ...overrides,
  };
}

describe('kill switch — the gap', () => {
  it('fires when an exit filled well past the stop that was in force', async () => {
    // The case the whole mechanism exists for: price jumped the stop.
    const triggers = evaluateKillSwitch(
      input({ positionSize: 0, recordedStop: 100, lastFillPrice: 60 }),
      config
    );
    expect(triggers.map((t) => t.kind)).toContain('stop_gap');
    expect(triggers[0].severity).toBe('critical');
  });

  it('does not fire on a normal fill at the stop', async () => {
    const triggers = evaluateKillSwitch(
      input({ positionSize: 0, recordedStop: 100, lastFillPrice: 99.9 }),
      config
    );
    expect(triggers.map((t) => t.kind)).not.toContain('stop_gap');
  });

  it('does not fire while the position is still open', async () => {
    // A stop only gaps on the way out.
    const triggers = evaluateKillSwitch(
      input({ positionSize: 1, recordedStop: 100, lastFillPrice: 60, venueStop: 100 }),
      config
    );
    expect(triggers.map((t) => t.kind)).not.toContain('stop_gap');
  });

  it('is disabled by a zero tolerance', async () => {
    const triggers = evaluateKillSwitch(input({ recordedStop: 100, lastFillPrice: 10 }), {
      ...config,
      stopGapTolerancePct: 0,
    });
    expect(triggers).toHaveLength(0);
  });
});

describe('kill switch — unprotected position', () => {
  it('fires on an open position with no venue stop', async () => {
    // E-2 refuses to *create* this state, so finding one means it arrived
    // another way — which is exactly worth waking someone for.
    const triggers = evaluateKillSwitch(
      input({ positionSize: 2, hasStopRule: true, venueStop: null }),
      config
    );
    expect(triggers.map((t) => t.kind)).toContain('unprotected_position');
  });

  it('does not fire when the venue holds a stop', async () => {
    const triggers = evaluateKillSwitch(
      input({ positionSize: 2, hasStopRule: true, venueStop: 1.09 }),
      config
    );
    expect(triggers).toHaveLength(0);
  });

  it('does not fire for a strategy that declares no stop', async () => {
    const triggers = evaluateKillSwitch(
      input({ positionSize: 2, hasStopRule: false, venueStop: null }),
      config
    );
    expect(triggers).toHaveLength(0);
  });
});

describe('kill switch — divergence and equity', () => {
  it('flags a venue/fills mismatch as a warning, not a critical', async () => {
    // Benign once — a broker-side exit or a manual trade — so it must not
    // carry the same weight as an unprotected position.
    const triggers = evaluateKillSwitch(input({ positionSize: 1, derivedSize: 0 }), config);
    const divergence = triggers.find((t) => t.kind === 'position_divergence');
    expect(divergence?.severity).toBe('warning');
  });

  it('tolerates fractional-lot rounding', async () => {
    const triggers = evaluateKillSwitch(
      input({ positionSize: 0.01, derivedSize: 0.010000001 }),
      config
    );
    expect(triggers).toHaveLength(0);
  });

  it('fires when equity drops below the floor', async () => {
    const triggers = evaluateKillSwitch(input({ equity: 4000 }), config);
    expect(triggers.map((t) => t.kind)).toContain('equity_floor');
  });

  it('is disabled by a zero floor', async () => {
    const triggers = evaluateKillSwitch(input({ equity: 1 }), { ...config, equityFloor: 0 });
    expect(triggers).toHaveLength(0);
  });
});

describe('kill switch — reporting', () => {
  it('returns every firing trigger, not just the first', async () => {
    // An operator woken at 3am needs the whole picture: "unprotected" plus
    // "venue disagrees" is a different diagnosis from either alone.
    const triggers = evaluateKillSwitch(
      input({ positionSize: 2, hasStopRule: true, venueStop: null, derivedSize: 0, equity: 100 }),
      config
    );
    expect(triggers.map((t) => t.kind).sort()).toEqual([
      'equity_floor',
      'position_divergence',
      'unprotected_position',
    ]);
  });

  it('keys alerts on the ongoing condition, not on values that change each bar', async () => {
    // Otherwise every bar is a new key and dedup never engages.
    const a = triggerAlert(
      evaluateKillSwitch(input({ positionSize: 2, hasStopRule: true }), config)[0],
      'notify'
    );
    const b = triggerAlert(
      evaluateKillSwitch(input({ positionSize: 7, hasStopRule: true }), config)[0],
      'notify'
    );
    expect(a.key).toBe(b.key);
  });

  it('distinguishes the same condition on two connections', async () => {
    const a = triggerAlert(
      evaluateKillSwitch(input({ positionSize: 2, hasStopRule: true }), config)[0],
      'notify'
    );
    const b = triggerAlert(
      evaluateKillSwitch(
        input({
          positionSize: 2,
          hasStopRule: true,
          connection: { broker: 'mt5', brokerAccount: 'pepperstone' },
        }),
        config
      )[0],
      'notify'
    );
    expect(a.key).not.toBe(b.key);
  });

  it('says plainly when it is notify-only', async () => {
    const alert = triggerAlert(
      evaluateKillSwitch(input({ positionSize: 2, hasStopRule: true }), config)[0],
      'notify'
    );
    expect(alert.detail).toMatch(/no automated action taken/);
  });
});
