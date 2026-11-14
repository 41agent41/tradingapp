/**
 * The tick history panel: shown only when a connection keeps ticks, asks that
 * connection for the window, and saves what comes back as CSV.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TickHistoryDownload, { ticksToCsv } from '../app/components/TickHistoryDownload';

const status = (tick_history: boolean) => ({
  default: 'oanda',
  priority: [],
  connections: [
    { label: 'oanda:default', platform: 'oanda', account: 'default', capabilities: {} },
    { label: 'ctrader:demo', platform: 'ctrader', account: 'demo', capabilities: { tick_history } },
  ],
});

function serve(statusBody: unknown, ticksBody: unknown, ticksStatus = 200) {
  const urls: string[] = [];
  global.fetch = vi.fn(async (url: any) => {
    urls.push(String(url));
    return String(url).includes('/api/brokers/status')
      ? new Response(JSON.stringify(statusBody))
      : new Response(JSON.stringify(ticksBody), { status: ticksStatus });
  }) as any;
  return urls;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
  (URL as any).createObjectURL = vi.fn(() => 'blob:ticks');
  (URL as any).revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function fill() {
  await waitFor(() => expect(screen.getByLabelText('Tick history')).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'EURUSD' } });
  fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-01-05T00:00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Download ticks (CSV)' }));
}

describe('ticksToCsv', () => {
  it('writes one row a tick with empty cells for missing prices', () => {
    expect(
      ticksToCsv([
        { time: 1767571200250, bid: 1.1, ask: null, last: null },
        { time: 1767571201000, bid: 1.1, ask: 1.1002, last: 1.1001 },
      ])
    ).toBe(
      'time,bid,ask,last\n2026-01-05T00:00:00.250Z,1.1,,\n2026-01-05T00:00:01.000Z,1.1,1.1002,1.1001\n'
    );
  });
});

describe('TickHistoryDownload', () => {
  it('is not shown when no connection keeps ticks', async () => {
    const urls = serve(status(false), {});
    const { container } = render(<TickHistoryDownload />);
    await waitFor(() => expect(urls).toHaveLength(1));
    expect(container).toBeEmptyDOMElement();
  });

  it('asks the connection that keeps ticks and saves them', async () => {
    const urls = serve(status(true), {
      ticks: [{ time: 1767571200250, bid: 1.1, ask: 1.1001, last: null }],
      count: 1,
      complete: true,
    });
    render(<TickHistoryDownload />);
    await fill();
    await waitFor(() => expect(screen.getByText('Saved 1 tick.')).toBeInTheDocument());
    const asked = new URL(urls[1], 'https://api.test');
    expect(asked.pathname).toBe('/api/market-data/ticks');
    expect(asked.searchParams.get('source')).toBe('ctrader');
    expect(asked.searchParams.get('account')).toBe('demo');
    expect(asked.searchParams.get('symbol')).toBe('EURUSD');
    expect(asked.searchParams.get('limit')).toBe('5000');
    expect(asked.searchParams.get('start')).toBe(new Date('2026-01-05T00:00').toISOString());
    expect(asked.searchParams.has('end')).toBe(false);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
  });

  it('says when earlier ticks were left out', async () => {
    serve(status(true), {
      ticks: [{ time: 1767571200250, bid: 1.1, ask: 1.1001, last: null }],
      complete: false,
    });
    render(<TickHistoryDownload />);
    await fill();
    await waitFor(() => expect(screen.getByText(/Earlier ones were left out/)).toBeInTheDocument());
  });

  it('shows the reason on a failure and saves nothing for an empty window', async () => {
    serve(status(true), { error: 'cTrader unreachable' }, 503);
    const { unmount } = render(<TickHistoryDownload />);
    await fill();
    await waitFor(() => expect(screen.getByText('cTrader unreachable')).toBeInTheDocument());
    unmount();

    serve(status(true), { ticks: [], complete: true });
    render(<TickHistoryDownload />);
    await fill();
    await waitFor(() =>
      expect(screen.getByText('The broker has no ticks in that window.')).toBeInTheDocument()
    );
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });
});
