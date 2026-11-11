/**
 * The live chart's scroll-back and time zone (E-23). The shared <Chart> is
 * replaced so the test can see what it is given and scroll it back.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const chartProps: { current: any } = { current: null };
vi.mock('../app/components/Chart', () => ({
  default: (props: any) => {
    chartProps.current = props;
    return <div data-testid="chart" />;
  },
}));
vi.mock('../app/contexts/TradingAccountContext', () => ({
  useTradingAccount: () => ({ accountMode: 'paper', dataType: 'delayed' }),
}));
vi.mock('../app/lib/useRealtimeStream', () => ({
  useRealtimeStream: () => ({
    connected: false,
    latestTick: null,
    lastStatus: null,
    error: null,
    unsubscribe: () => {},
  }),
}));
vi.mock('../app/components/DataframeViewer', () => ({ default: () => null }));

import LiveChart from '../app/components/LiveChart';

const HOUR = 3600;
const NOW = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
const bar = (time: number) => ({
  timestamp: time,
  open: 1,
  high: 2,
  low: 0.5,
  close: 1.5,
  volume: 10,
});

function mockHistory(older: Array<ReturnType<typeof bar>>) {
  const urls: string[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body));
    if (url.includes('/api/market-data/history')) {
      urls.push(url);
      return json({
        bars: url.includes('start_date=')
          ? older
          : [bar(NOW - 2 * HOUR), bar(NOW - HOUR), bar(NOW)],
      });
    }
    return json({});
  }) as any;
  return urls;
}

beforeEach(() => {
  window.localStorage.clear();
  chartProps.current = null;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('LiveChart', () => {
  it('loads older bars when the chart is scrolled back, and puts them in front', async () => {
    const urls = mockHistory([bar(NOW - 4 * HOUR), bar(NOW - 3 * HOUR), bar(NOW - 2 * HOUR)]);
    render(<LiveChart instrument={{ symbol: 'EURUSD', source: 'oanda', secType: 'CASH' }} />);
    await waitFor(() => expect(chartProps.current?.data).toHaveLength(3));

    await act(async () => chartProps.current.onReachStart());
    await waitFor(() => expect(chartProps.current.data).toHaveLength(5));
    expect(chartProps.current.data.map((b: any) => b.time)).toEqual([
      NOW - 4 * HOUR,
      NOW - 3 * HOUR,
      NOW - 2 * HOUR,
      NOW - HOUR,
      NOW,
    ]);
    // The second request is a date range ending the day after the first bar.
    expect(urls).toHaveLength(2);
    expect(urls[1]).toMatch(/start_date=\d{4}-\d{2}-\d{2}&end_date=\d{4}-\d{2}-\d{2}/);
    expect(urls[1]).toContain('symbol=EURUSD');
    expect(urls[1]).toContain('source=oanda');
    expect(urls[1]).not.toContain('period=');
  });

  it('stops asking once a range returns nothing older', async () => {
    const urls = mockHistory([bar(NOW - 2 * HOUR)]);
    render(<LiveChart instrument={{ symbol: 'EURUSD', secType: 'CASH' }} />);
    await waitFor(() => expect(chartProps.current?.data).toHaveLength(3));

    await act(async () => chartProps.current.onReachStart());
    await waitFor(() => expect(screen.getByText(/No older bars/)).toBeInTheDocument());
    expect(chartProps.current.data).toHaveLength(3);

    await act(async () => chartProps.current.onReachStart());
    expect(urls).toHaveLength(2);
  });

  it('shows times in the chosen zone and remembers the choice', async () => {
    mockHistory([]);
    render(<LiveChart instrument={{ symbol: 'EURUSD', secType: 'CASH' }} />);
    await waitFor(() => expect(chartProps.current?.data).toHaveLength(3));
    expect(chartProps.current.timeZone).toBe('UTC');

    fireEvent.change(screen.getByLabelText('Times:'), { target: { value: 'exchange' } });
    await waitFor(() => expect(chartProps.current.timeZone).toBe('America/New_York'));
    expect(window.localStorage.getItem('chart-time-zone')).toBe('exchange');

    fireEvent.change(screen.getByLabelText('Times:'), { target: { value: 'local' } });
    await waitFor(() => expect(chartProps.current.timeZone).toBe('local'));
  });
});
