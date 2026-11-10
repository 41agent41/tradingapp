# Design record: live recorder and tick storage (E-05, E-06)

Status: **built** (migration `006_live_recorder`), with the differences from
this design listed in section 10. Revision 2 changed four things after a second review: bars
follow each broker's own price basis (D5), database writes are exactly-once
through a stored cursor (D7), live channels become per connection (D3), and
unchanged quotes are not recorded (D2).
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

Why: a stream keeps entries until they are trimmed, so a restarted backend
can read what it missed, which pub/sub cannot give. One stream rather than
one per symbol means one read call and one cursor (D7). Rejected: Kafka or NATS. A new
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
| `basis` | `mid`, `bid` or `last`: the price the broker builds its own bars from (D5). |
| `ts` | Event time in epoch milliseconds: the broker's own quote time when the adapter gives one (OANDA `time`, cTrader spot timestamp), otherwise the receive time. |
| `recv_ts` | Receive time in the broker service, epoch milliseconds. |

- IB sends bid, ask and last as separate callbacks. The IB path keeps the
  latest values per symbol and adds a snapshot each time bid, ask or last
  changes. Size-only callbacks do not add one.
- Venue workers already have bid, ask and last together, so they add one
  snapshot per update.

- A snapshot whose bid, ask and last all equal the previous one for that
  subscription is not added. A broker polled every 2 seconds would otherwise
  fill the stream and the tick table with repeats. A minute with no change
  then has no bar, which is also what brokers' own histories do.

Why: bars and stored ticks both need bid and ask at the same instant. Merging
per-type messages in the backend would repeat work for every broker.

### D3. Subscriptions: per connection, and held, not counted, by the recorder

- Venue subscriptions become keyed by `(platform, account, symbol)` instead of
  symbol alone, in `VenueStreamer` and in `StreamingManager` (IB).
- The pub/sub channel becomes
  `marketdata:tick:<platform>:<account>:<SYMBOL>`, and the tick payload gains
  `platform` and `account`. `streamingBridge.ts` keys its reference counts
  and its Socket.IO rooms the same way (`market-data:<platform>:<account>:<SYMBOL>`),
  and the subscribe answer tells the chart which connection it got when it
  asked for "by broker priority". This removes today's limit, noted on the
  live chart shipped in E-21, that the first chart on a symbol decides the
  connection for every later one.
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

- **Price basis follows the broker's own history.** The nightly reconcile
  (E-07) overwrites stream bars with broker bars, so a stream bar should be
  built the way the broker builds its own. Otherwise every bar changes
  overnight and a backtest disagrees with what the chart showed. Each
  adapter declares a `bar_basis`, which the stream entry carries as `basis`:

  | Platform | History today (verified) | `bar_basis` |
  | --- | --- | --- |
  | OANDA | `price=M` candles (`oanda_adapter.py`) | `mid` |
  | IG | mid of bid and ask per price point (`ig_adapter.py` `_mid`) | `mid` |
  | cTrader | trendbars, which Spotware builds from bid | `bid` |
  | MT5 | `copy_rates`, which MetaTrader builds from bid | `bid` |
  | Alpaca | `/v2/stocks/{symbol}/bars`, built from trades | `last` |
  | IB | `reqHistoricalData` with `TRADES` (`routes/market_data.py`) | `last` |
  | IBKR Web API | `/iserver/marketdata/history`, trades by default (`ibweb_adapter.py`) | `last` |

  The bar price is that field of the snapshot. With `mid`, both bid and ask
  must be present. An entry without the needed field is skipped for bars
  (and still stored as a tick).
- **Bucket:** the UTC minute of `ts`.
- **Fields:**
  - `open` is the first price in the minute, `high` the highest, `low` the
    lowest, and `close` the last.
  - `count` is the number of entries used.
  - `volume` is the sum of `last_size` for `last`-basis bars when the broker
    gives sizes, else 0.
  - `timeframe` is `1min`, the existing name.
- **One writer, memory is the truth for open bars.** The recorder keeps each
  contract's bars for the last 10 minutes in memory. Every 5 seconds, and
  when a minute ends, it writes every bar that changed, in the same
  transaction as the ticks and the cursor (D7):

  ```sql
  INSERT INTO candlestick_data (contract_id, timestamp, timeframe, open, high, low, close, volume, count, source)
  VALUES (..., '1min', ..., 'stream')
  ON CONFLICT (contract_id, timestamp, timeframe) DO UPDATE SET
    open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
    close = EXCLUDED.close, volume = EXCLUDED.volume, count = EXCLUDED.count
  WHERE candlestick_data.source = 'stream';
  ```

