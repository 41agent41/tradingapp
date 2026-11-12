/**
 * The depth of market panel: it reads the book only when asked, from the
 * connection it was given, and says why when there is none.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DepthOfMarket from '../app/components/DepthOfMarket';
import OrderTicket from '../app/components/OrderTicket';

const BOOK = {
  symbol: 'EURUSD',
  broker: 'ctrader',
  timestamp: '2026-11-10T12:00:00Z',
  bids: [
    { price: 1.1, size: 1200000 },
    { price: 1.0999, size: 500000 },
  ],
  asks: [{ price: 1.1001, size: 800000 }],
};

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('DepthOfMarket', () => {
  it('reads the book from the given connection only when asked, and shows both sides', async () => {
    const urls: string[] = [];
    global.fetch = vi.fn(async (url: any) => {
      urls.push(String(url));
      return new Response(JSON.stringify(BOOK));
    }) as any;
    render(<DepthOfMarket symbol="EURUSD" platform="ctrader" account="demo" />);
    expect(urls).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Show depth' }));
    await waitFor(() => expect(screen.getByText('1,200,000')).toBeInTheDocument());
    expect(urls[0]).toContain('/api/market-data/depth?');
    expect(urls[0]).toContain('symbol=EURUSD&source=ctrader&account=demo&levels=10');
    expect(screen.getByText('1.1001')).toBeInTheDocument();
    expect(screen.getByText('800,000')).toBeInTheDocument();
    // Two bids and one ask: two rows.
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('shows the reason when the broker has no book', async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'cTrader sent no depth of market for EURUSD' }), {
          status: 503,
        })
    ) as any;
    render(<DepthOfMarket symbol="EURUSD" platform="ctrader" account="demo" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show depth' }));
    await waitFor(() =>
      expect(screen.getByText('cTrader sent no depth of market for EURUSD')).toBeInTheDocument()
    );
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('cannot be asked without a symbol', () => {
    render(<DepthOfMarket symbol=" " platform="ctrader" account="demo" />);
    expect(screen.getByRole('button', { name: 'Show depth' })).toBeDisabled();
  });
});

describe('OrderTicket', () => {
  const config = (depth: boolean) => ({
    live_trading_enabled: false,
    backend_live_enabled: false,
    ib_live_enabled: false,
    order_types: ['MKT', 'LMT'],
    tif: ['DAY', 'GTC'],
    actions: ['BUY', 'SELL'],
    connections: [
      {
        label: 'ctrader:demo',
        platform: 'ctrader',
        account: 'demo',
        account_mode: 'paper',
        is_default: true,
        order_types: null,
        depth,
      },
    ],
  });

  it('offers depth of market only on a connection that has it', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify(config(true)))) as any;
    const { unmount } = render(<OrderTicket />);
    await waitFor(() => expect(screen.getByLabelText('Depth of market')).toBeInTheDocument());
    unmount();

    global.fetch = vi.fn(async () => new Response(JSON.stringify(config(false)))) as any;
    render(<OrderTicket />);
    await waitFor(() => expect(screen.getByText('Place paper order')).toBeInTheDocument());
    expect(screen.queryByLabelText('Depth of market')).toBeNull();
  });
});
