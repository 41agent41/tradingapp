/**
 * The replay player: what it hands the chart as the controls are used.
 * The chart itself is replaced by a stand-in that records its props (jsdom
 * cannot paint a canvas).
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const chartProps: { current: any } = { current: null };
vi.mock('../app/components/Chart', () => ({
  default: (props: any) => {
    chartProps.current = props;
    return <div data-testid="chart" />;
  },
}));

import ReplayPlayer from '../app/components/ReplayPlayer';
import type { ReplayResponse } from '../app/lib/replay';

const T0 = Date.UTC(2026, 0, 5, 8, 0) / 1000;

function replay(count = 12): ReplayResponse {
  const i = Array.from({ length: count }, (_, k) => k);
  return {
    contract_id: 1,
    timeframe: '5min',
    start: new Date(T0 * 1000).toISOString(),
    history: {
      t: [T0 - 600, T0 - 300],
      o: [90, 91],
      h: [92, 93],
      l: [89, 90],
      c: [91, 92],
      v: [5, 5],
    },
    minutes: {
      t: i.map((k) => T0 + k * 60),
      o: i.map((k) => 100 + k),
      h: i.map((k) => 100.75 + k),
      l: i.map((k) => 99.75 + k),
      c: i.map((k) => 100.5 + k),
      v: i.map(() => 2),
    },
    more: false,
    stored: { first: null, last: null },
  };
}

const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const progress = () => screen.getByTestId('replay-progress').textContent;

describe('ReplayPlayer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    chartProps.current = null;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts on the history alone, with nothing of the replay shown', () => {
    render(<ReplayPlayer replay={replay()} />);
    expect(chartProps.current.data.map((b: any) => b.time)).toEqual([T0 - 600, T0 - 300]);
    expect(chartProps.current.liveBar).toBeNull();
    expect(screen.getByTestId('replay-clock')).toHaveTextContent('Starts 2026-01-05 08:00 UTC');
    expect(progress()).toBe('0 of 12 minutes');
    expect(screen.getByRole('button', { name: 'Restart' })).toBeDisabled();
  });

  it('steps a minute and a bar, growing the last candle and then finishing it', () => {
    render(<ReplayPlayer replay={replay()} />);
    click('Step one minute');
    expect(chartProps.current.liveBar).toMatchObject({ time: T0, open: 100, close: 100.5 });
    expect(screen.getByTestId('replay-clock')).toHaveTextContent('2026-01-05 08:01 UTC');
    expect(screen.getByTestId('replay-candle')).toHaveTextContent('O 100 H 100.75 L 99.75 C 100.5');

    click('Step one bar');
    expect(progress()).toBe('5 of 12 minutes');
    expect(chartProps.current.liveBar).toMatchObject({ time: T0, high: 104.75, close: 104.5 });
    expect(chartProps.current.data).toHaveLength(2);

    // The next minute starts a new candle; the finished one joins the bars.
    click('Step one minute');
    expect(chartProps.current.data.map((b: any) => b.time)).toEqual([T0 - 600, T0 - 300, T0]);
    expect(chartProps.current.liveBar).toMatchObject({ time: T0 + 300, open: 105 });
  });

  it('plays at the chosen speed, pauses, and stops at the end', () => {
    render(<ReplayPlayer replay={replay()} />);
    fireEvent.change(screen.getByLabelText('Speed'), { target: { value: '2' } });
    click('Play');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    // Two minutes of market a second, for two seconds.
    expect(progress()).toBe('4 of 12 minutes');

    click('Pause');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(progress()).toBe('4 of 12 minutes');

    fireEvent.change(screen.getByLabelText('Speed'), { target: { value: '100' } });
    click('Play');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(progress()).toBe('12 of 12 minutes (end)');
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
  });

  it('goes back a bar and restarts, giving the chart its bars afresh', () => {
    render(<ReplayPlayer replay={replay()} />);
    fireEvent.change(screen.getByLabelText('Replay position'), { target: { value: '7' } });
    expect(progress()).toBe('7 of 12 minutes');
    const before = chartProps.current.data;
    expect(before).toHaveLength(3);

    click('Back one bar');
    expect(progress()).toBe('5 of 12 minutes');
    expect(chartProps.current.data).toHaveLength(2);
    expect(chartProps.current.liveBar).toMatchObject({ time: T0, close: 104.5 });

    // Back inside the same bar: the bars are the same, but handed over anew.
    fireEvent.change(screen.getByLabelText('Replay position'), { target: { value: '3' } });
    const again = chartProps.current.data;
    expect(again).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Replay position'), { target: { value: '2' } });
    expect(chartProps.current.data).not.toBe(again);

    click('Restart');
    expect(chartProps.current.liveBar).toBeNull();
    expect(progress()).toBe('0 of 12 minutes');
  });

  it("shows a strategy's trades only once the replay reaches them", () => {
    const trades = [
      {
        entry_time: '2026-01-05T08:00:00',
        exit_time: null,
        entry_price: 104.5,
        exit_price: null,
        order_type: 'BUY',
        pnl: 0,
        exit_reason: null,
      },
    ];
    render(<ReplayPlayer replay={replay()} trades={trades} />);
    fireEvent.change(screen.getByLabelText('Replay position'), { target: { value: '4' } });
    expect(chartProps.current.markers).toEqual([]);
    fireEvent.change(screen.getByLabelText('Replay position'), { target: { value: '5' } });
    expect(chartProps.current.markers).toEqual([
      expect.objectContaining({ time: T0, text: 'Buy 104.5' }),
    ]);
  });
});
