/**
 * The client sentiment panel: it asks only when told to, of the connection it
 * was given, and says why when there is no answer.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ClientSentiment from '../app/components/ClientSentiment';
import OrderTicket from '../app/components/OrderTicket';

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('ClientSentiment', () => {
  it('reads the shares from the given connection only when asked', async () => {
    const urls: string[] = [];
    global.fetch = vi.fn(async (url: any) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({ symbol: 'EUR.USD', broker: 'ig', long_pct: 62.5, short_pct: 37.5 })
      );
    }) as any;
    render(<ClientSentiment symbol="EUR.USD" platform="ig" account="demo" />);
    expect(urls).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Show sentiment' }));
    await waitFor(() => expect(screen.getByText('62.5% long')).toBeInTheDocument());
    expect(screen.getByText('37.5% short')).toBeInTheDocument();
    expect(urls[0]).toContain('/api/market-data/sentiment?symbol=EUR.USD&source=ig&account=demo');
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('shows the reason when the broker has none', async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'IG lists no client sentiment for XYZ' }), {
          status: 404,
        })
    ) as any;
    render(<ClientSentiment symbol="XYZ" platform="ig" account="demo" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show sentiment' }));
    await waitFor(() =>
      expect(screen.getByText('IG lists no client sentiment for XYZ')).toBeInTheDocument()
    );
  });

  it('cannot be asked without a symbol', () => {
    render(<ClientSentiment symbol=" " platform="ig" account="demo" />);
    expect(screen.getByRole('button', { name: 'Show sentiment' })).toBeDisabled();
  });
});

describe('OrderTicket', () => {
  const config = (sentiment: boolean) => ({
    live_trading_enabled: false,
    backend_live_enabled: false,
    ib_live_enabled: false,
    order_types: ['MKT', 'LMT'],
    tif: ['DAY', 'GTC'],
    actions: ['BUY', 'SELL'],
    connections: [
      {
        label: 'ig:demo',
        platform: 'ig',
        account: 'demo',
        account_mode: 'paper',
        is_default: true,
        order_types: null,
        sentiment,
      },
    ],
  });

  it('offers client sentiment only on a connection that has it', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify(config(true)))) as any;
    const { unmount } = render(<OrderTicket />);
    await waitFor(() => expect(screen.getByLabelText('Client sentiment')).toBeInTheDocument());
    unmount();

    global.fetch = vi.fn(async () => new Response(JSON.stringify(config(false)))) as any;
    render(<OrderTicket />);
    await waitFor(() => expect(screen.getByText('Place paper order')).toBeInTheDocument());
    expect(screen.queryByLabelText('Client sentiment')).toBeNull();
  });
});
