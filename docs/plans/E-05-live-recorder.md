# Design record: live recorder and tick storage (E-05, E-06)

Status: **proposed**, waiting for Sean's sign-off. Nothing below is built yet.
Parent plan: [ENHANCEMENT_PLAN.md](ENHANCEMENT_PLAN.md), "Streaming, storage,
replay and backtesting", steps 2 to 5.

## 1. Goal

Every instrument marked for recording gets 1-minute bars stored from the live
stream, whether or not a browser is open. It can also get its raw quotes
stored for a set number of days. Backtests (E-02), replay (E-04) and the
nightly reconcile (E-07) then work from the database.

Out of scope here: bid and ask bars (E-15), broker-built live bars (E-11,
E-12, E-13, E-18), higher timeframes from 1 minute (E-08), and the reconcile
itself (E-07). Section 9 lists the interfaces this design leaves for them.

## 2. What exists today (verified in the code)

| Fact | Where |
| --- | --- |
| Ticks go out on Redis pub/sub, channel `marketdata:tick:<SYMBOL>`, one message per tick type (`BID`, `ASK`, `LAST`, sizes). A message lost while nothing listens is gone. | `broker_service/streaming.py` `_publish`, `publish_tick` |
| The message has a `source` (the platform) but no account, and its `timestamp` is the broker service's clock, not the broker's. | `streaming.py` `publish_tick`; `venue_streaming.py` `publish` |
| Subscriptions are keyed by symbol alone, across all connections, so EURUSD at OANDA and EURUSD at IC Markets cannot both stream. | `venue_streaming.py` `VenueStreamer._subs`; `routes/streaming.py` `stream_subscribe` |
| Subscriptions are reference counts held by the backend bridge for browser sockets. When the last tab closes, the stream stops. A broker service restart forgets them all. | `backend/src/services/streamingBridge.ts`; `venue_streaming.py` |
| IG, Alpaca, cTrader (except spots), MT5 and others without `stream_prices` are polled every `STREAM_POLL_SECONDS` (default 2). | `venue_streaming.py` `_Worker._poll_once` |
| `tick_data` exists as a hypertable with a 30-day retention policy, but no code writes to it or reads it. | `timescaledb-schema.sql`; grep finds no other use |
| `candlestick_data` is unique on `(contract_id, timestamp, timeframe)` and has no column saying where a bar came from. | `timescaledb-schema.sql` |
| A contract belongs to one connection (`contracts.broker`, `contracts.broker_account`). | `timescaledb-schema.sql` |
| The database image in `docker-compose.db.yml` is TimescaleDB 2.17.2 on PostgreSQL 15. The Proxmox install takes TimescaleDB from its apt repository. | `docker-compose.db.yml`, INSTALL step 1 |

## 3. Decisions

Each decision gives the choice made, and the main alternative turned down.

### D1. Transport: one Redis Stream, written alongside pub/sub

- The broker service adds every quote to the Redis Stream `marketdata:quotes`
  with `XADD marketdata:quotes MAXLEN ~ <TICK_STREAM_MAXLEN> * <fields>`.
- It keeps publishing to `marketdata:tick:<SYMBOL>` exactly as today, so the
  live charts and `streamingBridge.ts` do not change.
- Only quotes for a recorded subscription go to the stream (D3 says which).
  Browser-only subscriptions stay on pub/sub alone.
- `TICK_STREAM_MAXLEN` is a new setting on Settings > Schedulers and data.
  It defaults to 200000 (about 40 MB of Redis memory, and about 5 hours at 10
  quotes a second). It is the window a stopped backend can catch up from.

Why: a consumer group gives at-least-once delivery across backend restarts,
which pub/sub cannot. One stream rather than one per symbol keeps to a single
`XREADGROUP` call and a single consumer group. Rejected: Kafka or NATS. A new
service on the LAN host is not justified at this volume.

### D2. The stream entry is a quote snapshot, not a tick type

Each entry has these fields, all strings, as Redis stores them:

| Field | Meaning |
| --- | --- |
| `v` | Format version, `1`. |
| `platform`, `account` | The connection, such as `oanda` and `practice`. |
| `symbol` | Upper case, as subscribed. |
| `bid`, `ask`, `last` | Latest values; empty when the broker has not sent one. |
| `last_size` | Size of the last trade; empty when unknown. |
| `ts` | Event time in epoch milliseconds: the broker's own quote time when the adapter gives one (OANDA `time`, cTrader spot timestamp), otherwise the receive time. |
| `recv_ts` | Receive time in the broker service, epoch milliseconds. |

