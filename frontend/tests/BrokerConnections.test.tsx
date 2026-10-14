/**
 * The Settings page Connections tab: lists broker connections in the order
 * the backend sends and re-checks one when its Test button is pressed.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import BrokerConnections, { checkSummary } from '../app/components/BrokerConnections';

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

const STATUS = {
  default: 'oanda',
  priority: ['oanda', 'mt5', 'ib', 'alpaca'],
  connections: [
    {
      label: 'oanda:default',
      platform: 'oanda',
      account: 'default',
      account_mode: 'practice',
      is_default: true,
      check: { status: 'connected', error: null, latency_ms: 42, checked_at: 'x' },
    },
    {
      label: 'mt5:default',
      platform: 'mt5',
      account: 'default',
      account_mode: null,
      is_default: false,
      check: null,
    },
  ],
};

describe('checkSummary', () => {
  it('describes each check state', () => {
    expect(checkSummary(null).text).toBe('Not checked yet');
    expect(
      checkSummary({ status: 'connected', error: null, latency_ms: 5, checked_at: null }).text
    ).toBe('Connected (5 ms)');
    expect(
      checkSummary({ status: 'unreachable', error: 'refused', latency_ms: 1, checked_at: null })
    ).toEqual({ tone: 'bad', text: 'Unreachable: refused' });
  });
});

describe('BrokerConnections', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists connections and updates one after Test', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond(STATUS))
      .mockResolvedValueOnce(
        respond({
          label: 'mt5:default',
          check: { status: 'unreachable', error: 'timeout', latency_ms: 3000, checked_at: 'y' },
        })
      );
    global.fetch = fetchMock as any;

    render(<BrokerConnections />);
    await waitFor(() => expect(screen.getByText('OANDA')).toBeInTheDocument());
    expect(screen.getByText('Connected (42 ms)')).toBeInTheDocument();
    expect(screen.getByText('Not checked yet')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Test MT5 default' }));
    await waitFor(() => expect(screen.getByText('Unreachable: timeout')).toBeInTheDocument());
    expect(String(fetchMock.mock.calls[1][0])).toContain('/api/brokers/mt5%3Adefault/test');
  });

  it('says no broker is connected when none is configured', async () => {
    global.fetch = vi.fn().mockResolvedValue(respond({ ...STATUS, connections: [] })) as any;
    render(<BrokerConnections />);
    await waitFor(() => expect(screen.getByText(/No broker connected/)).toBeInTheDocument());
  });
});
