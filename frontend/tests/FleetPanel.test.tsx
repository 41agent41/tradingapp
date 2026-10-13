/**
 * Tests for the fleet view (Component C — C-5).
 *
 * Two properties are load-bearing rather than cosmetic: a live connection must
 * be unmistakable at a glance, and one strategy across N accounts must read as
 * one row with N legs rather than N unrelated runs.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('shows a kill-switch halt and resumes the connection on request', async () => {
    const halted = {
      ...fleet,
      connections: [
        {
          ...fleet.connections[0],
          halt: {
            trigger_kind: 'unprotected_position',
            detail: 'EURUSD.a is 0.1 with no protective stop',
            run_id: 1,
            halted_at: '2026-01-01T00:00:00Z',
          },
        },
        fleet.connections[1],
      ],
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? new Response(JSON.stringify({ resumed: true }), { status: 200 })
        : new Response(JSON.stringify(halted), { status: 200 })
    );
    global.fetch = fetchMock as any;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<FleetPanel pollMs={0} />);

    await waitFor(() =>
      expect(
        screen.getByText(/kill switch halted new entries on mt5:icmarkets/)
      ).toBeInTheDocument()
    );
    expect(screen.getByText('Entries halted (unprotected position)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Resume entries' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/strategies\/connections\/mt5\/icmarkets\/resume$/),
        expect.objectContaining({ method: 'POST' })
      )
    );
  });

  it('does not resume when the operator cancels', async () => {
    const halted = {
      ...fleet,
      connections: [
        {
          ...fleet.connections[0],
          halt: {
            trigger_kind: 'equity_floor',
            detail: null,
            run_id: 1,
            halted_at: '2026-01-01T00:00:00Z',
          },
        },
      ],
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(halted), { status: 200 }));
    global.fetch = fetchMock as any;
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<FleetPanel pollMs={0} />);

    await waitFor(() => screen.getByRole('button', { name: 'Resume entries' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resume entries' }));
    expect(fetchMock.mock.calls.some(([, init]: any) => init?.method === 'POST')).toBe(false);
  });

  it('shows equity against its limits and a breached drawdown', async () => {
    const withEquity = {
      ...fleet,
      connections: [
        {
          ...fleet.connections[0],
          equity: {
            equity: 9400,
            trading_day: '2026-10-13',
            day_start_equity: 9600,
            high_water_mark: 10500,
            daily_loss: 200,
            drawdown: 1100,
            max_daily_equity_loss: 300,
            max_drawdown: 1000,
            breaches: ['drawdown'],
            last_at: '2026-10-13T00:00:00Z',
            hwm_at: '2026-10-12T00:00:00Z',
          },
        },
        fleet.connections[1],
      ],
    };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? new Response(JSON.stringify({}), { status: 200 })
        : new Response(JSON.stringify(withEquity), { status: 200 })
    );
    global.fetch = fetchMock as any;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<FleetPanel pollMs={0} />);

    await waitFor(() =>
      expect(screen.getByText('Drawdown limit reached: new entries refused')).toBeInTheDocument()
    );
    expect(screen.getByText(/Today −200.00 of 300.00 limit/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset high-water mark' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/connections\/mt5\/icmarkets\/reset-high-water-mark$/),
        expect.objectContaining({ method: 'POST' })
      )
    );
  });

  it("shows a prop account's room against its firm's rules", async () => {
    mockFleet({
      ...fleet,
      connections: [
        {
          ...fleet.connections[0],
          equity: {
            equity: 95800,
            balance: 100000,
            trading_day: '2026-10-13',
            day_start_equity: 100000,
            high_water_mark: 100000,
            daily_loss: 4200,
            drawdown: 4200,
            max_daily_equity_loss: null,
            max_drawdown: null,
            breaches: ['prop_daily_loss'],
            prop: {
              firm: 'FTMO 100k',
              buffer_pct: 20,
              rules: [
                {
                  kind: 'prop_daily_loss',
                  floor: 95000,
                  allowance: 5000,
                  room: 800,
                  stop_at: 1000,
                  stopped: true,
                },
                {
                  kind: 'prop_max_loss',
                  floor: 90000,
                  allowance: 10000,
                  room: 5800,
                  stop_at: 2000,
                  stopped: false,
                },
              ],
            },
            last_at: '2026-10-13T00:00:00Z',
            hwm_at: '2026-10-12T00:00:00Z',
          },
        },
      ],
    });
    render(<FleetPanel pollMs={0} />);

    await waitFor(() => expect(screen.getByText('FTMO 100k')).toBeInTheDocument());
    expect(screen.getByText(/Daily loss: room 800.00 above 95,000.00/)).toBeInTheDocument();
    expect(
      screen.getByText('Prop daily loss buffer reached: new entries refused for today')
    ).toBeInTheDocument();
  });

  it('says loudly when a prop account has unreadable rules', async () => {
    mockFleet({
      ...fleet,
      connections: [
        {
          ...fleet.connections[0],
          equity: { limits_error: 'PROP_RULES__MT5_ICMARKETS is not valid JSON' },
        },
      ],
    });
    render(<FleetPanel pollMs={0} />);
    await waitFor(() =>
      expect(screen.getByText(/Limits unreadable, all entries refused/)).toBeInTheDocument()
    );
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
