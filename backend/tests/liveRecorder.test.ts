/**
 * The live recorder with a fake Redis Stream, a fake database and a fake
 * broker service. The SQL runs against a real database in
 * liveRecorder.db.test.ts.
 */
import {
  FLUSH_MS,
  LiveRecorder,
  MAX_WAITING,
  basisPrice,
  compareIds,
  type Flush,
  type RecordTarget,
  type RecordedAnswer,
  type RecorderDeps,
  type StreamEntry,
} from '../src/services/liveRecorder.js';
import { msUntilUtc } from '../src/services/dailyJob.js';

// 12:00:00 UTC, the start of a minute.
const T0 = Date.parse('2026-11-10T12:00:00Z');
const MIN = 60_000;

const EUR: RecordTarget = {
  contractId: 7,
  platform: 'oanda',
  account: 'default',
  symbol: 'EUR_USD',
  secType: 'CASH',
  ticks: true,
};

function quote(
  seq: number,
  ts: number,
  values: { bid?: number; ask?: number; last?: number; size?: number },
  over: Record<string, string> = {}
): StreamEntry {
  const s = (v?: number) => (v === undefined ? '' : String(v));
  return {
    id: `${ts}-${seq}`,
    fields: {
      v: '1',
      platform: 'oanda',
      account: 'practice',
      symbol: 'EUR_USD',
      bid: s(values.bid),
      ask: s(values.ask),
      last: s(values.last),
      last_size: s(values.size),
      basis: 'mid',
      ts: String(ts),
      recv_ts: String(ts + 5),
      ...over,
    },
  };
}

/** A stream, a database and a clock the test controls. */
function world(targets: RecordTarget[] = [EUR]) {
  const state = {
    now: T0,
    stream: [] as StreamEntry[],
    cursor: null as string | null,
    bars: new Map<string, Flush['bars'][number] & { source: string }>(),
    ticks: [] as Flush['ticks'],
    flushes: [] as Flush[],
    dbDown: false,
    sent: [] as RecordTarget[][],
    reads: 0,
    targets,
    answer: null as RecordedAnswer | null,
  };
  const deps: RecorderDeps = {
    redis: () => ({
      connect: async () => undefined,
      read: async (id, count) => {
        state.reads++;
        return state.stream.filter((e) => compareIds(e.id, id) > 0).slice(0, count);
      },
      lastId: async () => state.stream[state.stream.length - 1]?.id ?? null,
      length: async () => state.stream.length,
      close: async () => undefined,
    }),
    targets: async () => state.targets,
    loadCursor: async () => {
      if (state.dbDown) throw new Error('database is down');
      return state.cursor;
    },
    loadBars: async (since) =>
      [...state.bars.values()].filter((b) => b.source === 'stream' && b.minute >= since),
    // All or nothing, as the transaction is; a broker bar is never replaced.
    flush: async (batch) => {
      if (state.dbDown) throw new Error('database is down');
      state.flushes.push(batch);
      for (const bar of batch.bars) {
        const k = `${bar.contractId}:${bar.minute}`;
        if (state.bars.get(k)?.source !== 'broker') state.bars.set(k, { ...bar, source: 'stream' });
      }
      state.ticks.push(...batch.ticks);
      state.cursor = batch.cursor;
    },
    sendRecorded: async (sent) => {
      state.sent.push(sent);
      return (
        state.answer ?? {
          resolved: sent.map((t) => ({
            platform: t.platform,
            account: t.account,
            symbol: t.symbol,
            stream_account: 'practice',
            mode: 'streamed',
          })),
          errors: [],
          poll_seconds: 2,
        }
      );
    },
    now: () => state.now,
    sleep: async () => undefined,
  };
  /** A recorder opened as `start()` would, without the background loop. */
  const open = async () => {
    const recorder = new LiveRecorder(deps, true);
    await (recorder as unknown as { open(): Promise<void> }).open();
    return recorder;
  };
  const bar = (minute: number, contractId = 7) => state.bars.get(`${contractId}:${minute}`);
  return { state, deps, open, bar };
}

