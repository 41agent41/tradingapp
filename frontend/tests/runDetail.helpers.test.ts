/**
 * Tests for the pure RunDetail helpers (A5 / Phase 4): merging REST + live
 * signals and projecting them to chart markers.
 */
import { describe, expect, it } from 'vitest';
import { mergeSignals, signalsToMarkers } from '../app/components/systematic/RunDetail';
import type { StrategySignalEvent } from '../app/lib/useStrategySignals';

const rest = [
  {
    id: 1,
    run_id: 7,
    bar_time: '2026-01-10T14:00:00Z',
    signal: 'buy',
    reason: 'entry',
    entry: true,
    exit: false,
    in_session: true,
    position_size: 0,
    acted: true,
    order_audit_id: 900,
  },
];

const liveEvent: StrategySignalEvent = {
  run_id: 7,
  symbol: 'MSFT',
  timeframe: '5min',
  bar_time: '2026-01-10T14:05:00Z',
  signal: 'sell',
  reason: 'exit',
  entry: false,
  exit: true,
  in_session: true,
  position_size: 100,
  acted: false,
  order_audit_id: null,
};

describe('mergeSignals', () => {
  it('merges live events not already present, newest first', () => {
    const out = mergeSignals(rest as any, [liveEvent]);
    expect(out).toHaveLength(2);
    expect(out[0].bar_time).toBe('2026-01-10T14:05:00Z'); // newest first
    expect(out[1].bar_time).toBe('2026-01-10T14:00:00Z');
  });

  it('prefers the REST row on a bar_time collision (authoritative acted state)', () => {
    const collide: StrategySignalEvent = {
      ...liveEvent,
      bar_time: '2026-01-10T14:00:00Z',
      acted: false,
    };
    const out = mergeSignals(rest as any, [collide]);
    expect(out).toHaveLength(1);
    expect(out[0].acted).toBe(true); // kept the REST row
    expect(out[0].order_audit_id).toBe(900);
  });
});

describe('signalsToMarkers', () => {
  it('maps buy below-bar up-arrow and sell above-bar down-arrow', () => {
    const markers = signalsToMarkers(mergeSignals(rest as any, [liveEvent]));
    const buy = markers.find((m) => m.text?.toLowerCase() === 'buy');
    const sell = markers.find((m) => m.text?.toLowerCase() === 'sell');
    expect(buy).toMatchObject({ position: 'belowBar', shape: 'arrowUp' });
    expect(sell).toMatchObject({ position: 'aboveBar', shape: 'arrowDown' });
  });

  it('uses a bolder colour + upper-case label for acted orders', () => {
    const markers = signalsToMarkers(rest as any);
    expect(markers[0]).toMatchObject({ color: '#16a34a', text: 'BUY' });
  });

  it('skips none signals and bad times', () => {
    const rows = [
      { ...rest[0], signal: 'none' },
      { ...rest[0], bar_time: 'not-a-date' },
    ];
    expect(signalsToMarkers(rows as any)).toHaveLength(0);
  });
});
