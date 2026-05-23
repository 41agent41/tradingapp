/**
 * Unit tests for `app/lib/useRealtimeStream.ts`.
 *
 * `socket.io-client` is mocked with a small in-memory fake so the
 * tests don't open a real WebSocket. The hook is exercised through
 * @testing-library/react's `renderHook` API.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fake Socket.IO client
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void;

class FakeSocket {
  listeners: Map<string, Listener[]> = new Map();
  emitted: Array<{ event: string; payload: unknown }> = [];
  disconnected = false;

  on(event: string, listener: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(listener);
  }

  removeAllListeners() {
    this.listeners.clear();
  }

  emit(event: string, payload?: unknown) {
    this.emitted.push({ event, payload });
  }

  disconnect() {
    this.disconnected = true;
    this.fire('disconnect');
  }

  // Helpers for tests
  fire(event: string, ...args: unknown[]) {
    const list = this.listeners.get(event) ?? [];
    for (const l of list) l(...args);
  }
}

const lastSocket = { current: null as FakeSocket | null };

vi.mock('socket.io-client', () => ({
  io: (..._args: unknown[]) => {
    const s = new FakeSocket();
    lastSocket.current = s;
    return s;
  },
}));

// Provide deterministic env defaults so the hook builds the same URL
// across tests.
beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = 'http://localhost:4000';
  process.env.NEXT_PUBLIC_API_TOKEN = 'test-token';
  lastSocket.current = null;
});

async function importHook() {
  vi.resetModules();
  const mod = await import('../app/lib/useRealtimeStream');
  return mod.useRealtimeStream;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('useRealtimeStream', () => {
  it('does nothing when enabled=false', async () => {
    const useRealtimeStream = await importHook();
    renderHook(() => useRealtimeStream({ symbol: 'MSFT', enabled: false }));
    expect(lastSocket.current).toBeNull();
  });

  it('opens a socket and emits subscribe-market-data once connected', async () => {
    const useRealtimeStream = await importHook();
    const { result } = renderHook(() => useRealtimeStream({ symbol: 'MSFT' }));
    expect(lastSocket.current).not.toBeNull();
    const socket = lastSocket.current!;

    expect(socket.emitted).toEqual([]); // not yet — we haven't connected
    expect(result.current.connected).toBe(false);

    act(() => {
      socket.fire('connect');
    });

    expect(result.current.connected).toBe(true);
    // First subscribe lands now that we're connected.
    expect(socket.emitted).toEqual([
      {
        event: 'subscribe-market-data',
        payload: { symbol: 'MSFT', secType: undefined, exchange: undefined, currency: undefined },
      },
    ]);
  });

  it('passes contract qualifiers through to the subscribe payload', async () => {
    const useRealtimeStream = await importHook();
    renderHook(() =>
      useRealtimeStream({ symbol: 'aapl', secType: 'STK', exchange: 'NASDAQ', currency: 'USD' })
    );
    const socket = lastSocket.current!;
    act(() => socket.fire('connect'));
    expect(socket.emitted[0].payload).toEqual({
      symbol: 'AAPL',
      secType: 'STK',
      exchange: 'NASDAQ',
      currency: 'USD',
    });
  });

  it('exposes the latest tick payload via state', async () => {
    const useRealtimeStream = await importHook();
    const { result } = renderHook(() => useRealtimeStream({ symbol: 'MSFT' }));
    const socket = lastSocket.current!;
    act(() => socket.fire('connect'));

    act(() => {
      socket.fire('market-data-update', {
        symbol: 'MSFT',
        type: 'tick',
        tick_type: 'LAST',
        tick_type_code: 4,
        price: 380.5,
        size: null,
        value: 380.5,
        timestamp: 1.0,
      });
    });

    expect(result.current.latestTick?.value).toBe(380.5);
    expect(result.current.latestTick?.symbol).toBe('MSFT');
  });

  it('filters ticks for other symbols', async () => {
    const useRealtimeStream = await importHook();
    const { result } = renderHook(() => useRealtimeStream({ symbol: 'MSFT' }));
    const socket = lastSocket.current!;
    act(() => socket.fire('connect'));

    act(() => {
      socket.fire('market-data-update', {
        symbol: 'AAPL',
        type: 'tick',
        tick_type: 'LAST',
        tick_type_code: 4,
        price: 1.0,
        size: null,
        value: 1.0,
        timestamp: 0,
      });
    });

    expect(result.current.latestTick).toBeNull();
  });

  it('captures market-data-status events', async () => {
    const useRealtimeStream = await importHook();
    const { result } = renderHook(() => useRealtimeStream({ symbol: 'MSFT' }));
    const socket = lastSocket.current!;
    act(() => socket.fire('connect'));

    act(() => {
      socket.fire('market-data-status', { event: 'started', symbol: 'MSFT', req_id: 10000 });
    });
    expect(result.current.lastStatus?.event).toBe('started');
  });

  it('captures connect_error messages on the error channel', async () => {
    const useRealtimeStream = await importHook();
    const { result } = renderHook(() => useRealtimeStream({ symbol: 'MSFT' }));
    const socket = lastSocket.current!;
    act(() => socket.fire('connect_error', new Error('refused')));
    expect(result.current.error).toBe('refused');
  });

  it('re-subscribes when the symbol changes', async () => {
    const useRealtimeStream = await importHook();
    const { rerender } = renderHook(
      ({ s }: { s: string | null }) => useRealtimeStream({ symbol: s }),
      { initialProps: { s: 'MSFT' } }
    );
    const socket = lastSocket.current!;
    act(() => socket.fire('connect'));

    expect(socket.emitted.map((e) => e.event)).toEqual(['subscribe-market-data']);

    rerender({ s: 'AAPL' });
    expect(socket.emitted.map((e) => e.event)).toEqual([
      'subscribe-market-data',
      'unsubscribe-market-data',
      'subscribe-market-data',
    ]);
    expect((socket.emitted[2].payload as { symbol: string }).symbol).toBe('AAPL');
  });

  it('unsubscribes on unmount and disconnects the socket', async () => {
    const useRealtimeStream = await importHook();
    const { unmount } = renderHook(() => useRealtimeStream({ symbol: 'MSFT' }));
    const socket = lastSocket.current!;
    act(() => socket.fire('connect'));

    unmount();

    expect(socket.disconnected).toBe(true);
  });

  it('exposes a manual unsubscribe escape hatch', async () => {
    const useRealtimeStream = await importHook();
    const { result } = renderHook(() => useRealtimeStream({ symbol: 'MSFT' }));
    const socket = lastSocket.current!;
    act(() => socket.fire('connect'));
    expect(socket.emitted.map((e) => e.event)).toEqual(['subscribe-market-data']);

    act(() => result.current.unsubscribe());
    expect(socket.emitted.map((e) => e.event)).toEqual([
      'subscribe-market-data',
      'unsubscribe-market-data',
    ]);
    expect(result.current.latestTick).toBeNull();
  });
});