- **Restart:** the recorder loads the stream bars of the last 10 minutes
  from the database into memory before it reads the stream. Because the
  cursor (D7) makes it resume exactly after the last entry it stored, those
  bars continue with nothing missed and nothing counted twice.
- **Late entries:** an entry is applied in arrival order to its own minute
  while that minute is within the 10-minute window. It can raise the high
  or lower the low, and it sets the close only if its `ts` is not older
  than the newest entry already in that bar. Older entries are counted as
  `late` and dropped.
- **Precedence:** the `WHERE` clause means a stream bar never replaces a
  broker bar. Migration 006 adds
  `source VARCHAR(8) NOT NULL DEFAULT 'broker'` to `candlestick_data`, so
  every existing bar and every backfill bar is `broker`. The backfill upsert
  changes to set `source = 'broker'` and to always overwrite, so broker
  history replaces stream bars. That is what E-07's nightly job relies on.
  The backfill must not fetch the minute still forming, or it would freeze
  a part-built broker bar that the stream can no longer correct. It stops
  at the last completed minute.

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

  It has no unique key, because the same instant can carry two quotes.
  Duplicates are prevented by the cursor in D7, not by a constraint.
- Writes go in the recorder's flush transaction (D7), as one multi-row
  `INSERT`. A flush also happens early when 5000 rows are waiting.
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

### D7. Reading the stream: exactly-once into the database

- **The cursor.** Migration 006 adds a one-row table,
  `recorder_cursor (id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id), last_entry_id TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`.
  Each flush is one database transaction that writes the changed bars, the
  waiting ticks, and the ID of the last stream entry they include. Either
  all three are stored or none is.
- **Reading.** The recorder reads with
  `XREAD COUNT 1000 BLOCK 1000 STREAMS marketdata:quotes <id>`, starting
  from the stored cursor. With no cursor yet it starts from `$`, new entries
  only. No consumer group is needed: the database, not Redis, remembers the
  position, and it moves in the same commit as the data.
- **Result.** After any restart, of the backend, Redis or the database, the
  recorder resumes at the entry after the last one stored. Nothing is
  written twice. Entries are lost only if they were trimmed from the stream
  (`TICK_STREAM_MAXLEN`) while the backend was down, and those minutes show
  as gaps for E-07 to fill from broker history.
- **A cursor ahead of the stream.** If Redis lost its data, its newest entry
  ID can be older than the cursor. Stream IDs start with the Redis server's
  clock in milliseconds, so this happens only with an emptied Redis and a
  clock set back. The recorder checks `XINFO STREAM` at start. When the
  stream's last ID is below the cursor, it logs a warning and restarts from
  `$`.
- **Database down.** The flush fails, the cursor does not move, and the
  recorder retries every 5 seconds while entries wait in the stream.
  It stops reading once 50000 rows are waiting in memory, so memory stays
  bounded and Redis holds the backlog.
- The recorder uses its own Redis connection, separate from the pub/sub
  subscriber in `streamingBridge.ts` and from `cacheService`.

Rejected: a consumer group with `XACK` after the write. It gives
at-least-once delivery, which needs merge rules to make repeats harmless and
still stores duplicate ticks after a crash. The cursor costs one extra row
per flush and removes both problems.

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
  - whether the recorder is on, the stream length, and the lag (seconds
    between the newest stream entry and the stored cursor);
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
  - `recorder_lag_seconds`
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

1. **Subscriptions per connection.** Key venue and IB subscriptions by
   connection, rename the channel and rooms, and carry the connection
   through `streamingBridge.ts` and `useRealtimeStream.ts` (D3). Add the
   recorded set and its endpoint.
   Tests: two connections streaming one symbol to two charts, and repeated
   identical `PUT`s changing nothing.
2. **Broker service, stream.** Add the quote snapshot and `XADD` (D1, D2),
   including IB merging per-type callbacks into snapshots, and `bar_basis`
   on every adapter (D5).
   Tests: entry fields, `MAXLEN` passed, nothing added for browser-only
   symbols or unchanged quotes.
3. **Migration 006.** Add the flags, `candlestick_data.source`,
   `quote_ticks`, `recorder_cursor` and compression, and drop an empty
   `tick_data`. The backfill upsert sets `source = 'broker'` and stops at
   the last completed minute.
   DB tests: an upsert into a compressed chunk, and stream-never-beats-broker.
