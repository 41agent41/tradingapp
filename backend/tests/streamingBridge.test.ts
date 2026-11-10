/**
 * StreamingBridge tests.
 *
 * The bridge is wired with a fake Socket.IO server, a fake IB client
 * and a fake Redis subscriber so the suite is hermetic — no network,
 * no real Redis, no IB Gateway.
 */
import { StreamingBridge } from '../src/services/streamingBridge.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeRoom {
  emitted: Array<{ event: string; payload: unknown }>;
}

class FakeSocketIO {
  rooms: Map<string, FakeRoom> = new Map();
  // The real socket.io exposes adapter.rooms which is a Map<string, Set<string>>.
  sockets = {
    adapter: {
      rooms: new Map<string, Set<string>>(),
    },
  };

  to(roomName: string) {
    let room = this.rooms.get(roomName);
    if (!room) {
      room = { emitted: [] };
      this.rooms.set(roomName, room);
    }
    return {
      emit: (event: string, payload: unknown) => {
        room!.emitted.push({ event, payload });
      },
    };
  }

  emit(event: string, payload: unknown) {
    let room = this.rooms.get('__global__');
    if (!room) {
      room = { emitted: [] };
      this.rooms.set('__global__', room);
    }
    room.emitted.push({ event, payload });
  }

  /** Helper for tests to declare "there's a socket in this room". */
  joinRoom(roomName: string, socketId: string) {
    let r = this.sockets.adapter.rooms.get(roomName);
    if (!r) {
      r = new Set<string>();
      this.sockets.adapter.rooms.set(roomName, r);
    }
    r.add(socketId);
  }
}

class FakeIBClient {
  subscribed: Array<Record<string, unknown>> = [];
  unsubscribed: Array<Record<string, unknown>> = [];
  throwOnSubscribe = false;
  /** What the broker service answers: the connection it chose. */
  answer: { source?: string; account?: string } | undefined = undefined;

  async subscribe(payload: Record<string, unknown>) {
    if (this.throwOnSubscribe) {
      throw new Error('IB unreachable');
    }
    this.subscribed.push(payload);
    return this.answer;
  }
  async unsubscribe(payload: Record<string, unknown>) {
    this.unsubscribed.push(payload);
  }
}

class FakeRedis {
  isOpen = true;
  listeners: Record<string, (message: string, channel: string) => void> = {};
  patternListeners: Record<string, (message: string, channel: string) => void> = {};
  events: Record<string, Array<(...args: unknown[]) => void>> = {};

  async connect() {
    /* no-op */
  }
  async quit() {
    this.isOpen = false;
  }
  async subscribe(channel: string, listener: (message: string, channel: string) => void) {
    this.listeners[channel] = listener;
  }
  async pSubscribe(pattern: string, listener: (message: string, channel: string) => void) {
    this.patternListeners[pattern] = listener;
  }
  on(event: string, listener: (...args: unknown[]) => void) {
    (this.events[event] ||= []).push(listener);
  }

  // Test helpers
  deliverTick(channel: string, message: string) {
    const listener = this.patternListeners['marketdata:tick:*'];
    if (listener) listener(message, channel);
  }
  deliverStatus(message: string) {
    const listener = this.listeners['marketdata:status'];
    if (listener) listener(message, 'marketdata:status');
  }
}