- IB sends bid, ask and last as separate callbacks. The IB path keeps the
  latest values per symbol and adds a snapshot each time bid, ask or last
  changes. Size-only callbacks do not add one.
- Venue workers already have bid, ask and last together, so they add one
  snapshot per update.

Why: bars and stored ticks both need bid and ask at the same instant. Merging
per-type messages in the backend would repeat work for every broker.

### D3. Subscriptions: per connection, and held, not counted, by the recorder

- Venue subscriptions become keyed by `(platform, account, symbol)` instead of
  symbol alone, in `VenueStreamer` and in `StreamingManager` (IB). The
  pub/sub channel stays `marketdata:tick:<SYMBOL>`. When two connections
  stream the same symbol, both publish on it. The chart already follows only
  its own connection's symbol, and E-21 makes the channel per connection.
- New endpoint `PUT /market-data/stream/recorded` takes the full list of
  recorded instruments: `[{platform, account, symbol, secType, exchange,
  currency}]`. The broker service replaces its recorded set with that list,
  starts what is new, and releases what is gone.
- A recorded hold is separate from the browser reference counts. A symbol
  streams while either has it, and only recorded symbols are written to the
  stream (D1).
- The backend sends that list when it starts, whenever recording settings
  change, and every 60 seconds. Replacing the whole set makes every call
  safe to repeat. A broker service restart is repaired within a minute, with
  no state to rebuild.

Why: reference counts drift when a call is lost or a process restarts, so a
desired set re-sent on a timer heals itself. Rejected: having the recorder
take browser-style references, because a missed unsubscribe would leak a
stream for good.

### D4. What is recorded: two flags on the collection table

Migration `006_live_recorder.sql` adds two columns to `data_collection_config`:

- `record_live BOOLEAN NOT NULL DEFAULT FALSE`
- `record_ticks BOOLEAN NOT NULL DEFAULT FALSE`

A contract is recorded when any of its enabled rows has `record_live`. Its
quotes are stored when any enabled row has `record_ticks`, and storing ticks
needs `record_live` too. On Settings > Schedulers and data, each row gets two
checkboxes, **Record live** and **Store ticks**. Recording is per contract,
so ticking either box on one timeframe row of a contract ticks it on every
row of that contract. The form says so.

Global switch: `RECORDER_ENABLED`, a new setting that defaults to `true`.
With it off, the backend sends an empty recorded set and stops reading the
stream.

### D5. Building 1-minute bars in the backend

- **Price:** mid, `(bid + ask) / 2` when both are present. Otherwise `last`.
  An entry with neither is skipped. US stocks on Alpaca and IB have bid and
  ask, so they get mid bars too. Trade-price bars come with broker bars in
  E-13 and E-18.
- **Bucket:** the UTC minute of `ts`.
- **Fields:**
  - `open` is the first price in the minute, `high` the highest, `low` the
    lowest, and `close` the last.
  - `count` is the number of quotes.
  - `volume` is the sum of `last_size` when the broker gives sizes, else 0.
  - `timeframe` is `1min`, the existing name.
- **Writing:** the forming bar of every recorded contract is upserted every
  5 seconds, and once more when the minute ends. A crash loses at most about
  5 seconds, and the next flush covers it again because entries are
  acknowledged only after they are written (D7).
- **Merge rule:** the upsert merges, so a re-delivered entry cannot spoil a
  bar:

  ```sql
  INSERT INTO candlestick_data (contract_id, timestamp, timeframe, open, high, low, close, volume, count, source)
  VALUES (...,'1min', ..., 'stream')
  ON CONFLICT (contract_id, timestamp, timeframe) DO UPDATE SET
    high   = GREATEST(candlestick_data.high, EXCLUDED.high),
    low    = LEAST(candlestick_data.low, EXCLUDED.low),
    close  = EXCLUDED.close,
    volume = GREATEST(candlestick_data.volume, EXCLUDED.volume),
    count  = GREATEST(candlestick_data.count, EXCLUDED.count)
  WHERE candlestick_data.source = 'stream';
  ```

  `open` is never changed by a merge. `volume` and `count` take the larger
  value, so replaying the same entries cannot double them.
- **Late entries:** an entry for a minute already closed is merged by the
  same upsert. Entries older than 10 minutes are counted and dropped,
  because they would only make a closed bar worse.
- **Precedence:** the `WHERE` clause means a stream bar never replaces a
  broker bar. Migration 006 adds
  `source VARCHAR(8) NOT NULL DEFAULT 'broker'` to `candlestick_data`, so
  every existing bar and every backfill bar is `broker`. The backfill upsert
  changes to set `source = 'broker'` and to always overwrite, so broker
  history replaces stream bars. That is what E-07's nightly job relies on.

