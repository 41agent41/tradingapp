/**
 * Unit tests for `app/lib/useStrategySignals.ts`.
 *
 * `socket.io-client` is mocked with the same in-memory fake used by the
 * realtime-stream tests, so no real WebSocket opens.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  fire(event: string, ...args: unknown[]) {
    for (const l of this.listeners.get(event) ?? []) l(...args);
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

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = 'http://localhost:4000';
  process.env.NEXT_PUBLIC_API_TOKEN = 'test-token';
  lastSocket.current = null;
});

async function importHook() {
  vi.resetModules();
  const mod = await import('../app/lib/useStrategySignals');
  return mod.useStrategySignals;
}

function signal(overrides: Record<string, unknown> = {}) {
  return {
    run_id: 7,
    symbol: 'MSFT',
    timeframe: '5min',
    bar_time: '2026-01-10T14:00:00Z',
    signal: 'buy',
    reason: 'entry',
    entry: true,
    exit: false,
    in_session: true,
    position_size: 0,
    ...overrides,
  };
}

describe('useStrategySignals', () => {
  it('does nothing when enabled=false', async () => {
    const useStrategySignals = await importHook();
    renderHook(() => useStrategySignals({ runId: 7, enabled: false }));
    expect(lastSocket.current).toBeNull();
  });

  it('subscribes to the run once connected', async () => {
    const useStrategySignals = await importHook();
    const { result } = renderHook(() => useStrategySignals({ runId: 7 }));
    const socket = lastSocket.current!;
    expect(socket.emitted).toEqual([]);

    act(() => socket.fire('connect'));

    expect(result.current.connected).toBe(true);
    expect(socket.emitted).toEqual([{ event: 'subscribe-strategy', payload: { runId: 7 } }]);
  });

  it('collects strategy-signal events newest-first', async () => {
    const useStrategySignals = await importHook();
    const { result } = renderHook(() => useStrategySignals({ runId: 7 }));
    const socket = lastSocket.current!;
    act(() => socket.fire('connect'));

    act(() => socket.fire('strategy-signal', signal({ bar_time: '2026-01-10T14:00:00Z' })));
    act(() =>
      socket.fire('strategy-signal', signal({ bar_time: '2026-01-10T14:05:00Z', signal: 'sell' }))
    );

    expect(result.current.signals).toHaveLength(2);
    expect(result.current.latest?.bar_time).toBe('2026-01-10T14:05:00Z');
    expect(result.current.latest?.signal).toBe('sell');
  });

  it('filters events for other runs', async () => {
    const useStrategySignals = await importHook();
    const { result } = renderHook(() => useStrategySignals({ runId: 7 }));
    const socket = lastSocket.current!;
    act(() => socket.fire('connect'));
    act(() => socket.fire('strategy-signal', signal({ run_id: 99 })));
    expect(result.current.signals).toHaveLength(0);
  });

  it('re-subscribes when the run changes', async () => {
    const useStrategySignals = await importHook();
    const { rerender } = renderHook(
      ({ id }: { id: number | null }) => useStrategySignals({ runId: id }),
      {
        initialProps: { id: 7 as number | null },
      }
    );
    const socket = lastSocket.current!;
    act(() => socket.fire('connect'));
    expect(socket.emitted.map((e) => e.event)).toEqual(['subscribe-strategy']);

    rerender({ id: 8 });
    expect(socket.emitted.map((e) => e.event)).toEqual([
      'subscribe-strategy',
      'unsubscribe-strategy',
      'subscribe-strategy',
    ]);
    expect((socket.emitted[2].payload as { runId: number }).runId).toBe(8);
  });

  it('disconnects on unmount', async () => {
    const useStrategySignals = await importHook();
    const { unmount } = renderHook(() => useStrategySignals({ runId: 7 }));
    const socket = lastSocket.current!;
    act(() => socket.fire('connect'));
    unmount();
    expect(socket.disconnected).toBe(true);
  });
});
