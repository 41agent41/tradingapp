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
});
