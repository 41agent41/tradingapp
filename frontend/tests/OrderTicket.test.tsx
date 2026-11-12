/**
 * Tests for the OrderTicket component.
 *
 * Covers the LIVE confirmation modal gate and the conditional
 * limit/stop fields. The config probe is mocked so the suite is
 * hermetic.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import OrderTicket from '../app/components/OrderTicket';

const CONFIG_BODY = {
  live_trading_enabled: true,
  backend_live_enabled: true,
  ib_live_enabled: true,
  order_types: ['MKT', 'LMT', 'STP', 'STP_LMT'],
  tif: ['DAY', 'GTC', 'IOC', 'FOK'],
  actions: ['BUY', 'SELL'],
};

function mockSequence(...bodies: Array<{ status?: number; body: unknown }>) {
  const seq = [...bodies];
  global.fetch = vi.fn(async () => {
    const next = seq.shift() ?? { body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as any;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('OrderTicket', () => {
  it('renders the PAPER badge by default and submits without a confirmation modal', async () => {
    mockSequence(
      { body: CONFIG_BODY },
      { status: 201, body: { audit_id: 1, order_id: 42, status: 'submitted' } }
    );

    render(<OrderTicket />);
    expect(screen.getByText('PAPER')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Place paper order')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('MSFT'), { target: { value: 'MSFT' } });
    fireEvent.click(screen.getByRole('button', { name: /Place paper order/i }));

    await waitFor(() => expect(screen.getByText(/Order submitted/)).toBeInTheDocument());
    // No modal was opened.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a confirmation modal before sending a LIVE order', async () => {
    mockSequence(
      { body: CONFIG_BODY },
      { status: 201, body: { audit_id: 2, order_id: 7, status: 'submitted' } }
    );

    render(<OrderTicket />);
    await waitFor(() => expect(screen.getByText('Place paper order')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('MSFT'), { target: { value: 'MSFT' } });
    // Switch to live.
    const accountSelect = screen
      .getAllByRole('combobox')
      .find((el) => (el as HTMLSelectElement).value === 'paper');
    if (accountSelect) fireEvent.change(accountSelect, { target: { value: 'live' } });

    await waitFor(() => expect(screen.getByText('LIVE TRADING')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Review live order/i }));

    // Modal appears.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Confirm LIVE order')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Send LIVE order/i }));
    await waitFor(() => expect(screen.getByText(/Order submitted/)).toBeInTheDocument());
  });

  it('disables the Live option when the config probe reports the gate off', async () => {
    mockSequence({ body: { ...CONFIG_BODY, live_trading_enabled: false } });
    render(<OrderTicket />);
    await waitFor(() => expect(screen.getByText('Place paper order')).toBeInTheDocument());
    // The Live option should exist but be disabled.
    const opts = Array.from(document.querySelectorAll('option')) as HTMLOptionElement[];
    const live = opts.find((o) => o.value === 'live');
    expect(live).toBeTruthy();
    expect(live?.disabled).toBe(true);
  });

  it('reveals the Limit input only when order_type=LMT', async () => {
    mockSequence({ body: CONFIG_BODY });
    render(<OrderTicket />);
    await waitFor(() => expect(screen.getByText('Place paper order')).toBeInTheDocument());

    expect(screen.queryByText('Limit price')).not.toBeInTheDocument();

    const orderTypeSelect = screen
      .getAllByRole('combobox')
      .find((el) => (el as HTMLSelectElement).value === 'MKT');
    if (orderTypeSelect) fireEvent.change(orderTypeSelect, { target: { value: 'LMT' } });
    expect(screen.getByText('Limit price')).toBeInTheDocument();
  });

  it('surfaces a backend error inline', async () => {
    mockSequence(
      { body: CONFIG_BODY },
      { status: 403, body: { error: 'Live trading is disabled', detail: 'gate is off' } }
    );
    render(<OrderTicket />);
    await waitFor(() => expect(screen.getByText('Place paper order')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('MSFT'), { target: { value: 'MSFT' } });
    fireEvent.click(screen.getByRole('button', { name: /Place paper order/i }));

    await waitFor(() => expect(screen.getByText(/gate is off/)).toBeInTheDocument());
  });

  describe('connections that say what they support (E-19)', () => {
    const CONNECTIONS = [
      {
        label: 'oanda:default',
        platform: 'oanda',
        account: 'default',
        account_mode: 'paper',
        is_default: true,
        order_types: {
          MKT: ['DAY', 'GTC', 'IOC', 'FOK'],
          LMT: ['DAY', 'GTC', 'IOC', 'FOK'],
          STP: ['DAY', 'GTC', 'IOC', 'FOK'],
          STP_LMT: ['DAY', 'GTC', 'IOC', 'FOK'],
        },
      },
      {
        label: 'ig:demo',
        platform: 'ig',
        account: 'demo',
        account_mode: 'paper',
        is_default: false,
        order_types: {
          MKT: ['DAY', 'GTC', 'IOC', 'FOK'],
          LMT: ['DAY', 'GTC'],
          STP: ['DAY', 'GTC'],
        },
      },
    ];
    const options = (label: string) =>
      Array.from((screen.getByLabelText(label) as HTMLSelectElement).options).map((o) => o.value);

    it('offers only the order types and times in force the chosen connection takes', async () => {
      const posted: any[] = [];
      global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posted.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ audit_id: 3, order_id: 9 }), { status: 201 });
        }
        return new Response(JSON.stringify({ ...CONFIG_BODY, connections: CONNECTIONS }));
      }) as any;

      render(<OrderTicket />);
      await waitFor(() => expect(screen.getByLabelText('Connection')).toBeInTheDocument());
      // The default connection takes everything.
      expect(options('Order type')).toEqual(['MKT', 'LMT', 'STP', 'STP_LMT']);
      fireEvent.change(screen.getByLabelText('Order type'), { target: { value: 'STP_LMT' } });
      fireEvent.change(screen.getByLabelText('Time in force'), { target: { value: 'FOK' } });

      fireEvent.change(screen.getByLabelText('Connection'), { target: { value: 'ig:demo' } });
      // IG has no stop-limit order, so the choice falls back to the first.
      expect(options('Order type')).toEqual(['MKT', 'LMT', 'STP']);
      expect((screen.getByLabelText('Order type') as HTMLSelectElement).value).toBe('MKT');
      fireEvent.change(screen.getByLabelText('Order type'), { target: { value: 'LMT' } });
      expect(options('Time in force')).toEqual(['DAY', 'GTC']);
      expect((screen.getByLabelText('Time in force') as HTMLSelectElement).value).toBe('DAY');

      fireEvent.change(screen.getByPlaceholderText('MSFT'), { target: { value: 'eurusd' } });
      fireEvent.change(screen.getByLabelText('Limit price'), { target: { value: '1.1' } });
      fireEvent.click(screen.getByRole('button', { name: /Place paper order/i }));
      await waitFor(() => expect(posted).toHaveLength(1));
      expect(posted[0]).toMatchObject({
        symbol: 'EURUSD',
        broker: 'ig',
        broker_account: 'demo',
        order_type: 'LMT',
        tif: 'DAY',
      });
    });

    it('names no broker when the default connection is left chosen', async () => {
      const posted: any[] = [];
      global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posted.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ audit_id: 4 }), { status: 201 });
        }
        return new Response(JSON.stringify({ ...CONFIG_BODY, connections: CONNECTIONS }));
      }) as any;
      render(<OrderTicket />);
      await waitFor(() => expect(screen.getByLabelText('Connection')).toBeInTheDocument());
      fireEvent.change(screen.getByPlaceholderText('MSFT'), { target: { value: 'EURUSD' } });
      fireEvent.click(screen.getByRole('button', { name: /Place paper order/i }));
      await waitFor(() => expect(posted).toHaveLength(1));
      expect(posted[0].broker).toBeUndefined();
      expect(posted[0].broker_account).toBeUndefined();
    });

    it('shows no connection choice when the backend lists none', async () => {
      mockSequence({ body: CONFIG_BODY });
      render(<OrderTicket />);
      await waitFor(() => expect(screen.getByText('Place paper order')).toBeInTheDocument());
      expect(screen.queryByLabelText('Connection')).not.toBeInTheDocument();
    });
  });

  describe('protection on the entry (E-16)', () => {
    const connection = (over: Record<string, unknown>) => ({
      label: 'oanda:default',
      platform: 'oanda',
      account: 'default',
      account_mode: 'paper',
      is_default: true,
      order_types: null,
      ...over,
    });
    const withConnection = (over: Record<string, unknown>) => {
      const posted: any[] = [];
      global.fetch = vi.fn(async (_url: any, init: any) => {
        if (init?.method === 'POST') {
          posted.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ audit_id: 5 }), { status: 201 });
        }
        return new Response(JSON.stringify({ ...CONFIG_BODY, connections: [connection(over)] }));
      }) as any;
      return posted;
    };

    it('sends a stop, a target and a trailing stop where the broker has them', async () => {
      const posted = withConnection({ attaches_stops: true, trailing_stops: true });
      render(<OrderTicket />);
      await waitFor(() => expect(screen.getByLabelText('Protective stop')).toBeInTheDocument());
      // No guaranteed stop at this broker, and nothing to trail yet.
      expect(screen.queryByLabelText(/Guaranteed stop/)).toBeNull();
      expect(screen.getByLabelText(/Trailing stop/)).toBeDisabled();

      fireEvent.change(screen.getByPlaceholderText('MSFT'), { target: { value: 'EUR.USD' } });
      fireEvent.change(screen.getByLabelText('Protective stop'), { target: { value: '1.08' } });
      fireEvent.change(screen.getByLabelText('Target'), { target: { value: '1.12' } });
      fireEvent.click(screen.getByLabelText(/Trailing stop/));
      fireEvent.click(screen.getByRole('button', { name: /Place paper order/i }));
      await waitFor(() => expect(posted).toHaveLength(1));
      expect(posted[0]).toMatchObject({ stop_loss: 1.08, take_profit: 1.12, trailing_stop: true });
      expect(posted[0].guaranteed_stop).toBeUndefined();
    });

    it('warns when the broker placed the order without the stop', async () => {
      global.fetch = vi.fn(async (_url: any, init: any) =>
        init?.method === 'POST'
          ? new Response(JSON.stringify({ audit_id: 6, stop_loss_missing: true }), { status: 201 })
          : new Response(
              JSON.stringify({
                ...CONFIG_BODY,
                connections: [connection({ attaches_stops: true })],
              })
            )
      ) as any;
      render(<OrderTicket />);
      await waitFor(() => expect(screen.getByLabelText('Protective stop')).toBeInTheDocument());
      fireEvent.change(screen.getByPlaceholderText('MSFT'), { target: { value: 'EUR.USD' } });
      fireEvent.change(screen.getByLabelText('Protective stop'), { target: { value: '1.08' } });
      fireEvent.click(screen.getByRole('button', { name: /Place paper order/i }));
      await waitFor(() =>
        expect(screen.getByText(/did not record the protective stop/)).toBeInTheDocument()
      );
    });

    it('offers a guaranteed stop only where the broker has one', async () => {
      const posted = withConnection({ attaches_stops: true, guaranteed_stops: true });
      render(<OrderTicket />);
      await waitFor(() => expect(screen.getByLabelText(/Guaranteed stop/)).toBeInTheDocument());
      expect(screen.queryByLabelText(/Trailing stop/)).toBeNull();
      fireEvent.change(screen.getByPlaceholderText('MSFT'), { target: { value: 'EUR.USD' } });
      fireEvent.change(screen.getByLabelText('Protective stop'), { target: { value: '1.08' } });
      fireEvent.click(screen.getByLabelText(/Guaranteed stop/));
      fireEvent.click(screen.getByRole('button', { name: /Place paper order/i }));
      await waitFor(() => expect(posted).toHaveLength(1));
      expect(posted[0]).toMatchObject({ stop_loss: 1.08, guaranteed_stop: true });
    });

    it('has no protection fields on a broker that cannot attach a stop', async () => {
      const posted = withConnection({ attaches_stops: false });
      render(<OrderTicket />);
      await waitFor(() => expect(screen.getByText('Place paper order')).toBeInTheDocument());
      expect(screen.queryByLabelText('Protective stop')).toBeNull();
      fireEvent.change(screen.getByPlaceholderText('MSFT'), { target: { value: 'AAPL' } });
      fireEvent.click(screen.getByRole('button', { name: /Place paper order/i }));
      await waitFor(() => expect(posted).toHaveLength(1));
      expect(posted[0].stop_loss).toBeUndefined();
    });
  });
});