describe('compareIds and basisPrice', () => {
  it('orders stream IDs by time, then sequence', () => {
    expect(compareIds('5-1', '5-2')).toBe(-1);
    expect(compareIds('10-0', '9-99')).toBe(1);
    expect(compareIds('1762776000000-3', '1762776000000-3')).toBe(0);
  });

  it.each([
    ['mid', 1.1, 1.3, null, 1.2],
    ['mid', 1.1, null, 1.2, null],
    ['bid', 1.1, 1.3, 1.2, 1.1],
    ['last', 1.1, 1.3, 1.25, 1.25],
    ['last', 1.1, 1.3, null, null],
    ['', 1.1, 1.3, 1.2, null],
  ])('%s of bid %s, ask %s, last %s is %s', (basis, bid, ask, last, want) => {
    const got = basisPrice(basis, bid, ask, last);
    if (want === null) expect(got).toBeNull();
    else expect(got).toBeCloseTo(want);
  });
});

describe('LiveRecorder', () => {
  it('builds a minute bar on the mid price and stores the quotes and cursor together', async () => {
    const w = world();
    const recorder = await w.open();
    w.state.stream.push(
      quote(1, T0 + 1_000, { bid: 1.1, ask: 1.2 }),
      quote(2, T0 + 2_000, { bid: 1.3, ask: 1.4 }),
      quote(3, T0 + 3_000, { bid: 1.0, ask: 1.1 }),
      quote(4, T0 + 4_000, { bid: 1.2, ask: 1.3 })
    );
    w.state.now = T0 + FLUSH_MS;
    await recorder.step();

    expect(w.state.flushes).toHaveLength(1);
    const bar = w.bar(T0)!;
    expect(bar.open).toBeCloseTo(1.15);
    expect(bar.high).toBeCloseTo(1.35);
    expect(bar.low).toBeCloseTo(1.05);
    expect(bar.close).toBeCloseTo(1.25);
    expect(bar).toMatchObject({ count: 4, volume: 0 });
    expect(w.state.ticks).toHaveLength(4);
    expect(w.state.ticks[0]).toMatchObject({ contractId: 7, ts: T0 + 1_000, bid: 1.1, ask: 1.2 });
    expect(w.state.cursor).toBe(`${T0 + 4_000}-4`);
  });

  it('matches quotes on the account the broker service resolved, not the stored one', async () => {
    const w = world();
    const recorder = await w.open();
    // 'default' on the contract is 'practice' in the stream; another account is not ours.
    recorder.apply(quote(1, T0, { bid: 1, ask: 2 }));
    recorder.apply(quote(2, T0, { bid: 1, ask: 2 }, { account: 'other' }));
    expect(recorder.status().totals).toMatchObject({ written: 1, unrecorded: 1 });
  });

  it('does not read before the broker service has taken the recorded set', async () => {
    const w = world();
    w.deps.sendRecorded = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    await expect(w.open()).rejects.toThrow(/recorded set/);
    expect(w.state.reads).toBe(0);
  });

  it('uses bid for a bid-basis broker and last, with volume, for a trade-basis one', async () => {
    const mt5: RecordTarget = {
      ...EUR,
      contractId: 8,
      platform: 'mt5',
      symbol: 'EURUSD',
      ticks: false,
    };
    const ib: RecordTarget = {
      ...EUR,
      contractId: 9,
      platform: 'ib',
      symbol: 'MSFT',
      ticks: false,
    };
    const w = world([mt5, ib]);
    const recorder = await w.open();
    const m = { platform: 'mt5', symbol: 'EURUSD', basis: 'bid' };
    const i = { platform: 'ib', symbol: 'MSFT', basis: 'last' };
    w.state.stream.push(
      quote(1, T0 + 1_000, { bid: 1.1, ask: 1.2 }, m),
      quote(2, T0 + 2_000, { bid: 1.15, ask: 1.25 }, m),
      quote(3, T0 + 3_000, { bid: 410, ask: 411, last: 410.5, size: 100 }, i),
      // Only the bid moved: the same trade again, so no more volume.
      quote(4, T0 + 4_000, { bid: 410.2, ask: 411, last: 410.5, size: 100 }, i),
      quote(5, T0 + 5_000, { bid: 410.2, ask: 411, last: 410.8, size: 50 }, i),
      // No trade yet: nothing to build a bar from.
      quote(6, T0 + 6_000, { bid: 1, ask: 2 }, { ...i, symbol: 'MSFT' })
    );
    w.state.now = T0 + 10_000;
    await recorder.step();

    expect(w.bar(T0, 8)).toMatchObject({ open: 1.1, close: 1.15, count: 2, volume: 0 });
    expect(w.bar(T0, 9)).toMatchObject({ open: 410.5, high: 410.8, close: 410.8, volume: 150 });
    expect(w.state.ticks).toHaveLength(0);
    expect(recorder.status().totals.invalid).toBe(1);
  });

  it('rolls over to a new bar at the minute and stores the finished one', async () => {
    const w = world();
    const recorder = await w.open();
    w.state.now = T0 + 56_000;
    await recorder.step();
    w.state.stream.push(quote(1, T0 + 58_000, { bid: 1, ask: 1.2 }));
    w.state.now = T0 + 58_500;
    const before = w.state.flushes.length;
    await recorder.step(); // not due: under 5 s and the same minute
    expect(w.state.flushes).toHaveLength(before);

    w.state.stream.push(quote(2, T0 + MIN + 100, { bid: 2, ask: 2.2 }));
    w.state.now = T0 + MIN + 200;
    await recorder.step(); // the minute ended
    expect(w.bar(T0)).toMatchObject({ close: 1.1, count: 1 });
    expect(w.bar(T0 + MIN)).toMatchObject({ open: 2.1, count: 1 });
  });

  it('lets a late quote move the high and low but not the close, and drops one past the window', async () => {
    const w = world();
    const recorder = await w.open();
    w.state.now = T0 + 3 * MIN;
    recorder.apply(quote(1, T0 + 30_000, { bid: 1.0, ask: 1.2 }));
    recorder.apply(quote(2, T0 + 10_000, { bid: 1.4, ask: 1.6 })); // earlier in the same minute
    recorder.apply(quote(3, T0 - 11 * MIN, { bid: 9, ask: 9 })); // older than the window
    await recorder.flush();

    expect(w.bar(T0)).toMatchObject({ high: 1.5, close: 1.1, count: 2 });
    expect(w.bar(T0 - 11 * MIN)).toBeUndefined();
    expect(recorder.status().totals.late).toBe(1);
    // A late quote is still a quote.
    expect(w.state.ticks).toHaveLength(3);
  });

  it('resumes after a crash with nothing stored twice and nothing lost', async () => {
    const w = world();
    const first = await w.open();
    w.state.stream.push(
      quote(1, T0 + 1_000, { bid: 1.0, ask: 1.2 }),
      quote(2, T0 + 2_000, { bid: 1.2, ask: 1.4 })
    );
    w.state.now = T0 + FLUSH_MS;
    await first.step();
    // Read but never stored: the process dies before the next flush.
    w.state.stream.push(quote(3, T0 + 6_000, { bid: 1.4, ask: 1.6 }));
    w.state.now = T0 + 6_500;
    await first.step();
    expect(w.state.ticks).toHaveLength(2);

    const second = await w.open();
    w.state.stream.push(quote(4, T0 + 8_000, { bid: 0.8, ask: 1.0 }));
    w.state.now = T0 + 12_000;
    await second.step();

    expect(w.state.ticks.map((t) => t.ts)).toEqual([1_000, 2_000, 6_000, 8_000].map((n) => T0 + n));
    const bar = w.bar(T0)!;
    expect(bar.open).toBeCloseTo(1.1);
    expect(bar.high).toBeCloseTo(1.5);
    expect(bar.low).toBeCloseTo(0.9);
    expect(bar.close).toBeCloseTo(0.9);
    expect(bar.count).toBe(4);
  });

  it('starts from new entries only when it has never stored a cursor', async () => {
    const w = world();
    w.state.stream.push(quote(1, T0 - 5_000, { bid: 5, ask: 5 }));
    const recorder = await w.open();
    w.state.stream.push(quote(2, T0 + 1_000, { bid: 1, ask: 1 }));
    w.state.now = T0 + FLUSH_MS;
    await recorder.step();
    expect(w.state.ticks.map((t) => t.bid)).toEqual([1]);
  });

  it('restarts from the newest entry when the cursor is ahead of the stream', async () => {
    const w = world();
    w.state.cursor = `${T0 + 10 * MIN}-0`; // Redis was emptied and its clock went back
    w.state.stream.push(quote(1, T0 - 1_000, { bid: 5, ask: 5 }));
    const recorder = await w.open();
    w.state.stream.push(quote(2, T0 + 1_000, { bid: 1, ask: 1 }));
    w.state.now = T0 + FLUSH_MS;
    await recorder.step();
    expect(w.state.ticks.map((t) => t.bid)).toEqual([1]);
    expect(w.state.cursor).toBe(`${T0 + 1_000}-2`);
  });

  it('keeps what it read while the database is down, retries, and stops reading when full', async () => {
    const w = world();
    const recorder = await w.open();
    w.state.stream.push(quote(1, T0 + 1_000, { bid: 1, ask: 1.2 }));
    w.state.dbDown = true;
    w.state.now = T0 + FLUSH_MS;
    await recorder.step();
    expect(w.state.cursor).toBeNull();
    expect(recorder.status()).toMatchObject({ degraded: true, last_error: 'database is down' });

    // Not retried before 5 seconds are up.
    w.state.dbDown = false;
    w.state.now += 1_000;
    await recorder.step();
    expect(w.state.flushes).toHaveLength(0);
    w.state.now += FLUSH_MS;
    await recorder.step();
    expect(w.state.ticks).toHaveLength(1);
    expect(w.state.cursor).toBe(`${T0 + 1_000}-1`);

    // With MAX_WAITING entries unstored it leaves the rest in Redis.
    (recorder as unknown as { waiting: number }).waiting = MAX_WAITING;
    const reads = w.state.reads;
    w.state.dbDown = true;
    w.state.now += 100;
    await recorder.step();
    expect(w.state.reads).toBe(reads);
  });

  it('never replaces a broker bar that arrived first', async () => {
    const w = world();
    w.state.bars.set(`7:${T0}`, {
      contractId: 7,
      minute: T0,
      open: 5,
      high: 5,
      low: 5,
      close: 5,
      volume: 9,
      count: 3,
      source: 'broker',
    });
    const recorder = await w.open();
    recorder.apply(quote(1, T0 + 1_000, { bid: 1, ask: 1.2 }));
    await recorder.flush();
    expect(w.bar(T0)).toMatchObject({ open: 5, source: 'broker' });
  });

  it('sends the whole recorded set, and an empty one when recording is off', async () => {
    const w = world();
    const on = new LiveRecorder(w.deps, true);
    await on.syncTargets();
    await on.syncTargets();
    expect(w.state.sent).toEqual([[EUR], [EUR]]);

    const off = new LiveRecorder(w.deps, false);
    await off.syncTargets();
    expect(w.state.sent[2]).toEqual([]);
  });

  it('reports each recorded instrument, its feed mode and why it is not streaming', async () => {
    const w = world();
    w.state.answer = {
      resolved: [
        {
          platform: 'oanda',
          account: 'default',
          symbol: 'EUR_USD',
          stream_account: 'practice',
          mode: 'polled',
        },
      ],
      errors: [
        { platform: 'oanda', account: 'practice', symbol: 'EUR_USD', error: 'no such instrument' },
      ],
      poll_seconds: 2,
    };
    const recorder = await w.open();
    expect(recorder.status()).toMatchObject({
      enabled: true,
      poll_seconds: 2,
      contracts: [
        {
          contract_id: 7,
          symbol: 'EUR_USD',
          ticks: true,
          mode: 'polled',
          error: 'no such instrument',
          last_quote: null,
        },
      ],
    });
  });

  it("stores a broker's own finished bar in place of the one built from quotes", async () => {
    const ct: RecordTarget = { ...EUR, contractId: 8, platform: 'ctrader', symbol: 'EURUSD' };
    const w = world([ct]);
    const recorder = await w.open();
    const c = { platform: 'ctrader', symbol: 'EURUSD', basis: 'bid' };
    const venueBar = (seq: number, minute: number, over: Record<string, string> = {}) => ({
      id: `${minute + MIN + 100}-${seq}`,
      fields: {
        v: '1',
        kind: 'bar',
        platform: 'ctrader',
        account: 'practice',
        symbol: 'EURUSD',
        open: '1.1',
        high: '1.25',
        low: '1.05',
        close: '1.2',
        volume: '42',
        ts: String(minute),
        recv_ts: String(minute + MIN + 100),
        ...over,
      },
    });
    w.state.stream.push(
      quote(1, T0 + 1_000, { bid: 1.1, ask: 1.2 }, c),
      quote(2, T0 + 30_000, { bid: 1.15, ask: 1.25 }, c)
    );
    w.state.now = T0 + 31_000;
    await recorder.step();
    // Built from the two quotes it saw.
    expect(w.bar(T0, 8)).toMatchObject({ open: 1.1, high: 1.15, low: 1.1, close: 1.15, count: 2 });

    w.state.stream.push(
      venueBar(3, T0),
      // A quote for that minute arriving afterwards is stored but changes nothing.
      quote(4, T0 + 59_000, { bid: 9, ask: 9.1 }, { ...c, ts: String(T0 + 59_000) }),
      venueBar(5, T0 + MIN, { open: 'soon' }),
      venueBar(6, T0 - 11 * MIN)
    );
    w.state.stream[3].id = `${T0 + MIN + 200}-4`;
    w.state.stream[4].id = `${T0 + MIN + 220}-5`;
    w.state.stream[5].id = `${T0 + MIN + 250}-6`;
    w.state.now = T0 + MIN + 300;
    await recorder.step();

    expect(w.bar(T0, 8)).toEqual({
      contractId: 8,
      minute: T0,
      open: 1.1,
      high: 1.25,
      low: 1.05,
      close: 1.2,
      volume: 42,
      count: 2,
      source: 'stream',
    });
    expect(w.state.ticks).toHaveLength(3);
    expect(w.bar(T0 + MIN, 8)).toBeUndefined();
    expect(w.bar(T0 - 11 * MIN, 8)).toBeUndefined();
    expect(recorder.status().totals).toMatchObject({ invalid: 1, late: 1 });
    expect(w.state.cursor).toBe(`${T0 + MIN + 250}-6`);
  });

  it('counts an entry it cannot read as invalid and moves on', async () => {
    const w = world();
    const recorder = await w.open();
    recorder.apply(quote(1, T0, { bid: 1, ask: 1 }, { v: '2' }));
    recorder.apply(quote(2, T0, { bid: 1, ask: 1 }, { ts: 'soon' }));
    expect(recorder.status().totals.invalid).toBe(2);
  });
});

describe('msUntilUtc', () => {
  it('gives the time to the next 03:30 UTC, today or tomorrow', () => {
    expect(msUntilUtc(3, 30, Date.parse('2026-11-10T03:00:00Z'))).toBe(30 * MIN);
    expect(msUntilUtc(3, 30, Date.parse('2026-11-10T03:30:00Z'))).toBe(24 * 60 * MIN);
    expect(msUntilUtc(3, 30, Date.parse('2026-11-10T12:00:00Z'))).toBe(15.5 * 60 * MIN);
  });
});