function makeBridge() {
  const io = new FakeSocketIO();
  const ibClient = new FakeIBClient();
  const redis = new FakeRedis();
  const bridge = new StreamingBridge(io as unknown as any, {
    ibClient,
    redisFactory: () => redis as unknown as any,
  });
  return { bridge, io, ibClient, redis };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('StreamingBridge.start', () => {
  it('subscribes to the tick pattern and the status channel on Redis', async () => {
    const { bridge, redis } = makeBridge();
    await bridge.start();
    expect(redis.patternListeners['marketdata:tick:*']).toBeDefined();
    expect(redis.listeners['marketdata:status']).toBeDefined();
  });

  it('survives a Redis connection failure with a warning, not a throw', async () => {
    const io = new FakeSocketIO();
    const bridge = new StreamingBridge(io as unknown as any, {
      ibClient: new FakeIBClient(),
      redisFactory: () => {
        return {
          isOpen: false,
          on() {},
          async connect() {
            throw new Error('connect refused');
          },
          async pSubscribe() {},
          async subscribe() {},
          async quit() {},
        } as any;
      },
    });
    await expect(bridge.start()).resolves.toBeUndefined();
    const status = bridge.status();
    expect(status.connected).toBe(false);
    expect(status.last_error).toMatch(/connect refused/i);
  });
});

// ---------------------------------------------------------------------------
// Subscribe / unsubscribe / refcounts
// ---------------------------------------------------------------------------

describe('StreamingBridge.subscribe', () => {
  it('asks the IB service on first subscribe', async () => {
    const { bridge, ibClient } = makeBridge();
    const r = await bridge.subscribe('sock-1', { symbol: 'MSFT' });
    expect(ibClient.subscribed).toEqual([
      {
        symbol: 'MSFT',
        secType: undefined,
        exchange: undefined,
        currency: undefined,
        source: undefined,
        account: undefined,
      },
    ]);
    // An older broker service names no connection: IB's default is assumed.
    expect(r).toMatchObject({ symbol: 'MSFT', room: 'market-data:ib:default:MSFT', refCount: 1 });
  });

  it('uses the connection the broker service chose for the room', async () => {
    const { bridge, ibClient } = makeBridge();
    ibClient.answer = { source: 'oanda', account: 'practice' };
    const r = await bridge.subscribe('sock-1', { symbol: 'eurusd' });
    expect(r).toMatchObject({
      platform: 'oanda',
      account: 'practice',
      room: 'market-data:oanda:practice:EURUSD',
    });
    await bridge.unsubscribe('sock-1', { symbol: 'EURUSD' });
    expect(ibClient.unsubscribed).toEqual([
      { symbol: 'EURUSD', source: 'oanda', account: 'practice' },
    ]);
  });

  it('streams one symbol from two connections separately', async () => {
    const { bridge, ibClient } = makeBridge();
    const a = await bridge.subscribe('s1', { symbol: 'EURUSD', source: 'oanda', account: 'p' });
    const b = await bridge.subscribe('s1', { symbol: 'EURUSD', source: 'ctrader', account: 'ic' });
    expect(ibClient.subscribed).toHaveLength(2);
    expect(a.room).toBe('market-data:oanda:p:EURUSD');
    expect(b.room).toBe('market-data:ctrader:ic:EURUSD');
    const gone = await bridge.unsubscribe('s1', {
      symbol: 'EURUSD',
      source: 'oanda',
      account: 'p',
    });
    expect(gone.room).toBe(a.room);
    expect(bridge.status().subscriptions).toEqual([
      expect.objectContaining({ symbol: 'EURUSD', connection: 'ctrader:ic' }),
    ]);
  });

  it("keeps the room while another of the socket's streams resolved to it", async () => {
    const { bridge, ibClient } = makeBridge();
    ibClient.answer = { source: 'oanda', account: 'p' };
    await bridge.subscribe('s1', { symbol: 'EURUSD' });
    await bridge.subscribe('s1', { symbol: 'EURUSD', source: 'oanda', account: 'p' });
    expect((await bridge.unsubscribe('s1', { symbol: 'EURUSD' })).room).toBeNull();
    const last = await bridge.unsubscribe('s1', {
      symbol: 'EURUSD',
      source: 'oanda',
      account: 'p',
    });
    expect(last.room).toBe('market-data:oanda:p:EURUSD');
  });

  it('passes the chosen connection through, and drops a name that is not plain', async () => {
    const { bridge, ibClient } = makeBridge();
    await bridge.subscribe('sock-1', { symbol: 'eurusd', source: 'oanda', account: 'practice' });
    await bridge.subscribe('sock-2', { symbol: 'GBPUSD', source: 'OANDA; drop', account: '../x' });
    expect(ibClient.subscribed[0]).toMatchObject({
      symbol: 'EURUSD',
      source: 'oanda',
      account: 'practice',
    });
    expect(ibClient.subscribed[1]).toMatchObject({ source: undefined, account: undefined });
  });

  it('refcounts multiple sockets for the same symbol without re-calling IB', async () => {
    const { bridge, ibClient } = makeBridge();
    await bridge.subscribe('sock-1', { symbol: 'MSFT' });
    const r = await bridge.subscribe('sock-2', { symbol: 'MSFT' });
    expect(ibClient.subscribed).toHaveLength(1);
    expect(r.refCount).toBe(2);
  });

  it('is idempotent for the same socket', async () => {
    const { bridge, ibClient } = makeBridge();
    await bridge.subscribe('sock-1', { symbol: 'MSFT' });
    const r = await bridge.subscribe('sock-1', { symbol: 'MSFT' });
    expect(ibClient.subscribed).toHaveLength(1);
    expect(r.refCount).toBe(1);
  });

  it('rolls back bookkeeping if the IB subscribe call throws', async () => {
    const { bridge, ibClient } = makeBridge();
    ibClient.throwOnSubscribe = true;
    await expect(bridge.subscribe('sock-1', { symbol: 'MSFT' })).rejects.toThrow(/IB unreachable/);
    // No leaked state — a second call must reach the IB client again.
    ibClient.throwOnSubscribe = false;
    await bridge.subscribe('sock-1', { symbol: 'MSFT' });
    expect(ibClient.subscribed).toHaveLength(1);
  });

  it('upper-cases and trims the symbol', async () => {
    const { bridge, ibClient } = makeBridge();
    const r = await bridge.subscribe('s', { symbol: '  msft  ' });
    expect(r.symbol).toBe('MSFT');
    expect(ibClient.subscribed[0]).toMatchObject({ symbol: 'MSFT' });
  });

  it('rejects empty symbols', async () => {
    const { bridge } = makeBridge();
    await expect(bridge.subscribe('s', { symbol: '   ' })).rejects.toThrow(/symbol/);
  });
});

describe('StreamingBridge.unsubscribe', () => {
  it('decrements without IB-unsubscribe while other sockets hold the symbol', async () => {
    const { bridge, ibClient } = makeBridge();
    await bridge.subscribe('a', { symbol: 'MSFT' });
    await bridge.subscribe('b', { symbol: 'MSFT' });
    const r = await bridge.unsubscribe('a', { symbol: 'MSFT' });
    expect(r.refCount).toBe(1);
    expect(ibClient.unsubscribed).toEqual([]);
  });

  it('calls IB unsubscribe when the last socket leaves', async () => {
    const { bridge, ibClient } = makeBridge();
    await bridge.subscribe('a', { symbol: 'MSFT' });
    const r = await bridge.unsubscribe('a', { symbol: 'MSFT' });
    expect(r.refCount).toBe(0);
    expect(ibClient.unsubscribed).toEqual([{ symbol: 'MSFT', source: 'ib', account: 'default' }]);
  });

  it('returns a no-op shape for unknown sockets / symbols', async () => {
    const { bridge, ibClient } = makeBridge();
    const r = await bridge.unsubscribe('unknown', { symbol: 'MSFT' });
    expect(r.refCount).toBe(0);
    expect(ibClient.unsubscribed).toEqual([]);
  });

  it('releaseSocket() drops everything that socket holds', async () => {
    const { bridge, ibClient } = makeBridge();
    await bridge.subscribe('a', { symbol: 'MSFT' });
    await bridge.subscribe('a', { symbol: 'AAPL' });
    await bridge.releaseSocket('a');
    expect(ibClient.unsubscribed.map((p) => p.symbol).sort()).toEqual(['AAPL', 'MSFT']);
  });
});

// ---------------------------------------------------------------------------
// Tick fan-out
// ---------------------------------------------------------------------------

describe('handleTickMessage', () => {
  it('emits to the matching room when a socket is listening', () => {
    const { bridge, io } = makeBridge();
    io.joinRoom('market-data:alpaca:paper:MSFT', 'sock-1');
    bridge.handleTickMessage(
      JSON.stringify({
        symbol: 'MSFT',
        platform: 'alpaca',
        account: 'paper',
        type: 'tick',
        tick_type: 'LAST',
        tick_type_code: 4,
        price: 380.25,
        size: null,
        value: 380.25,
        timestamp: 1.0,
      }),
      'marketdata:tick:alpaca:paper:MSFT'
    );
    const room = io.rooms.get('market-data:alpaca:paper:MSFT');
    expect(room?.emitted).toHaveLength(1);
    expect(room?.emitted[0].event).toBe('market-data-update');
    expect((room?.emitted[0].payload as any).price).toBe(380.25);
    expect(bridge.ticksReceived).toBe(1);
    expect(bridge.ticksForwarded).toBe(1);
  });

  it('drops messages when no socket is listening', () => {
    const { bridge, io } = makeBridge();
    bridge.handleTickMessage(
      JSON.stringify({ symbol: 'MSFT', tick_type: 'LAST', value: 1, timestamp: 0 }),
      'marketdata:tick:ib:default:MSFT'
    );
    expect(io.rooms.get('market-data:ib:default:MSFT')).toBeUndefined();
    expect(bridge.ticksDropped).toBe(1);
  });

  it('routes by the payload, so a symbol may contain a colon', () => {
    const { bridge, io } = makeBridge();
    io.joinRoom('market-data:ibweb:default:BHP:ASX', 'sock-1');
    bridge.handleTickMessage(
      JSON.stringify({
        symbol: 'BHP:ASX',
        platform: 'ibweb',
        account: 'default',
        tick_type: 'LAST',
        value: 1,
        timestamp: 0,
      }),
      'marketdata:tick:ibweb:default:BHP:ASX'
    );
    expect(io.rooms.get('market-data:ibweb:default:BHP:ASX')?.emitted).toHaveLength(1);
  });

  it('drops a payload with no symbol', () => {
    const { bridge } = makeBridge();
    bridge.handleTickMessage(JSON.stringify({ tick_type: 'LAST', value: 1 }), 'marketdata:tick:x');
    expect(bridge.ticksDropped).toBe(1);
  });

  it('drops invalid JSON without throwing', () => {
    const { bridge } = makeBridge();
    expect(() => bridge.handleTickMessage('not-json', 'marketdata:tick:MSFT')).not.toThrow();
    expect(bridge.ticksDropped).toBe(1);
  });
});

describe('handleStatusMessage', () => {
  it('routes per-symbol status payloads to the rooms streaming that symbol', async () => {
    const { bridge, io } = makeBridge();
    await bridge.subscribe('sock-1', { symbol: 'MSFT' });
    bridge.handleStatusMessage(JSON.stringify({ event: 'stopped', symbol: 'MSFT' }));
    const room = io.rooms.get('market-data:ib:default:MSFT');
    expect(room?.emitted[0].event).toBe('market-data-status');
    expect((room?.emitted[0].payload as any).event).toBe('stopped');
  });

  it('broadcasts global status payloads when no symbol is attached', () => {
    const { bridge, io } = makeBridge();
    bridge.handleStatusMessage(JSON.stringify({ event: 'bridge-ready' }));
    const global = io.rooms.get('__global__');
    expect(global?.emitted[0].event).toBe('market-data-status');
  });

  it('ignores garbage payloads', () => {
    const { bridge } = makeBridge();
    expect(() => bridge.handleStatusMessage('not-json')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Status diagnostics
// ---------------------------------------------------------------------------

describe('status()', () => {
  it('reports per-symbol refcounts and global totals', async () => {
    const { bridge } = makeBridge();
    await bridge.start();
    await bridge.subscribe('a', { symbol: 'MSFT' });
    await bridge.subscribe('b', { symbol: 'MSFT' });
    await bridge.subscribe('a', { symbol: 'AAPL' });
    const s = bridge.status();
    expect(s.subscriptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: 'AAPL', refCount: 1 }),
        expect.objectContaining({ symbol: 'MSFT', refCount: 2 }),
      ])
    );
    expect(s.totals.ticks_received).toBe(0);
    expect(s.connected).toBe(true);
  });
});
