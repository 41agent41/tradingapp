import { describe, expect, it } from 'vitest';

import {
  columnsToBars,
  frameAt,
  nextBarCursor,
  prepareReplay,
  previousBarCursor,
  replayRequest,
  signalsRequest,
  tradeMarkers,
  type ReplayResponse,
  type ReplayTrade,
} from '../app/lib/replay';

const T0 = Date.UTC(2026, 0, 5, 8, 0) / 1000; // a Monday, 08:00 UTC

/** Minute i opens at 100 + i, closes half a point higher, range one point. */
function minutes(count: number, from = T0) {
  return Array.from({ length: count }, (_, i) => ({
    time: from + i * 60,
    open: 100 + i,
    high: 100.75 + i,
    low: 99.75 + i,
    close: 100.5 + i,
    volume: 2,
  }));
}

describe('prepareReplay', () => {
  it('groups minutes into bars on UTC boundaries, whatever is missing', () => {
    // 12 minutes with minute 7 missing, as 5-minute bars.
    const m = minutes(12).filter((_, i) => i !== 7);
    const p = prepareReplay(m, 300);
    expect(p.bars.map((b) => b.time)).toEqual([T0, T0 + 300, T0 + 600]);
    expect(p.starts).toEqual([0, 5, 9, 11]);
    expect(p.bars[0]).toMatchObject({ open: 100, high: 104.75, low: 99.75, close: 104.5 });
    expect(p.bars[0].volume).toBe(10);
    expect(p.bars[1]).toMatchObject({ open: 105, close: 109.5, volume: 8 });
  });
});

describe('frameAt', () => {
  const p = prepareReplay(minutes(12), 300);

  it('shows nothing before the first minute', () => {
    expect(frameAt(p, 0)).toEqual({ done: 0, forming: null, clock: null });
  });

  it('forms the candle from only the minutes played so far', () => {
    const one = frameAt(p, 1);
    expect(one.done).toBe(0);
    expect(one.forming).toMatchObject({ time: T0, open: 100, high: 100.75, close: 100.5 });
    expect(one.clock).toBe(T0 + 60);

    // Seven minutes in: one bar is done, the second has two minutes.
    const seven = frameAt(p, 7);
    expect(seven.done).toBe(1);
    expect(seven.forming).toMatchObject({
      time: T0 + 300,
      open: 105,
      high: 106.75,
      low: 104.75,
      close: 106.5,
      volume: 4,
    });
    // It never knows the rest of its bar.
    expect(seven.forming!.high).toBeLessThan(p.bars[1].high);
  });

  it('holds a finished bar as the forming one until the next minute plays', () => {
    const five = frameAt(p, 5);
    expect(five.done).toBe(0);
    expect(five.forming).toEqual(p.bars[0]);
  });

  it('stops at the end', () => {
    expect(frameAt(p, 99)).toEqual(frameAt(p, 12));
    expect(frameAt(p, 12).done).toBe(2);
  });
});

describe('stepping by a bar', () => {
  const p = prepareReplay(minutes(12), 300);

  it('goes forward to the end of the bar being played', () => {
    expect(nextBarCursor(p, 0)).toBe(5);
    expect(nextBarCursor(p, 3)).toBe(5);
    expect(nextBarCursor(p, 5)).toBe(10);
    expect(nextBarCursor(p, 11)).toBe(12);
    expect(nextBarCursor(p, 12)).toBe(12);
  });

  it('goes back to the start of the bar being played', () => {
    expect(previousBarCursor(p, 12)).toBe(10);
    expect(previousBarCursor(p, 10)).toBe(5);
    expect(previousBarCursor(p, 7)).toBe(5);
    expect(previousBarCursor(p, 5)).toBe(0);
    expect(previousBarCursor(p, 0)).toBe(0);
  });
});