4. **Backend recorder.** Add the stream reader, bar builder, the flush
   transaction with its cursor, status endpoint, metrics and the 60-second
   resend of the recorded set.
   Unit tests with a fake Redis and a fake database. These cover a crash
   between flushes (no repeat, no loss), each price basis, late entries, a
   minute rollover, the database being down, a cursor ahead of the stream,
   and a broker bar arriving first.
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
| Changing the pub/sub channel and room names breaks a browser tab left open across the upgrade | The tab reconnects and resubscribes on reload; OPERATIONS says to reload open charts after upgrading. |
| A broker's history basis is declared wrongly, so stream bars differ from broker bars | E-07 logs how far each replaced bar moved. A basis that is wrong shows up as a large, steady difference on the first night. |
| The recorder falls behind on a busy instrument set | Reads of 1000 and one flush every 5 seconds for all contracts together. Lag is shown and alerted (section 4). |

## 8. Answers from Sean (10 November 2026)

1. Stored quotes are kept for 30 days by default.
2. **Record live** stays off until chosen, so the upgrade changes nothing on
   its own.

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
- **E-20 (shipped):** the live chart builds its forming candle in the
  browser from ticks, on the mid or last price. Once the recorder runs, the
  chart can take the recorder's forming bar instead (Socket.IO `bar-update`,
  room `bars:<contract_id>`), so the live candle and the stored bar are the
  same bar on the broker's basis. That switch is a follow-up, not part of
  this build.

## 10. As built: differences from this design

The build follows sections 3 to 6 except where listed here. Each is a
follow-up, not a change of direction.

| Design | As built | Why |
| --- | --- | --- |
| D2: `ts` is the broker's quote time where the adapter gives one. | `ts` is the receive time in the broker service for every broker. | The adapters' stream callbacks pass prices without the broker's timestamp today. Carrying it through is a change to each adapter, left for E-11 to E-13, which rework those streams anyway. `recv_ts` is stored, so nothing is lost when `ts` improves. |
| D5: `volume` is the sum of `last_size`. | Size is added only when the last price or size changed from the snapshot before. | A snapshot repeats the last trade when only the bid or ask moved, so a plain sum counts a trade many times. Two trades in a row at one price and size are counted once. The backfill replaces the bar with the broker's volume. |
| D5: the backfill stops at the last completed minute. | The store (`storeCandlestickData`) leaves out the forming minute for the `1min` timeframe, whoever calls it. | One place instead of each caller. Other timeframes are unchanged: the recorder does not write them. |
| D6: bars compressed after 7 days. | Not done. `quote_ticks` is compressed after 1 day as designed. | An upsert into a compressed chunk decompresses the rows it touches, and TimescaleDB caps that per transaction (`max_tuples_decompressed_per_dml_transaction`, 100,000 by default). A deep-history chunk is up to 20,000 bars in one transaction and a re-collection after a cursor reset rewrites many of them. That needs measuring against a real database before it is turned on. It moves to its own item with E-08, where bars become continuous aggregates. |
| D6: migration 006 drops an empty `tick_data`. | `tick_data` is left in place, unused. | The baseline schema file creates it, and the baseline is applied again whenever it changes, so a dropped table would come back. Removing it from the baseline is a separate clean-up. |
| D3: the `PUT` answer lists what is recorded. | It also returns `resolved`: for each instrument asked for, the account its quotes carry and whether it is streamed or polled. | A contract stored with account `default` streams under the connection's real name. The recorder needs that to match a quote to its contract, and does not read the stream until it has the answer. |
| Section 4: a recorded contract with no quote for 5 minutes on a weekday is `degraded`. | Only lag over 60 seconds, or a failing database write, is `degraded`. The Live feed column shows the time of the last quote. | Without trading hours (E-26) that rule would report every closed market as a fault. |
| Section 6, step 7: a fake adapter publishes the quotes. | The e2e test adds the quotes to the Redis Stream itself, in the broker service's format. | The result is exact (known open, high, low, close), and the broker service's side of the format is covered by its own tests. |

Found while building, and not fixed here: live subscriptions put the symbol
in upper case, so an MT5 symbol with a lower-case suffix (`EURUSD.a`) cannot
be streamed or recorded. The live chart has the same limit. History and
orders are not affected.

## 11. What followed (E-02, E-07)

- **E-07, nightly reconcile** (`backend/src/services/reconcile.ts`): as
  section 9 expected, it finds bars with `source = 'stream'` and overwrites
  them through the broker-wins upsert. It runs for every recorded instrument
  at 02:30 UTC, whether or not the backfill scheduler is on, and reports
  bars replaced, minutes filled and how far closes moved.
- **E-02, backtests from the database** (`backend/src/services/backtestData.ts`):
  the plan gave the broker service a read-only database role. Sean chose
  instead (10 November 2026) that the backend reads the bars and sends them
  with the run. The broker service holds no database login, and the install
  gains no step. The cost is a cap of 2,000,000 bars a run.