Why in the backend: only the backend writes to the database, and the plan
keeps that split. Rejected: building bars in the broker service, which would
need a database writer there.

### D6. Storing quotes (E-06)

- A new hypertable, `quote_ticks`, is created by migration 006:

  ```sql
  CREATE TABLE quote_ticks (
      contract_id INTEGER NOT NULL,
      ts          TIMESTAMPTZ NOT NULL,
      bid         DOUBLE PRECISION,
      ask         DOUBLE PRECISION,
      last        DOUBLE PRECISION,
      last_size   DOUBLE PRECISION,
      recv_ts     TIMESTAMPTZ NOT NULL
  );
  SELECT create_hypertable('quote_ticks', 'ts', chunk_time_interval => INTERVAL '1 day');
  CREATE INDEX ON quote_ticks (contract_id, ts DESC);
  ```

  It has no unique key, because the same instant can carry two quotes. A
  re-delivered entry can therefore store a duplicate row. Replay and
  backtests tolerate that, and it happens only after a crash.
- Writes are batched, with one multi-row `INSERT` per second or per 1000
  rows, whichever comes first.
- **Compression after 1 day:**
  `ALTER TABLE quote_ticks SET (timescaledb.compress, timescaledb.compress_segmentby = 'contract_id', timescaledb.compress_orderby = 'ts')`,
  then `add_compression_policy('quote_ticks', INTERVAL '1 day')`.
- **Retention:** `TICK_RETENTION_DAYS` is a new setting that defaults to 30.
  `cleanOldData` (`marketDataService.ts`) gains
  `drop_chunks('quote_ticks', older_than => <n> days)`. Today `cleanOldData`
  runs only when called through `routes/marketData/database.ts`, so this
  item adds a daily run at 03:30 UTC to the backend's scheduler. No
  TimescaleDB retention policy is used, so the setting takes effect without
  a migration, as E-01 decided for bars.
- **The old `tick_data` table:** migration 006 drops it only when it has no
  rows (`DO $$ ... IF NOT EXISTS (SELECT 1 FROM tick_data) THEN DROP TABLE tick_data; END IF; $$`).
  It has never been written to, but a database somebody filled by hand is
  left alone.
- **Bars compressed after 7 days:** set up the same way, with `segmentby`
  `contract_id, timeframe` and `orderby timestamp`. TimescaleDB 2.11 and
  later accept `INSERT ... ON CONFLICT` into compressed chunks, which the
  backfill needs for deep history. The migration checks
  `extversion >= '2.11'` and skips bar compression, with a notice, on an
  older install. A DB test inserts and upserts into a compressed chunk to
  prove it. If upserts into compressed chunks prove too slow for deep
  backfill, the fallback is to compress after 30 days. That is a one-line
  change to the policy.

### D7. Reading the stream: one consumer, acknowledged after the write

- Consumer group `recorder` on `marketdata:quotes`. It is created at start
  with `XGROUP CREATE marketdata:quotes recorder $ MKSTREAM`, and the
  `BUSYGROUP` reply is ignored. The consumer name is `backend`, because one
  backend runs per install.
- On start the recorder first reads its pending entries (ID `0`), then new
  ones (`>`), with `XREADGROUP ... COUNT 1000 BLOCK 1000`.
- An entry is acknowledged (`XACK`) only after both its bar upsert and its
  tick insert have committed. Delivery is therefore at least once, and D5's
  merge rule and D6's tolerance make a repeat harmless.
- If the database is down, the recorder stops acknowledging and retries every
  5 seconds. Entries wait in the stream up to `TICK_STREAM_MAXLEN`. After
  that the oldest are trimmed, and those minutes show as gaps for E-07 to
  fill from broker history.
- The recorder uses its own Redis connection, separate from the pub/sub
  subscriber in `streamingBridge.ts` and from `cacheService`.

### D8. Polled brokers give approximate bars

A broker polled every 2 seconds misses any high or low between polls, so
those stream bars are approximate. This is accepted because:

- bars are marked `source = 'stream'`, and E-07 replaces them with the
  broker's own each night;
- E-11 (IG) and E-13 (Alpaca) replace polling with true streams.

The Data collection table shows each recorded contract's feed mode
(`streamed` or `polled every N s`), so this is visible, not hidden.

## 4. Status and visibility

- `GET /api/market-data/recorder/status` returns:
  - whether the recorder is on, and the stream length and lag (entries not
    yet acknowledged);
  - per contract: the last quote time, the last bar written, quotes in the
    last minute, the feed mode, and the last error;
  - totals of entries dropped as too late or invalid.
