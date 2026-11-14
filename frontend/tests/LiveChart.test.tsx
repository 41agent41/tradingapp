/**
 * The live chart's scroll-back and time zone (E-23). The shared <Chart> is
 * replaced so the test can see what it is given and scroll it back.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const chartProps: { current: any } = { current: null };
// Set to have the chart report its start as soon as it is given bars, the
// way the real chart can from its own effect.
const reachStartOnData = { current: false };
vi.mock('../app/components/Chart', async () => {
  const { useEffect } = await import('react');
  function MockChart(props: any) {
    chartProps.current = props;
    useEffect(() => {
      if (reachStartOnData.current && props.data.length > 0) {
        reachStartOnData.current = false;
        props.onReachStart();
      }
    });
    return <div data-testid="chart" />;
  }
  return { default: MockChart };
});
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
  reachStartOnData.current = false;
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

  it('loads older bars when the chart reports its start as the bars arrive', async () => {
    // The chart's effect runs before the live chart's own, so the loader it
    // calls must already know the bars that were just drawn.
    reachStartOnData.current = true;
    const urls = mockHistory([bar(NOW - 4 * HOUR), bar(NOW - 3 * HOUR), bar(NOW - 2 * HOUR)]);
    render(<LiveChart instrument={{ symbol: 'EURUSD', source: 'oanda', secType: 'CASH' }} />);
    await waitFor(() => expect(chartProps.current?.data).toHaveLength(5));
    expect(urls).toHaveLength(2);
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

  it('draws the positions and working orders of its instrument, until switched off', async () => {
    const asked: string[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = (body: unknown) => new Response(JSON.stringify(body));
      if (url.includes('/api/account/positions')) {
        asked.push(url);
        expect(new Headers(init?.headers).get('x-data-query-enabled')).toBe('true');
        return json({
          positions: [
            { symbol: 'EUR.USD', position: 1000, average_cost: 1.1, stop_loss: 1.09 },
            { symbol: 'GBP.USD', position: 5, average_cost: 1.3 },
          ],
        });
      }
      if (url.includes('/api/account/orders')) {
        return json({
          orders: [
            {
              order_id: '7',
              symbol: 'EUR.USD',
              action: 'SELL',
              quantity: 1000,
              order_type: 'LMT',
              price: 1.12,
            },
          ],
        });
      }
      if (url.includes('/api/market-data/history')) return json({ bars: [bar(NOW)] });
      return json({});
    }) as any;
    const { getByLabelText } = render(
      <LiveChart
        instrument={{ symbol: 'EURUSD', source: 'oanda', account: 'demo', secType: 'CASH' }}
      />
    );
    await waitFor(() => expect(chartProps.current?.priceLines).toHaveLength(3));
    expect(chartProps.current.priceLines.map((l: any) => l.title)).toEqual([
      'Long 1,000',
      'Stop',
      'Sell limit 1,000',
    ]);
    expect(asked[0]).toContain('broker=oanda&account=demo');

    await act(async () => {
      getByLabelText('Positions and orders').click();
    });
    await waitFor(() => expect(chartProps.current.priceLines).toEqual([]));
    expect(window.localStorage.getItem('live-chart-levels')).toBe('off');
  });
});