describe('columnsToBars', () => {
  it('turns columns into bars and copes with none', () => {
    expect(columnsToBars(null)).toEqual([]);
    expect(columnsToBars({ t: [T0], o: [1], h: [2], l: [0.5], c: [1.5] })).toEqual([
      { time: T0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 },
    ]);
  });
});

describe('tradeMarkers', () => {
  const HOUR = 3600;
  const trades: ReplayTrade[] = [
    {
      // Decided at the close of the 08:00 bar; stopped at 10:20.
      entry_time: '2026-01-05T08:00:00',
      exit_time: '2026-01-05T10:20:00',
      entry_price: 1.1,
      exit_price: 1.09,
      order_type: 'BUY',
      pnl: -10,
      exit_reason: 'Stop hit at 1.09000',
    },
    {
      // A short, closed by its rule at the close of the 12:00 bar.
      entry_time: '2026-01-05T11:00:00',
      exit_time: '2026-01-05T12:00:00',
      entry_price: 1.08,
      exit_price: 1.07,
      order_type: 'SELL',
      pnl: 10,
      exit_reason: 'rules met',
    },
  ];
  const at = (h: number, m = 0) => tradeMarkers(trades, HOUR, T0 + h * HOUR + m * 60);

  it('shows nothing before the replay starts or before a decision could be known', () => {
    expect(tradeMarkers(trades, HOUR, null)).toEqual([]);
    expect(at(0, 59)).toEqual([]);
  });

  it('shows an entry once its bar has closed, on that bar', () => {
    expect(at(1)).toEqual([
      { time: T0, position: 'belowBar', shape: 'arrowUp', color: '#16a34a', text: 'Buy 1.1' },
    ]);
  });

  it('shows a stop on the minute it filled, not at the end of its bar', () => {
    expect(at(2, 20)).toHaveLength(1);
    const stopped = at(2, 21);
    expect(stopped).toHaveLength(2);
    expect(stopped[1]).toMatchObject({ time: T0 + 2 * HOUR, text: 'Stop 1.09', color: '#dc2626' });
  });

  it('shows a short above the bar and its rule exit when that bar has closed', () => {
    expect(at(4).map((m) => m.text)).toEqual(['Buy 1.1', 'Stop 1.09', 'Short 1.08']);
    expect(at(4)[2]).toMatchObject({ position: 'aboveBar', shape: 'arrowDown' });
    expect(at(4, 59)).toHaveLength(3);
    expect(at(5)[3]).toMatchObject({ time: T0 + 4 * HOUR, text: 'Exit 1.07', color: '#16a34a' });
  });
});

describe('requests', () => {
  const target = {
    symbol: 'EURUSD',
    source: 'mt5',
    account: 'demo',
    secType: 'CASH',
    timeframe: '1hour',
    start: '2026-01-05T08:00',
  };

  it('asks for the replay with the start read as UTC', () => {
    const q = new URLSearchParams(replayRequest(target));
    expect(q.get('start')).toBe('2026-01-05T08:00:00Z');
    expect(q.get('symbol')).toBe('EURUSD');
    expect(q.get('source')).toBe('mt5');
    expect(q.get('timeframe')).toBe('1hour');
    const bare = new URLSearchParams(replayRequest({ ...target, source: '', account: '' }));
    expect(bare.has('source')).toBe(false);
  });

  it('asks for a strategy’s trades over the same bars, warmed up, and not saved', () => {
    const replay = {
      timeframe: '1hour',
      start: '2026-01-05T08:00:00.000Z',
      minutes: { t: [T0, T0 + 30 * 3600] },
    } as unknown as ReplayResponse;
    expect(signalsRequest(target, replay, 7)).toEqual({
      definition_id: 7,
      symbol: 'EURUSD',
      timeframe: '1hour',
      source: 'mt5',
      account: 'demo',
      sec_type: 'CASH',
      // 300 hourly bars before the start.
      start_date: '2025-12-23',
      end_date: '2026-01-07',
      on_missing: 'use_stored',
      save: false,
    });
  });
});
