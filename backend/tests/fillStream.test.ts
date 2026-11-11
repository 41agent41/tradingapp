/**
 * FillStream tests: fills the broker service publishes on Redis are handed to
 * the store step, on the connection the channel names. Redis is a stand-in.
 */
import { FILL_PATTERN, FillStream, connectionOfChannel } from '../src/services/fillStream.js';

function fakeRedis(overrides: Record<string, unknown> = {}) {
  const client = {
    listener: null as null | ((message: string, channel: string) => void),
    pattern: '',
    connect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn().mockResolvedValue(undefined),
    pSubscribe: jest.fn(async (pattern: string, listener: any) => {
      client.pattern = pattern;
      client.listener = listener;
    }),
    on: jest.fn(),
    ...overrides,
  };
  return client;
}

const fill = { exec_id: '12', symbol: 'EUR.USD', side: 'BUY', quantity: 1000, price: 1.1 };

describe('connectionOfChannel', () => {
  it('reads the broker and account from a fill channel', () => {
    expect(connectionOfChannel('executions:fill:oanda:001-004-123-001')).toEqual({
      broker: 'oanda',
      brokerAccount: '001-004-123-001',
    });
    expect(connectionOfChannel('executions:fill:mt5:a:b')).toEqual({
      broker: 'mt5',
      brokerAccount: 'a:b',
    });
  });

  it('refuses a channel that names no connection', () => {
    expect(connectionOfChannel('marketdata:tick:oanda:001:EURUSD')).toBeNull();
    expect(connectionOfChannel('executions:fill:oanda')).toBeNull();
    expect(connectionOfChannel('executions:fill:oanda:')).toBeNull();
    expect(connectionOfChannel('executions:fill::001')).toBeNull();
  });
});

describe('FillStream', () => {
  it('listens on the fill channels and stores each fill on its connection', async () => {
    const redis = fakeRedis();
    const ingest = jest.fn().mockResolvedValue(1);
    const stream = new FillStream({ ingest, redisFactory: () => redis as any, now: () => 0 });

    await stream.start();
    expect(redis.pSubscribe).toHaveBeenCalledWith(FILL_PATTERN, expect.any(Function));
    expect(stream.status().listening).toBe(true);

    await stream.handle(JSON.stringify(fill), 'executions:fill:oanda:001');

    expect(ingest).toHaveBeenCalledWith({ broker: 'oanda', brokerAccount: '001' }, [fill]);
    expect(stream.status()).toMatchObject({ received: 1, stored: 1, ignored: 0 });
  });

  it('ignores a message that is not a fill', async () => {
    const ingest = jest.fn().mockResolvedValue(1);
    const stream = new FillStream({ ingest, redisFactory: () => fakeRedis() as any });

    await stream.handle('not json', 'executions:fill:oanda:001');
    await stream.handle('[1]', 'executions:fill:oanda:001');
    await stream.handle(JSON.stringify({ symbol: 'EUR.USD' }), 'executions:fill:oanda:001');
    await stream.handle(JSON.stringify(fill), 'executions:fill:oanda');

    expect(ingest).not.toHaveBeenCalled();
    expect(stream.status()).toMatchObject({ received: 4, stored: 0, ignored: 4 });
  });

  it('stores fills one at a time, in the order they arrived', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const first = new Promise<void>((resolve) => (release = resolve));
    const ingest = jest.fn(async (_c: unknown, rows: any[]) => {
      if (rows[0].exec_id === '1') await first;
      order.push(rows[0].exec_id);
      return 1;
    });
    const stream = new FillStream({ ingest, redisFactory: () => fakeRedis() as any });

    void stream.handle(JSON.stringify({ ...fill, exec_id: '1' }), 'executions:fill:oanda:001');
    const second = stream.handle(
      JSON.stringify({ ...fill, exec_id: '2' }),
      'executions:fill:oanda:001'
    );
    release();
    await second;

    expect(order).toEqual(['1', '2']);
  });

  it('keeps going when a fill cannot be stored', async () => {
    const ingest = jest.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(1);
    const stream = new FillStream({ ingest, redisFactory: () => fakeRedis() as any });

    await stream.handle(JSON.stringify(fill), 'executions:fill:oanda:001');
    await stream.handle(JSON.stringify(fill), 'executions:fill:oanda:001');

    expect(stream.status()).toMatchObject({ stored: 1, last_error: 'db down' });
  });

  it('reports a Redis it cannot reach and stays not listening', async () => {
    const redis = fakeRedis({ connect: jest.fn().mockRejectedValue(new Error('no redis')) });
    const stream = new FillStream({ ingest: jest.fn(), redisFactory: () => redis as any });

    await stream.start();

    expect(stream.status()).toMatchObject({ listening: false, last_error: 'no redis' });
  });

  it('stops listening, and starting twice opens one connection', async () => {
    const redis = fakeRedis();
    const factory = jest.fn(() => redis as any);
    const stream = new FillStream({ ingest: jest.fn(), redisFactory: factory });

    await Promise.all([stream.start(), stream.start()]);
    await stream.start();
    expect(factory).toHaveBeenCalledTimes(1);

    await stream.stop();
    expect(redis.quit).toHaveBeenCalled();
    expect(stream.status().listening).toBe(false);
  });
});

describe('FillStream — a broker that only says something traded', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('polls that connection once, shortly after, however many events arrive', async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    const stream = new FillStream({ ingest: jest.fn(), refresh, refreshDelayMs: 1500 });

    stream.handleChanged('executions:changed:ig:demo');
    stream.handleChanged('executions:changed:ig:demo');
    stream.handleChanged('executions:changed:ig:live');
    expect(refresh).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1500);

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledWith({ broker: 'ig', brokerAccount: 'demo' });
    expect(refresh).toHaveBeenCalledWith({ broker: 'ig', brokerAccount: 'live' });

    stream.handleChanged('executions:changed:ig:demo');
    await jest.advanceTimersByTimeAsync(1500);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(stream.status()).toMatchObject({ received: 4, refreshes: 3 });
  });

  it('ignores a channel that names no connection, and drops pending polls on stop', async () => {
    const refresh = jest.fn().mockResolvedValue(undefined);
    const stream = new FillStream({ ingest: jest.fn(), refresh });

    stream.handleChanged('executions:changed:ig');
    stream.handleChanged('executions:changed:ig:demo');
    await stream.stop();
    await jest.advanceTimersByTimeAsync(5000);

    expect(refresh).not.toHaveBeenCalled();
    expect(stream.status().ignored).toBe(1);
  });

  it('listens on both patterns', async () => {
    jest.useRealTimers();
    const patterns: string[] = [];
    const redis = fakeRedis({
      pSubscribe: jest.fn(async (pattern: string) => {
        patterns.push(pattern);
      }),
    });
    const stream = new FillStream({ ingest: jest.fn(), redisFactory: () => redis as any });
    await stream.start();
    expect(patterns).toEqual(['executions:fill:*', 'executions:changed:*']);
  });
});
