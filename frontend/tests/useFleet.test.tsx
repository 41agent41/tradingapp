/**
 * Tests for useFleet (Component C — C-5).
 *
 * The behaviour that matters operationally is what the hook does when it
 * *cannot* refresh: a blank panel reads as "nothing is running", which is the
 * opposite of the truth during a transient blip and exactly the wrong thing to
 * show someone deciding whether to intervene.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { acceptsMode, tradableConnections, useFleet } from '../app/lib/useFleet';

const snapshot = {
  connections: [
    {
      connection: 'mt5:icmarkets',
      platform: 'mt5',
      account: 'icmarkets',
      account_mode: 'live',
      broker: true,
      active_runs: 1,
    },
    {
      connection: 'mt5:demo',
      platform: 'mt5',
      account: 'demo',
      account_mode: 'paper',
      broker: true,
      active_runs: 0,
    },
  ],
  currency: { consistent: true, currencies: ['USD'] },
  strategies: [],
  totals: { connections: 2, active_runs: 1, pending_runs: 0, errored_runs: 0 },
  broker_service_error: null,
  last_updated: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('useFleet', () => {
  it('loads the fleet snapshot', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify(snapshot))) as any;

    const { result } = renderHook(() => useFleet(0));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.fleet?.connections).toHaveLength(2);
    expect(result.current.error).toBeNull();
  });

  it('keeps the last good snapshot when a refresh fails', async () => {
    // The important one. Blanking the panel would read as "nothing is
    // running" while the fleet is in fact trading.
    let call = 0;
    global.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify(snapshot));
      throw new Error('network down');
    }) as any;

    const { result } = renderHook(() => useFleet(10));
    await waitFor(() => expect(result.current.fleet).not.toBeNull());
    await waitFor(() => expect(result.current.error).not.toBeNull());

    expect(result.current.fleet?.connections).toHaveLength(2);
    expect(result.current.error).toMatch(/network down/);
  });

  it('surfaces a non-ok response as an error', async () => {
    global.fetch = vi.fn(async () => new Response('nope', { status: 500 })) as any;

    const { result } = renderHook(() => useFleet(0));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toMatch(/500/);
  });
});

describe('connection helpers', () => {
  it('lists only connections that can take orders', () => {
    const withDataOnly = {
      ...snapshot,
      connections: [
        ...snapshot.connections,
        { ...snapshot.connections[0], connection: 'x:y', broker: false },
      ],
    } as any;
    expect(tradableConnections(withDataOnly).map((c) => c.connection)).toEqual([
      'mt5:icmarkets',
      'mt5:demo',
    ]);
  });

  it('matches a connection to the order mode it accepts', () => {
    // The registry enforces this server-side with a 409, but a picker should
    // not offer a choice that will be refused.
    const [live, demo] = snapshot.connections as any;
    expect(acceptsMode(live, 'live')).toBe(true);
    expect(acceptsMode(live, 'paper')).toBe(false);
    expect(acceptsMode(demo, 'paper')).toBe(true);
  });

  it('tolerates a null fleet', () => {
    expect(tradableConnections(null)).toEqual([]);
  });
});
