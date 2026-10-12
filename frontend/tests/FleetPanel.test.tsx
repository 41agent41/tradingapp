/**
 * Tests for the fleet view (Component C — C-5).
 *
 * Two properties are load-bearing rather than cosmetic: a live connection must
 * be unmistakable at a glance, and one strategy across N accounts must read as
 * one row with N legs rather than N unrelated runs.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FleetPanel from '../app/components/systematic/FleetPanel';

const fleet = {
  connections: [
    {
      connection: 'mt5:icmarkets',
      platform: 'mt5',
      account: 'icmarkets',
      account_mode: 'live',
      broker: true,
      currency: 'USD',
      active_runs: 1,
    },
    {
      connection: 'mt5:demo',
      platform: 'mt5',
      account: 'demo',
      account_mode: 'paper',
      broker: true,
      currency: 'USD',
      active_runs: 1,
      same_funds_as: 'oanda-native',
    },
  ],
  currency: { consistent: true, currencies: ['USD'] },
  strategies: [
    {
      definition_id: 10,
      name: 'EU trend',
      symbol: 'EURUSD',
      timeframe: '5min',
      group_ids: [5],
      legs: [
        {
          run_id: 1,
          connection: 'mt5:icmarkets',
          native_symbol: 'EURUSD.a',
          account_mode: 'live',
          status: 'running',
          is_canary: true,
          current_stop: 1.09,
          last_evaluated_at: '2026-01-01T00:00:00Z',
          last_error: null,
        },
        {
          run_id: 2,
          connection: 'mt5:demo',
          native_symbol: 'EURUSD_i',
          account_mode: 'paper',
          status: 'pending',
          is_canary: false,
          current_stop: null,
          last_evaluated_at: null,
          last_error: null,
        },
      ],
    },
  ],
  totals: { connections: 2, active_runs: 2, pending_runs: 1, errored_runs: 0 },
  broker_service_error: null,
  last_updated: '2026-01-01T00:00:00Z',
};

function mockFleet(body: unknown = fleet, status = 200) {
  global.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status })) as any;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('FleetPanel', () => {
  it('groups a strategy deployed to two accounts into one row with two legs', async () => {
    mockFleet();
    render(<FleetPanel pollMs={0} />);

    await waitFor(() => expect(screen.getByText('EU trend')).toBeInTheDocument());
    // Both legs listed under the one strategy.
    expect(screen.getAllByText('mt5:icmarkets').length).toBeGreaterThan(0);
    expect(screen.getAllByText('mt5:demo').length).toBeGreaterThan(0);
  });

  it('shows each leg trading its own native symbol', async () => {
    // The same strategy trades EURUSD.a here and EURUSD_i next door; showing
    // the canonical symbol would hide the thing most worth seeing.
    mockFleet();
    render(<FleetPanel pollMs={0} />);

    await waitFor(() => expect(screen.getByText('EURUSD.a')).toBeInTheDocument());
    expect(screen.getByText('EURUSD_i')).toBeInTheDocument();
  });

  it('marks a staged leg as staged rather than as a fault', async () => {
    // A pending leg is a canary-staged deploy waiting its turn.
    mockFleet();
    render(<FleetPanel pollMs={0} />);

    await waitFor(() => expect(screen.getByText('staged')).toBeInTheDocument());
    expect(screen.getByText(/staged behind a canary/)).toBeInTheDocument();
  });

  it('identifies the canary leg', async () => {
    mockFleet();
    render(<FleetPanel pollMs={0} />);
    await waitFor(() => expect(screen.getByText('canary')).toBeInTheDocument());
  });

  it('flags connections that share funds', async () => {
    // Two routes to one pot of money; without this, aggregate exposure looks
    // half as large as it is.
    mockFleet();
    render(<FleetPanel pollMs={0} />);
    await waitFor(() =>
      expect(screen.getByText(/Shares funds with oanda-native/)).toBeInTheDocument()
    );
  });

  it('warns loudly when connections report mixed currencies', async () => {
    mockFleet({
      ...fleet,
      currency: { consistent: false, currencies: ['USD', 'AUD'] },
    });
    render(<FleetPanel pollMs={0} />);

    await waitFor(() =>
      expect(screen.getByText(/refuse to aggregate across mixed denominations/)).toBeInTheDocument()
    );
  });

  it('says so when the broker service is unreachable', async () => {
    mockFleet({ ...fleet, broker_service_error: 'connect ECONNREFUSED' });
    render(<FleetPanel pollMs={0} />);

    await waitFor(() => expect(screen.getByText(/Broker service unreachable/)).toBeInTheDocument());
  });

  it('reports an empty fleet plainly rather than looking broken', async () => {
    mockFleet({
      connections: [],
      currency: null,
      strategies: [],
      totals: { connections: 0, active_runs: 0, pending_runs: 0, errored_runs: 0 },
      broker_service_error: null,
      last_updated: '2026-01-01T00:00:00Z',
    });
    render(<FleetPanel pollMs={0} />);

    await waitFor(() => expect(screen.getByText('No connections configured.')).toBeInTheDocument());
    expect(screen.getByText('No strategies running.')).toBeInTheDocument();
  });
});