- Settings > Schedulers and data shows that status in the collection table.
- The `doctor` command and `/health` report the recorder as `degraded` when
  lag exceeds 60 seconds, or when a recorded contract has had no quote for 5
  minutes on a weekday. FX weekends and stock hours make that a warning, not
  an alert, until E-26 adds trading-hours awareness.
- Prometheus metrics in the backend:
  - `recorder_entries_total{result="written|late|invalid"}`
  - `recorder_lag_entries`
  - `recorder_flush_seconds`

## 5. Settings added

| Key | Default | Where | Meaning |
| --- | --- | --- | --- |
| `RECORDER_ENABLED` | `true` | Settings > Schedulers and data | Master switch for recording. |
| `TICK_STREAM_MAXLEN` | `200000` | Settings > Schedulers and data | Entries kept in the Redis Stream; the catch-up window. |
| `TICK_RETENTION_DAYS` | `30` | Settings > Schedulers and data | Days of stored quotes kept. |

The broker service reads `TICK_STREAM_MAXLEN` through the settings it already
receives from the backend (`brokerSync.ts`). It is not another `.env` line.

## 6. Build order (one commit each, all in one PR)

1. **Broker service, subscriptions.** Key venue and IB subscriptions by
   connection (D3), and add the recorded set and its endpoint.
   Tests: two connections streaming one symbol, and repeated identical
   `PUT`s changing nothing.
2. **Broker service, stream.** Add the quote snapshot and `XADD` (D1, D2),
   including IB merging per-type callbacks into snapshots.
   Tests: entry fields, `MAXLEN` passed, nothing added for browser-only
   symbols.
3. **Migration 006.** Add the flags, `candlestick_data.source`,
   `quote_ticks` and compression, and drop an empty `tick_data`. The
   backfill upsert sets `source = 'broker'`.
   DB tests: an upsert into a compressed chunk, and stream-never-beats-broker.
4. **Backend recorder.** Add the consumer group, bar builder, tick batches,
   status endpoint, metrics and the 60-second resend of the recorded set.
   Unit tests with a fake Redis and a fake database. These cover redelivery,
   late entries, a minute rollover, the database being down, and a broker
   bar arriving first.
5. **Settings UI.** Add the two checkboxes, feed mode and recorder status to
   the collection table, and the three settings.
6. **Clean-up and docs.** `cleanOldData` drops `quote_ticks` chunks and
   runs daily.
   FEATURES, OPERATIONS (the recorder, its status, what to do when lag
   grows), INSTALL step 5 (tick the boxes) and DEVELOPMENT (data flow
   diagram).
7. **End-to-end check.** In the e2e job, the OANDA practice stream is
   replaced by a fake adapter publishing known quotes. The job checks that
   the expected 1-minute bars and quote rows appear in TimescaleDB.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Redis memory grows with `MAXLEN` | Approximate trimming (`~`); the default is about 40 MB; the setting can lower it. |
| Upserts into compressed chunks are slow for deep backfill | DB test measures it; fallback is compressing after 30 days (D6). |
| Clock skew between broker time and receive time | `ts` prefers broker time; `recv_ts` is kept so skew can be measured. |
| Two connections on one symbol confuse the live chart's pub/sub channel | Only for a user streaming the same symbol from two firms at once, until E-21 makes channels per connection. |
| The recorder falls behind on a busy instrument set | Batches of 1000 and one flush every 5 seconds per contract. Lag is shown and alerted (section 4). |

## 8. Questions for Sean

Defaults are proposed. Say if any should differ.

1. Is a 30-day default for stored quotes right, given about 5 GB for ten FX
   pairs (parent plan, storage estimate)?
2. Should **Record live** be ticked automatically for every collection row
   that is already enabled, or left off until chosen? The proposal is to
   leave it off, so the upgrade changes nothing on its own.

## 9. Interfaces left for later items

- **E-07:** finds stream bars with `WHERE source = 'stream'` and overwrites
  them through the broker-wins upsert.
- **E-08:** continuous aggregates read `timeframe = '1min'` whatever the
  source.
- **E-11, E-12, E-13, E-18:** a broker's own live bars are written with
  `source = 'stream'` through the same upsert. The recorder skips building a
  bar for a contract whose adapter says it streams bars (an E-19
  capability).
- **E-15:** bid and ask bars can be rebuilt from `quote_ticks` for the
  retention window. Older data comes from the broker (`price=BA`).
- **E-20:** the recorder emits each forming bar on Socket.IO
  (`bar-update`, room `bars:<contract_id>`), so a live chart moves its last
  candle without building bars itself.
