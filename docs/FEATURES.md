# TradingApp Features

What TradingApp does today, and what is planned. The two are kept in
separate sections so the available capabilities never get conflated with
plans.

Most features are switched on and tuned on the app's Settings page (tabs:
Connections, Trading, Risk, Alerts and safety, Strategies, Schedulers and
data, Security, Network, History). Each setting is named below by its key,
which the page shows. A key can still be pinned in `.env`; it then wins and
shows as locked. Installing is in [INSTALL.md](INSTALL.md) and running the
app in [OPERATIONS.md](OPERATIONS.md).

---

## Table of Contents

1. [Currently Available](#currently-available)
   - [Market data search](#market-data-search)
   - [Historical charts](#historical-charts)
   - [Live chart](#live-chart)
   - [Real-time streaming pipeline](#real-time-streaming-pipeline)
   - [Technical indicators](#technical-indicators)
   - [Backtesting](#backtesting)
   - [Jesse algo framework (embedded)](#jesse-algo-framework-embedded)
   - [Historical data download](#historical-data-download)
   - [Automated data collection & retention](#automated-data-collection--retention)
   - [Fills, positions & realised P&L](#fills-positions--realised-pl)
   - [Account read endpoints](#account-read-endpoints)
   - [Watchlist](#watchlist)
   - [Order management](#order-management)
   - [Systematic trading (auto-execution)](#systematic-trading-rule-driven-auto-execution)
   - [Risk controls, kill switch & alerting](#risk-controls-kill-switch--alerting)
   - [Multi-broker: IB + MetaTrader + Alpaca + OANDA](#multi-broker-interactive-brokers-metatrader-mt5-alpaca-oanda)
   - [REST & WebSocket API](#rest--websocket-api)
   - [Authentication & CORS](#authentication--cors)
   - [Redis caching](#redis-caching)
   - [Interactive Brokers integration](#interactive-brokers-integration)
   - [Performance](#performance)
   - [Settings page and Getting started](#settings-page-and-getting-started)
   - [Deployment & operations](#deployment--operations)
   - [Testing, linting & CI](#testing-linting--ci)
2. [Planned / Roadmap](#planned--roadmap)

---

## Currently Available

### Market data search

A `Market Data Search & Filter` panel on the home page lets you find
contracts through Interactive Brokers:

- **Search by symbol** (e.g. `MSFT`, `AAPL`, `ES`) or by company name.
- **Security types** validated by the backend:
  `STK`, `OPT`, `FUT`, `CASH`, `BOND`, `CFD`, `CMDTY`, `CRYPTO`, `WAR`,
  `FUND`, `IND`, `BAG`.
- **Exchanges**: any exchange IB exposes, including `SMART`, US exchanges
  (`NYSE`, `NASDAQ`, …) and the Australian exchanges configured under the
  exchange-driven filters.
- **Currency** filter (USD, AUD, EUR, etc., as IB returns them).
- **Advanced search** with optional `expiry`, `strike`, `right`,
  `multiplier`, `includeExpired` for derivatives.
- **Symbol discovery** endpoint (`/symbols/discover`) with a 1-hour TTL
  cache.

Contracts returned are persisted into the `contracts` table so they don't
have to be re-resolved.

Other brokers search their own catalogues through the same panel and API
(`source=oanda`, `mt5`, `alpaca`). Typical instruments:

| Asset class | Examples | Where |
|---|---|---|
| Stocks and ETFs | MSFT, AAPL, SPY, BHP:ASX | IB, IBKR Web API, Alpaca |
| Options | MSFT calls and puts | IB, IBKR Web API (by conid), Alpaca |
| Futures | ES, NQ, YM | IB, IBKR Web API (by conid) |
| Forex | EUR.USD, GBP.USD | OANDA, MT5, IB, IBKR Web API |
| CFDs | indices, metals | OANDA, MT5 |

### Historical charts

A TradingView **lightweight-charts** candlestick chart with volume bars,
served from the `/historical` and per-symbol pages. The library is pinned at
an exact version (5.2.1) in `frontend/package.json`; every chart goes through
`frontend/app/components/Chart.tsx` (and `EquityCurveChart.tsx` for equity
curves).

- **Timeframes shipped:** `tick`, `1min`, `5min`, `15min`, `30min`, `1hour`,
  `4hour`, `8hour`, `1day`.
- **Periods shipped:** `1D`, `5D`, `1M`, `3M`, `6M`, `1Y`, plus a
  `CUSTOM` start/end date range.
- **Data source:** backend reads from the database first
  (`use_database=true`, the default) and falls back to a live request to the
  broker if the rows aren't stored.
- **Interactions:** zoom, pan, crosshair, auto-fit, all built into
  `lightweight-charts`.

### Live chart

The `/live` page charts any symbol on any broker connection
(`/live?symbol=EURUSD&source=oanda&account=practice&secType=CASH`; `/msft`
redirects to `/live?symbol=MSFT`). Pick the symbol, the connection (or "By
broker priority"), the type and, optionally, the currency, then **Show**.
The address holds the choice, so a chart can be bookmarked.

The timeframe list holds only what the chosen connection serves: Tick on
Interactive Brokers only, and 8-hour bars where the broker has them (not on
IG, Alpaca or cTrader). With "By broker priority" every timeframe is
offered, because any broker may answer.

Scrolling or zooming back to the first bar loads older ones and puts them in
front, without moving the bars on screen. Each load asks for as long a range
as is already shown (a week at least, a year at most), from the database
first and then the broker, and repeats until a range returns nothing older;
the line under the chart then says "No older bars". Indicator lines on a
newly loaded stretch start after their own warm-up, so a line can have a
short gap where two loads meet. **Refresh Chart** goes back to the chosen
period.

**Times** sets the zone of the time axis and the crosshair: UTC, the
exchange's zone, or the browser's. The exchange zone comes from the named
exchange, else New York for FX, CFDs and crypto (the FX day ends at 17:00
there), else the stock's currency. The choice is kept in the browser. Daily
bars are dated, not timed, so a daily chart stays in UTC.

History loads from the database first, then the broker. The tick stream then
moves the last candle (`frontend/app/lib/liveCandles.ts`): it follows trades
(`LAST`) when the feed sends them, otherwise the mid of the latest bid and
ask, and starts a new candle when a tick falls in the next bucket. Live
candles are drawn for 1-minute to daily timeframes; indicator lines are not
recomputed live. Streams are per broker connection, so EURUSD from OANDA and
EURUSD from an MT5 account can be charted side by side. A chart left on "By
broker priority" joins the stream a symbol already has, if there is one.

### Bar replay

`/replay` plays stored 1-minute bars back onto a chart, so each candle forms
minute by minute as it did at the time. Nothing is fetched from a broker: a
replay shows what the database holds, so the instrument needs 1-minute bars
stored (recorded live, or collected at 1 minute).

- **Choose** a symbol, a connection, the candle size (1 minute to 1 day) and
  a start time in UTC. The start is moved back to the start of its candle.
  The address holds the choice, so a replay can be bookmarked.
- **Controls:** Play and Pause, Step one minute, Step one bar, Back one bar,
  Restart, a position slider, and a speed from 1x to 100x. 1x plays one
  minute of market each second. The line under the controls shows the
  replay's clock and the forming candle's open, high, low and close.
- **What is drawn.** The 300 candles before the start come from the bars
  built from 1-minute bars (`bars_5min` to `bars_1day`), and the replayed
  candles are formed on the same UTC boundaries, so they continue the
  history exactly. A replay never draws anything from after its clock.
- **One load** holds up to 50,000 1-minute bars, about five weeks of FX.
  When more is stored after that, the page offers to continue from there.
- **A strategy's trades.** Pick a saved definition under "Show a strategy's
  trades" and the page backtests it on the stored bars at the replay's
  candle size, starting 300 candles early to warm its indicators up. Each
  entry and exit appears when the replay reaches it: a rule's decision when
  its candle has closed, a stop on the minute it filled. That backtest is
  not saved (`"save": false`), so it does not show among backtest runs or
  count toward a definition's promotion.
- **API:** `GET /api/market-data/replay?symbol=&timeframe=&start=` with
  optional `source`, `account`, `secType` and `limit`. It answers `minutes`
  and `history` as columns, `more`, and the first and last 1-minute bar
  stored; `404` with what is stored when nothing is stored from `start`.

### Real-time streaming pipeline

A genuine end-to-end tick stream backs the real-time views (no polling):

```
IB Gateway ──reqMktData──▶ broker_service ──redis.publish──▶ Redis
                            (StreamingManager)            │ pSUBSCRIBE
                                                          ▼
                       frontend  ◀── Socket.IO room ◀── backend StreamingBridge
                  (useRealtimeStream)
```

- **Publisher:** `broker_service/streaming.py` runs an in-process
  `StreamingManager` that opens `reqMktData` subscriptions and publishes
  every tick to `marketdata:tick:<platform>:<account>:<SYMBOL>` on Redis.
  The other brokers go through `broker_service/venue_streaming.py`, which
  streams where the broker has a price stream and polls where it does not,
  and publishes to the same channels.
- **Bridge:** `backend/src/services/streamingBridge.ts` holds a second
  Redis client in subscribe mode and forwards each tick to the
  `market-data:<platform>:<account>:<SYMBOL>` Socket.IO room.
- **Consumer:** the frontend `useRealtimeStream` hook
  (`frontend/app/lib/useRealtimeStream.ts`) joins the room and updates the
  price display as ticks arrive.
- **Refcounting & cleanup:** both sides refcount per connection and symbol,
  so multiple browsers on one symbol create a single broker subscription; on disconnect the
  bridge `releaseSocket()`s and `cancelMktData`s anything that hits zero.
- **Controls:** turn `STREAMING_ENABLED` off (Settings > Schedulers and data) to disable the bridge (charts
  fall back to one-shot REST seeding). Health is reported under
  `services.streaming` in `/api/health` and at the broker service's
  `GET /market-data/stream/status`.

### Technical indicators

`broker_service/indicators.py` ships a pandas/numpy implementation of:

- **Trend:** SMA, EMA, WMA, MACD
- **Momentum:** RSI, Stochastic, Williams %R
- **Volatility:** Bollinger Bands, ATR, Keltner Channels
- **Volume:** OBV, Volume SMA, VWAP

These are exposed via `GET /api/market-data/indicators` (backend) and
`GET /indicators/available` (broker service). The frontend
`IndicatorSelector` and `TechnicalIndicatorsFilter` components let users
toggle them on the chart. Overlays (moving averages, bands, VWAP) are drawn
on the candles; oscillators (MACD, RSI) each get their own pane below them.

### Backtesting

`broker_service/backtesting.py` ships an event-driven backtest engine and two
sample strategies:

- `ma_crossover` (simple moving-average crossover)
- `rsi_mean_reversion`

Reachable two ways:

plus every **saved rule-set** authored in the `/systematic` rule builder. See
[Systematic trading](#systematic-trading-rule-driven-auto-execution).

- **API:** `GET /backtesting/strategies` and `POST /backtesting/run` on the
  broker service, or the validating backend proxy at `GET /api/backtesting/strategies`
  and `POST /api/backtesting/run` (`backend/src/routes/backtesting.ts`).
  The run endpoint takes exactly one of `strategy`, `definition_id` or
  `rule_set`, plus optional `sec_type` / `exchange` / `currency` / `source`
  to scope the instrument and the venue (defaults: `STK`/`SMART`/`USD` and
  the highest-priority broker).
- **Bars come from the database.** A backtest runs on the bars stored for the
  instrument at that broker, whichever way they got there (data collection,
  deep history, live recording). Before each run the backend checks the
  range: a stretch longer than 5 days with no stored bar counts as missing
  (shorter ones are weekends and holidays). When something is missing the
  page asks, and the API answers `409` with the coverage:
  - **Fetch missing bars, then run** (`on_missing: "fetch"`) fetches each
    missing stretch from the broker, stores it, and runs. The bars stay
    stored, so the next run needs no fetch.
  - **Run on what is stored** (`on_missing: "use_stored"`) runs on the bars
    there are. The run is marked as not fully covering its range.
  - `on_missing: "refetch"` downloads the whole range again and stores it,
    whether or not it is covered. The page uses it to add the broker's
    spread to bars stored before spreads were kept.

  `GET /api/backtesting/coverage` gives the same check without running.
  The range is a period (`1M` to `5Y` on the page; any `<n>D|W|M|Y` in the
  API) or `start_date` and `end_date`. One run can load up to 2,000,000
  bars. The backend reads the bars and sends them to the broker service
  with the run; the broker service has no access to the database.
- **Bars built from 1 minute.** The database keeps 5-minute, 15-minute,
  30-minute, 1-hour, 4-hour and daily bars built from the stored 1-minute
  bars (the views `bars_5min` to `bars_1day`): first open, highest high,
  lowest low, last close and summed volume of the minutes inside each bar.
  They follow the 1-minute bars within the hour, and at once for a backtest.
  A backtest on 5 minutes to 1 hour uses the broker's own bars for that
  timeframe when they cover the range. When they do not and the 1-minute
  bars do, it runs on the built bars and asks nothing; the results header
  then reads "Bars built from stored 1 minute bars" and the run records
  `built_from: "1min"`. So an instrument recorded or collected at 1 minute
  needs no other intraday timeframe collected. Built bars start on UTC
  boundaries. A broker's 4-hour and daily bars follow its server or session
  time, so a backtest on those timeframes always uses the broker's own.
- **A run can be repeated on the same data.** Each run records where its bars
  came from, how many, the first and last bar, and a SHA-256 of exactly
  those bars (`backtest_runs.data`). The results header shows the range and
  the start of the hash. Two runs with the same hash ran on identical bars;
  a different hash means a bar was added or changed in between (the nightly
  reconcile replacing a recorded bar, for example).
- **Stops fill inside the bar.** A rule-set with a `stop` block is backtested
  the way it trades. The stop is set at the entry, held while the next bar
  forms, and tightened (never loosened) at each bar close, as the live runner
  does with the stop the broker holds. When price reaches it the trade closes
  there, not at the bar's close. On a timeframe above 1 minute the backend
  sends the stored 1-minute bars with the run (`"intrabar": false` turns
  that off), and the stop fills on the minute that reached it: at the stop,
  or at that minute's open when price gapped through. Where no 1-minute bars
  are stored the bar's own range decides, and a bar that opens beyond the
  stop fills at its open. An entry whose stop cannot be set is refused, as it
  is live. `risk_pct` sizing is simulated from the distance to the stop. The
  results say which of the two the stops were filled against, how many
  trades closed on the stop, and each such trade's exit reason. Entries and
  rule exits still fill at the close of the bar that signalled them.
  Rule-sets without a `stop` block, the built-in strategies and Jesse
  strategies are unchanged.
- **Buys at the ask, sells at the bid.** Stored bars are mid prices, which no
  trade gets. OANDA's bars are stored with the spread at each bar's close
  (ask minus bid, `candlestick_data.spread`), and a backtest on bars that
  carry one fills a buy half the spread above the bar's price and a sell
  half below it. A long's stop is hit when the bid reaches it and a short's
  when the ask does, as at the broker. The results say what the spread cost
  and over how many fills (`results.spread`). `"spread": false` in the API
  fills at the mid price instead. Bars from brokers that report no spread
  (IB, IG, Alpaca), bars built from 1 minute, and bars the live recorder
  built carry none and fill at their own price. Where OANDA bars were
  stored before spreads were kept, the results offer **Download the range
  again with spreads, then run**. Jesse strategies do not use the spread.
  The charts show mid prices; there is no bid and ask view.
- **Straight from the broker, storing nothing:** `data: "broker"` in the API
  has the broker service fetch the bars itself, as every run did before. It
  is limited to 365 days and is not offered on the page.
- **UI:** the `/backtest` page (`frontend/app/backtest/page.tsx`) with a
  strategy picker (saved rule-sets grouped above the built-ins), parameter
  form, instrument fields, metrics summary, equity-curve chart
  (`EquityCurveChart`), trade-list table and a **Previous Runs** panel
  that click-to-loads any prior run without re-running the engine.

**Persistence**: every successful run is saved into
`backtest_runs` (canonical schema). The slim list endpoint
`GET /api/backtesting/runs` (filter by symbol / strategy, paginated)
feeds the panel; `GET /api/backtesting/runs/:id` returns the full record.
A SHA-256 `params_hash` over the canonical input lets the UI deduplicate
identical re-runs.

### Jesse algo framework (embedded)

A port of the [Jesse](https://jesse.trade) strategy model lives in
`broker_service/jesse/`. Strategies are written the way Jesse users expect,
and run against the app's own data, backtester and live runner. There is no
separate Jesse install, database or exchange driver.

- **Authoring:** subclass `jesse.strategies.Strategy` in
  `broker_service/jesse_strategies/` and implement `should_long()`,
  `should_short()`, `go_long()`, `go_short()` and `should_cancel_entry()`,
  plus the optional hooks (`update_position()`, `before()`, `after()`,
  `on_open_position()` and the rest). Order intent is declared through
  `self.buy`, `self.sell`, `self.stop_loss` and `self.take_profit`.
  `self.candles`, `self.get_candles(tf)`, `self.position`, `self.balance`,
  `self.vars`, `self.hp` and `self.log()` behave as in Jesse.
  `hyperparameters()` declares tunables.
- **Indicators and utils:** `jesse.indicators as ta` (`ta.sma`, `ta.ema`,
  `ta.rsi`, `ta.macd`, `ta.bollinger_bands`, `ta.atr`, `ta.adx`,
  `ta.supertrend`, `ta.vwap` and more, all with `sequential=` and
  `source_type=`), and `jesse.utils` (`size_to_qty`, `risk_to_qty`,
  `crossed` and more). Indicator results are memoised per candle history, so
  a bar-by-bar backtest stays linear in the number of bars.
- **Backtest:** `BacktestEngine` hands these strategies to the Jesse
  simulator. Results are mapped into the shared `BacktestResults` payload,
  and the full Jesse metric set (`sharpe_ratio`, `sortino_ratio`,
  `calmar_ratio`, `omega_ratio`, `expectancy`, `kelly_criterion` and more)
  is returned under `results.metrics`. Higher-timeframe context from
  `get_candles()` is resampled from the base bars without look-ahead.
- **Live:** `/strategies/evaluate` accepts
  `{"engine": "jesse", "strategy": "SMACrossover", "hyperparameters": {...}}`
  as a rule-set. The evaluator replays the bars to rebuild strategy state,
  syncs the simulated position to the venue's, and returns the same
  `signal` / `stop_price` / `trail` contract the `StrategyRunner` already
  executes. The code that was backtested is the code that runs live.
- **Catalogue and UI:** strategies register as `jesse_<snake_case>`
  (`jesse_sma_crossover`, `jesse_rsi_mean_reversion`,
  `jesse_bollinger_breakout`, `jesse_msft_trend_follower`) and appear on
  `/backtest` with an engine badge and an editable hyperparameter panel.
  `GET /jesse/strategies`, `GET /jesse/indicators` and `POST /jesse/backtest`
  (caller-supplied bars, no broker needed) on the broker service support
  authoring.
- **Tests:** `broker_service/tests/test_jesse_*.py`.

### Historical data download

The `/download` page pulls historical OHLCV bars from a broker, shows them,
and stores them in the database on request.

1. Choose the region, exchange, security type, symbol and currency.
2. Choose a period (`1D`, `1W`, `1M`, `3M`, `6M`, `1Y`) or a custom date
   range, and a timeframe (tick to 1 day).
3. **Download** fetches the bars (`GET /api/market-data/history`) and shows
   them in a DataFrame viewer with a record count.
4. **Load to PostgreSQL** stores them (`POST /api/market-data/upload`) with
   upsert semantics, so re-loading the same bars updates rather than
   duplicates, and reports inserted and updated counts. Data quality metrics
   are recorded on the way in.
5. Export the visible (filtered and sorted) rows as **CSV** (RFC 4180,
   in the browser), **JSON**, or **Parquet** (encoded by
   `POST /api/export/parquet`).

The request names no broker, so it goes to the highest-priority broker with
a connection, even though the page's buttons still say "IB API". To keep an
instrument topped up without coming back here, add it to the data collection
table instead (next section).

### Automated data collection & retention

Beyond the manual *Download* page, the backend can keep the database
topped up and pruned on its own:

- **What to collect.** Settings > Schedulers and data has a table of
  instruments and timeframes: which are fetched and stored, how often, and
  how long they are kept. It writes the `data_collection_config` table
  (API: `GET`/`POST /api/market-data/collection`,
  `PUT`/`DELETE /api/market-data/collection/:id`). There is no SQL to run.
- **Scheduled backfill (opt-in).** With `BACKFILL_ENABLED` on (same tab),
  the backend fetches each enabled entry when its newest bar is older than
  its collection interval, over the recent `BACKFILL_PERIOD` window, from
  the entry's broker, and upserts it. Progress is visible under
  `services.backfill` in `/api/health`.
- **Live recording.** Tick **Record live** on an entry and the backend
  stores the instrument's 1-minute bars from its live prices as they form,
  with no chart open. Tick **Store ticks** to keep each quote as well
  (`quote_ticks`, kept `TICK_RETENTION_DAYS`, 30 by default). Both belong to
  the instrument, so they change on every timeframe row of it, and both are
  off until ticked. See [Live recorder](#live-recorder) below.
- **Data-quality metrics.** Every store path (manual upload, the
  `/history` cache-on-fetch and the backfill worker) records per-day
  total / missing / duplicate / invalid bar counts and a quality score
  into `data_quality_metrics`. They surface through
  `GET /api/market-data/database/stats`.
- **Retention cleanup with real counts.** Every day at 03:30 UTC, and on
  `POST /api/market-data/database/clean`, the backend deletes bars older
  than each row's `retention_days` and stored quotes older than
  `TICK_RETENTION_DAYS`, and reports the actual numbers. Bars from an
  entry's history start on are always kept. This is the only thing that
  deletes bars: TimescaleDB has no retention policy on them (it would drop
  deep history by age).

#### Live recorder

```
broker_service ──XADD──▶ Redis Stream marketdata:quotes ──XREAD──▶ backend recorder
 (recorded instruments only)                                        │ every 5 s, and at each minute end
                                                                    ▼
                                   one transaction: 1-minute bars + quotes + the cursor
```

- **What is recorded.** The backend sends the broker service the full list
  of recorded instruments at start, on every change to the table, and every
  minute (`PUT /market-data/stream/recorded`). Those instruments stream
  whether or not a chart is open, and each change of bid, ask or last is
  added to the Redis Stream `marketdata:quotes` (capped at
  `TICK_STREAM_MAXLEN` entries). A quote identical to the one before is not
  added, so a quiet minute has no bar.
- **How a bar is built.** On the price the broker builds its own history
  from, so a recorded bar matches the broker's bar: the mid for OANDA and
  IG, the bid for cTrader and MT5, the last trade for Alpaca, IB Gateway
  and the IBKR Web API. Recorded bars are marked `source = 'stream'` in
  `candlestick_data`. A bar fetched from the broker (`source = 'broker'`)
  replaces a recorded one, and a recorded bar never replaces a broker bar.
  The backfill does not store the minute still forming.
- **Nothing twice, nothing skipped.** The recorder stores the ID of the last
  stream entry it has written (`recorder_cursor`) in the same transaction as
  the bars and quotes from it, and resumes from there after any restart. A
  stopped backend catches up from the stream when it returns. Quotes are
  lost only if more than `TICK_STREAM_MAXLEN` of them arrive while it is
  down; the nightly reconcile fills those minutes from the broker's history.
- **Streamed brokers.** IB, OANDA (its pricing stream), IG (its
  Lightstreamer `MARKET` subscription, one streaming session per IG
  connection) and Alpaca (its market data WebSocket, IEX feed: quotes for
  bid and ask, trades for the last price) push each price change as it
  happens. A free Alpaca account may hold one market data connection with
  30 symbols on it. If a price stream
  fails, that connection's prices are fetched every 5 seconds instead until
  it is back, and the Live feed column shows the stream's error.
- **Polled brokers.** A broker without a price stream is polled every
  `STREAM_POLL_SECONDS`, so a high or low between two polls is missed and
  its recorded bars are approximate until the nightly reconcile replaces
  them. The Live feed column says which instruments are streamed and which
  polled.
- **Nightly reconcile.** At 02:30 UTC the backend fetches the last two days
  of 1-minute bars for every recorded instrument from its broker and stores
  them: a broker bar replaces the recorded one and fills any minute the
  recorder missed. Each run reports, per instrument, bars replaced, minutes
  filled, recorded bars the broker had none for, and how far the replaced
  closes moved (in basis points). The line under the recorder's on the
  Settings page shows the last run and has **Reconcile now**
  (`POST /api/market-data/recorder/reconcile`). It runs whenever
  `RECORDER_ENABLED` is on, and does not need the backfill scheduler.
- **Limits today.** The time on a quote is when the broker service received
  it, not the broker's own timestamp. Volume on trade-built bars is
  approximate. Live MT5 symbols are sent in upper case, so a symbol with a
  lower-case suffix (`EURUSD.a`) cannot be streamed or recorded yet; the
  Live feed column shows "not found" for it.
- **Status.** The Live feed column and the line above the table come from
  `GET /api/market-data/recorder/status`. `/api/health` reports
  `services.recorder`, `degraded` when the recorder is more than 60 seconds
  behind the stream or a write to the database is failing. Prometheus:
  `recorder_entries_total{result}`, `recorder_lag_seconds`,
  `recorder_flush_seconds`.
- **Controls.** `RECORDER_ENABLED` (on by default; nothing is recorded until
  an entry is ticked), `TICK_STREAM_MAXLEN` and `TICK_RETENTION_DAYS`, all
  on Settings > Schedulers and data.

The "Getting started" checklist on the Settings page counts this step done
once at least one entry is collected and the backfill scheduler is on.

### Fills, positions & realised P&L

`order_audit` records what the app *asked* a venue to trade. That is not the
same as what traded: a partial fill, a rejection that lands after the
acknowledgement, and any trade placed outside the app all leave the two
disagreeing, silently. With `EXECUTIONS_SYNC_ENABLED` on (Settings >
Schedulers and data) the backend closes that gap:

- **The fills feed.** `GET /account/executions` on the broker service reports
  each venue's own execution reports, normalised to one shape (IB via
  `execDetails` + `commissionReport`, Alpaca via `FILL` activities, OANDA via
  `ORDER_FILL` transactions, MT5 via the sidecar's deals). A backend poller
  pulls each active venue on a timer into the `order_executions` table.
- **Fills as they happen (OANDA).** While the sync is on, the broker service
  also listens to OANDA's transaction stream on each OANDA connection and
  passes every fill to the backend, which stores it within a second or so
  instead of at the next poll. The stream adds speed only: the poll stays on
  and picks up anything the stream missed, and a fill that arrives both ways
  is stored once.
- **Fills straight after a trade (IG and Alpaca).** IG's stream says that a
  deal was confirmed or a position changed, and Alpaca's `trade_updates`
  stream reports a fill under a different id from the one its account
  activities carry. So on each such event the backend polls that connection
  about 1.5 seconds later instead of waiting for the timer. The fill is read
  the one way it always is, so it cannot be stored twice under two ids.
  Other brokers are polled on the timer only.
- **Idempotent by design.** Every poll re-reads an overlapping window, because
  a fill can be reported late and IB delivers a fill's commission on a callback
  separate from the fill itself. Rows upsert on `(broker, exec_id)`, so
  re-delivery updates rather than duplicates, and a late commission can fill a
  blank without a later poll ever erasing one already recorded.
- **Attribution.** Each fill is linked back through the venue's order id to its
  `order_audit` row and, from there, to the `strategy_run` that caused it. A
  fill polled before its order id was recorded is picked up by a re-link pass
  on the next tick. A fill with *no* order of ours behind it stays unattributed
  on purpose: a manual trade is real exposure and belongs in the position.
- **Realised P&L.** Computed on an average-cost basis with commissions
  subtracted at the time they are charged, handling partial exits and
  reversals through flat. Exposed at `GET /api/account/pnl`, and consumed by a
  strategy run's `max_daily_loss` cap.
- **Positions come from fills *plus* still-working orders.** Neither alone is
  right: fills lag the poller, so an order placed seconds ago would read as
  flat and a strategy could re-enter a position it already holds; submitted
  orders can't see a partial fill and drop a partially-filled-then-cancelled
  order entirely. Every fill counts whatever became of its order, and every
  live order contributes only its *unfilled remainder*, so an order moves
  from "in flight" to "filled" without ever being double-counted or briefly
  invisible. Scoped to a run it is that run's own ledger (a second run on the
  same symbol can't change its pyramiding); unscoped it is account exposure at
  the venue, which is what `ORDER_MAX_POSITION` caps.
- **Reconciliation.** Per-run attribution can drift from the account: a manual
  trade belongs to no run. `GET /api/account/reconciliation?broker=` compares
  the app's recorded net against the venue's reported positions per symbol and
  flags every mismatch, so the drift is visible rather than silent.

Progress and errors surface under `services.executions` in `/api/health`. The
poller is **off** by default because it makes live venue requests on a timer.

### Account read endpoints

The backend proxies the following read-only account endpoints to the
frontend. All of them are **venue-scoped**: pass `?broker=` (default `ib`)
and each venue's payload is normalised to one shape, so the frontend never
sees a raw broker response.

- `GET /api/account/summary`: balances and key metrics. Also the source of
  the equity that `pct_equity` position sizing reads.
- `GET /api/account/positions`: current positions.
- `GET /api/account/orders`: orders still working at the venue.
- `GET /api/account/all`: all of the above in one call.
- `GET /api/account/connection`: IB connection state.

Two further endpoints read the local **fills** store rather than the venue:

- `GET /api/account/executions`: recorded fills, filterable by
  `broker` / `symbol` / `account_mode` / `run_id`. Each row carries its
  attribution (`order_audit_id`, `run_id`), something a raw venue payload
  has no idea about. `?fresh=true` reads live from the venue instead.
- `GET /api/account/pnl`: realised P&L and per-symbol breakdown over those
  fills (defaults to today, the window a run's `max_daily_loss` is measured
  over).
- `GET /api/account/reconciliation`: the app's recorded net position per
  symbol against the venue's, with a `matched` flag per row.

> These endpoints are read-only. The write path lives under `/api/orders/*`
> and requires `LIVE_TRADING_ENABLED` (Settings > Trading) for any live
> order. See the *Order management* section below.

### Watchlist

A single flat list of symbols to keep an eye on, independent of any
broker/backtest workflow:

- **Page:** `/watchlist`, plus a quick-access tile on the home page.
- **Component:** [`Watchlist`](../frontend/app/components/Watchlist.tsx),
  backed by the [`useWatchlist`](../frontend/app/lib/useWatchlist.ts) hook.
- **Backend:** `GET /api/watchlist` (list), `POST /api/watchlist` (add,
  idempotent: adding an already-watched contract returns the existing
  row instead of erroring), `DELETE /api/watchlist/:id` (remove),
  persisted in the `watchlist_items` table
  ([`WatchlistRepository`](../backend/src/services/watchlistRepository.ts)).
- **Live quotes:** each row polls the existing (Redis-cached)
  `GET /api/market-data/realtime` endpoint every 15s, so no new IB traffic
  or streaming subscription is introduced by adding a symbol here.
- Symbols are broker-scoped (`broker`/`sec_type`/`exchange`/`currency`,
  defaulting to `ib`/`STK`/`SMART`/`USD`) so the same ticker on two
  venues can be tracked as separate rows.
- **Price alerts (in-app only):** set an "above" or "below" target price
  on any watchlist row. There is no server-side price watcher or external
  delivery channel. The row already polls its quote every 15s, so the
  frontend itself compares each active alert against that quote and flips
  it to `triggered` the moment it crosses
  (`POST /api/alerts/:id/trigger`). Triggered alerts persist in the
  `price_alerts` table (`PriceAlertRepository`), mounted at
  `/api/alerts` (`GET`/`POST /api/alerts`, `POST /api/alerts/:id/trigger`,
  `POST /api/alerts/:id/dismiss`, `DELETE /api/alerts/:id`), so they
  survive a refresh and show up in a banner at the top of the page (with
  a **Dismiss** button) even in a second tab. A **Enable browser
  notifications** control (Web `Notification` API, permission-gated) adds
  an OS-level toast on top of the in-page banner. Deleting a watchlist
  item cascades to its alerts.
- **Not yet implemented:** email/SMS/webhook delivery, manual reordering,
  multiple named lists.

### Order management

Place, cancel and modify orders against any connected broker from the UI:

- **Components:** [`OrderTicket`](../frontend/app/components/OrderTicket.tsx)
  and [`OrderBlotter`](../frontend/app/components/OrderBlotter.tsx).
- **Pages:** a full surface at `/trade` (ticket + blotter), plus a
  compact ticket on the Orders tab of `/account`.
- **Order types:** MKT, LMT, STP, STP_LMT. **TIF:** DAY, GTC, IOC,
  FOK. The ticket reveals limit / stop inputs only when the order
  type needs them.
- **Connection:** with more than one trading connection the ticket has a
  Connection list; left on Default, the order goes to the default broker
  as before. The order types and times in force offered are the ones that
  connection takes (IG has no stop-limit order, and its working orders
  rest for the day or until cancelled; the IBKR Web API takes no FOK).
  `GET /api/orders/config` lists the connections with what each takes.
- **Backend proxy:** `POST /api/orders` (create),
  `DELETE /api/orders/:id` (cancel), `PUT /api/orders/:id` (modify),
  `GET /api/orders/audit` (blotter feed), `GET /api/orders/config`
  (surface the gate + enums to the UI).
- **Audit log:** every attempt, paper or live, writes a row to
  `order_audit` with the input set, the IB order id once known, the
  `X-Request-Id`, status transitions and raw IB response. The
  backend refuses to forward an order if the audit insert fails.
- **Defence-in-depth gate:** live trading must be on in **both** the
  backend and the broker service (Settings > Trading sets both; the
  broker service refuses live orders until the backend has told it).
  If they disagree, every live submission is rejected with HTTP 403. Paper orders work
  regardless. The Live option is also greyed out in the UI when the
  config probe reports the gate as off, and a confirmation modal
  protects every live submission.
- **Live trading switch:** `LIVE_TRADING_ENABLED` on Settings > Trading.
  Turning it on needs a trading token and order MFA set up on Settings >
  Security, a token and code on the page, and typing LIVE. Turning trading
  off or tightening a limit needs only the login. `LIVE_TRADING_ENABLED=false`
  pinned in `.env` keeps it off regardless.
- **Fat-finger caps:** `ORDER_MAX_QUANTITY` (default 100k) and
  `ORDER_MAX_PRICE` (default $1M), on Settings > Risk, are enforced by the
  validator.
- **Position-limit guard (opt-in):** set `ORDER_MAX_POSITION` > 0 (Settings >
  Risk) to cap
  the net signed exposure per `(broker, symbol, account_mode)` implied by the
  audit log. A create whose projected net would breach the cap is
  rejected with HTTP 422 before any broker call. Only orders within
  `ORDER_POSITION_LOOKBACK_HOURS` (default 24) count. It is a soft guard
  on submitted orders, not authoritative fills. Keying on `broker` means
  exposure never nets across venues.

### Systematic trading (rule-driven auto-execution)

Evaluate declarative criteria against live bars and place orders
automatically: paper-first, staged behind gates. See the
[Systematic Trading roadmap](plans/SYSTEMATIC_TRADING_ROADMAP.md) for the full design.

- **Rule-driven strategies:** a strategy is one declarative rule-set (entry /
  exit conditions, sessions, multi-timeframe operands, position-aware fields,
  sizing, risk) shared by the backtester **and** the live runner
  ([`broker_service/rule_strategy.py`](../broker_service/rule_strategy.py)). Evaluated
  statelessly via `POST /strategies/evaluate`.
- **Definitions & runs:** create/list rule-sets and start/stop runs through
  `/api/strategies/*`; each run pins a definition to a broker + `account_mode`.
- **Backtest before you deploy:** a saved definition can be backtested without
  being re-keyed: the `/backtest` strategy picker lists *Saved rule-sets*
  above the built-in strategies, and every row of the definitions list on
  `/systematic` has a **Backtest** link. Under the hood
  `POST /api/backtesting/run` accepts exactly one of `strategy` (a built-in
  key), `definition_id` (a saved rule-set) or an inline `rule_set` object.
- **Any instrument, any venue:** a definition carries `sec_type` / `exchange` /
  `currency` alongside its symbol and broker (defaulting to `STK`/`SMART`/`USD`),
  so futures, FX, CFDs and non-USD instruments work the same way US stocks do.
  The backtester reads the bars stored for the run's **own** broker, and
  the live runner fetches from that broker, rather than always from IB.
- **Position-aware rules are simulated, not just carried:** the backtest engine
  evaluates rules bar-by-bar against its running position and entry price, so
  `position.size`, `position.avg_price` and `position.unrealized_pct` (stops,
  pyramiding caps, scale-out thresholds) behave in a backtest the way they
  behave live. Live, the average entry price comes from the venue's reported
  average cost, so an unrealised-loss stop actually fires.
- **Sizing and partial exits are simulated too:** the backtester resolves the
  definition's `sizing` block (`fixed` / `notional` / `pct_equity`) instead of
  going all-in, and drives its `scale_out` rungs per bar against the open
  trade, each rung firing at most once per trade. A strategy sized at 100
  shares with "take half off at +3%" therefore produces the same trade
  sequence in backtest as it does live. A strategy that declares no sizing
  keeps the original all-in behaviour, so the built-in strategies are
  unchanged.
- **Sizing is in the venue's own units.** "Buy 1" is one share on IB or Alpaca,
  one unit of the base currency on OANDA, and one *lot* on MT5, which at a
  standard contract size controls 100,000 units. The venue supplies an
  instrument spec (`GET /instrument/spec`) with its `contract_size`,
  `size_step` and `min_size`; notional and percent-of-equity sizing divide by
  `price × contract_size`, sizes floor onto the step (never round up past what
  was asked for) and are refused below the minimum. The live sizer and the
  backtester share these semantics, so an FX strategy backtests at the size it
  would actually trade.
- **Live signal runner:** an opt-in backend timer (`SYSTEMATIC_ENABLED`,
  Settings > Trading)
  evaluates every running strategy on its closed-bar cadence, persists each
  decision to `strategy_signals` (one per bar) and fans it out on the
  `strategy:<runId>` Socket.IO room. Only **closed** bars are evaluated: the
  bar still forming is dropped, so a signal live is the signal the backtest
  saw.
- **Promotion gate:** a definition is frozen once created. Starting a paper
  run or deploying needs a backtest of that definition from its holdout start
  date with enough trades, positive expectancy and a bounded drawdown; a live
  run additionally needs a paper run of the same definition lasting
  `PROMOTION_MIN_PAPER_DAYS` with a comparable drawdown. Both are on
  Settings > Strategies, where `PROMOTION_PAPER_GATE=off` skips the paper
  check for smoke tests (live is always gated).
  `GET /api/strategies/definitions/:id/promotion` explains what is missing.
- **Staged deploy across accounts:** `POST /api/strategies/definitions/:id/deploy`
  starts one run per target connection as a group; the canary leg must
  evaluate cleanly for `settle_seconds` before its siblings start. A
  connection that stops answering is skipped by a circuit breaker without
  stalling the others.
- **Stops at the venue:** a declared stop (for example `bar_extreme`) is sent
  with the entry in the same order, never as a follow-up modify. An entry the
  venue fills without its stop is closed at once. Trailing stops move only in
  the protective direction, at most once per bar. `risk_pct` sizing uses the
  venue's tick value and refuses rather than approximating when it is missing.
- **Gated auto-execution:** with `SYSTEMATIC_EXECUTION_ENABLED` on (Settings >
  Trading) an
  actionable signal is turned into an order through the **same** audited
  `/api/orders` path, inheriting the live gate, `order_audit`, the fat-finger
  caps and the position-limit guard. Engine-level guards on top: a per-run kill
  switch, per-run `max_orders_per_day` + a global `SYSTEMATIC_MAX_ORDERS_PER_DAY`
  backstop, a per-run `max_daily_loss` measured against **realised P&L from
  fills**, broker-unit-aware sizing (`fixed` / `notional` / `pct_equity`, fed by
  the venue's own equity and instrument spec), and signal→order dedupe. Both
  gates default **off**; live (vs paper) auto-trading additionally needs
  `LIVE_TRADING_ENABLED`.

  `max_daily_loss` gates **entries only**: blocking an exit would strand the
  position in the trade that caused the loss. It needs the fills feed
  (`EXECUTIONS_SYNC_ENABLED`); with the feed off, a declared cap fails
  *closed* rather than trading against a limit it cannot evaluate.
- **Monitoring UI (`/systematic`):** a rule builder, a definitions list (start a
  run), a run dashboard (status, last-eval, per-run **Stop**) and a per-run
  detail with a candle chart carrying buy/sell **signal markers** (acted orders
  bolder), a summary strip (net position, signals, orders placed) and a
  live-updating signal feed.
- **Fleet panel:** one card per connection with its `paper`/`live` badge,
  currency, equity, day-start equity, drawdown, the account and prop-firm
  limits in force, and its halt state. A deployed group shows as one strategy
  row with a leg per connection (`canary` / `staged` / `running`), each with
  its own native symbol and current stop.

### Risk controls, kill switch & alerting

Account-level controls that sit on top of each run's own caps. All of them
stop **new entries** only: exits and stop management keep running, so a limit
never strands an open position. The fleet-wide settings are on Settings >
Risk and Settings > Alerts and safety. Per-connection limits and prop-firm
rules are on each connection's own form under Settings > Connections. The
[paper runbook](PAPER_TRADING.md) rehearses each one.

- **Connection limits:** `CONNECTION_MAX_ORDERS_PER_DAY` and
  `CONNECTION_MAX_DAILY_LOSS` (realised P&L from fills), plus
  `CONNECTION_MAX_DAILY_EQUITY_LOSS` and `CONNECTION_MAX_DRAWDOWN`, which
  measure equity (balance plus floating P&L) against the trading day's start
  and the high-water mark. These are fleet-wide caps on Settings > Risk.
  Each connection can set its own on its form. Order of precedence: a
  `CONNECTION_MAX_*__<CONNECTION>` line in `.env`, then the connection's own
  limit, then the fleet-wide cap. `TRADING_DAY_TIMEZONE` sets when the day
  rolls over; `PORTFOLIO_MAX_DAILY_LOSS` is a fleet-wide backstop.
- **Prop-firm rules:** a firm's rules as JSON, entered on the connection's
  form (a `PROP_RULES__<CONNECTION>` line in `.env` still wins). Daily loss (balance, equity or the higher basis) and max loss (static
  or trailing) are computed the firm's way, and entries stop `buffer_pct`
  short of the firm's own limit. Optional schedule rules: a `news_blackout`
  around high-impact releases for either currency of the pair (from
  `NEWS_CALENDAR_URL`; entries are refused while the calendar is stale), a
  `weekend` entry cutoff that pages you if a position is still open, and a
  `min_trading_days` count shown on the Fleet panel.
- **Kill switch:** detects unprotected positions, stops gapped through,
  position divergence and equity-floor breaches (`KILL_SWITCH_EQUITY_FLOOR`).
  `KILL_SWITCH_ACTION` decides the response to a critical trigger: `notify`
  (default, alert only), `halt` (stop new entries on that connection until
  **Resume entries** on the Fleet panel; a halt survives a restart) or
  `flatten` (halt, then close every position on the connection at market).
  **Close all positions** on a Fleet card does the flatten by hand under any
  setting.
- **Telegram alerts:** set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` on
  Settings > Alerts and safety.
  Alerts are deduplicated (`ALERT_DEDUPE_SECONDS`), rate-limited
  (`ALERT_MAX_PER_HOUR`) and send a resolved message when the condition
  clears.
- **Dead-man's switch:** the backend pings `HEARTBEAT_URL` (for example a
  healthchecks.io check) every `HEARTBEAT_INTERVAL_SECONDS`, and
  `HEARTBEAT_FAIL_URL` when the broker service is unreachable, so a monitor
  off the host pages you when the app, the host or its network goes down.
  `/api/health` reports the last result.
- **Prometheus rules:** the `tradingapp-fleet` group in
  [`ops/prometheus/alerts.yml`](../ops/prometheus/alerts.yml) alerts per
  connection on an open circuit breaker, unprotected positions, position
  divergence, stop gaps, orders blocked by caps and connections with no
  active runs.

### Multi-broker: Interactive Brokers, MetaTrader (MT5), Alpaca, OANDA

A venue-agnostic adapter seam lets each broker plug in without touching the
routes. [DEVELOPMENT.md § Adding a broker](DEVELOPMENT.md#adding-a-broker)
describes adding another.

- **Each connection says what it supports.** `GET /api/brokers/status`
  carries a `capabilities` block per connection, read from its adapter
  (`broker_service/capabilities.py`): the bar `timeframes` its history
  serves, `live_prices` (`stream` or `poll`), `spread_bars`, the
  `order_types` it takes with the times in force for each,
  `attaches_stops`, and how fills arrive (`stream`, `signal` then read, or
  `poll`). Settings > Connections shows it under each connection, and the
  live chart and the order ticket offer only what the connection supports.
- **Connections in the app:** brokers are added on Settings > Connections,
  one connection per account, in priority order OANDA, IG, cTrader, the
  IBKR Web API, Alpaca, MT5, then IB Gateway (the order can be changed
  there). Each connection has a name,
  a mode (`paper` or `live`), a currency, the broker's own fields and
  optional risk limits and prop-firm rules. Credentials are stored
  encrypted in the database. Each connection is tested when saved, and the
  app keeps checking it on a timer (`BROKER_PROBE_INTERVAL_SECONDS` on
  Settings > Schedulers and data; 0 pauses it). The last result shows on the
  connection and in the header health badge. A broker that is down never
  stops the app.
- **How they reach the broker service:** the backend sends the full set,
  secrets decrypted, to the broker service (`PUT /connections/managed`)
  after every change and whenever the broker service restarts.

- **Adapter registry** ([`broker_service/adapters.py`](../broker_service/adapters.py)):
  `MarketDataAdapter` / `BrokerAdapter` protocols keyed by provider. A request's
  `source=` (market data) / `broker=` (orders) resolves to the concrete adapter,
  defaulting to `ib`; an unknown provider → 400, a recognised-but-unconfigured
  one → 501. `source=ib` / `broker=ib` behaviour is byte-for-byte unchanged.
- **Broker-scoped instruments:** contract catalogues, positions and the
  net-exposure cap are keyed per broker: no cross-broker symbol reconciliation,
  and a strategy run targets exactly one venue.
- **MetaTrader (MT5) via sidecar:** `MetaTrader5` is Windows-only, so MT5 runs as
  a small HTTP service next to the terminal, on Windows or on Linux under Wine.
  The sidecar ships in [`mt5_sidecar/`](INSTALL.md#42-metatrader-5-vm-120): it enforces
  the shared secret, attaches the stop with the entry and echoes back the stop
  the terminal recorded. The Linux
  [`MT5Adapter`](../broker_service/mt5_adapter.py) is a thin client pointed at
  the connection's Bridge URL, implementing both **data** (search, bars,
  quotes, ticks, normalised to the app's shapes) and **execution** (place,
  cancel, modify, positions, account, with the same validation and live gate
  as IB). Every request carries the connection's Bridge secret in an
  `X-MT5-Bridge-Secret` header, and the sidecar refuses requests without it.
  The operator picks the secret and sets the same value on the sidecar
  (`MT5_BRIDGE_SECRET`) and in the app's connection form.
- **Several accounts per platform:** add one connection per account. Its
  mode is binding: a live order to a paper connection is refused with a 409.
  Requests address a connection as `broker=mt5&account=<name>`, and canonical
  symbols resolve to each broker's own. An MT5 connection defined in a `.env` manifest can
  read its balance and positions from an OANDA account (`account_info_from`)
  while orders still go through the sidecar.
- **IBKR Web API (`ibweb`) through the Client Portal Gateway:**
  [`IBWebAdapter`](../broker_service/ibweb_adapter.py) speaks IBKR's REST API
  to a gateway signed in from a browser
  ([INSTALL.md § 4.10](INSTALL.md#410-interactive-brokers-web-api-client-portal-gateway)).
  Unlike the TWS socket path it allows several connections, and it resolves
  `AAPL`, `BHP:ASX`, `AUD.USD` or a bare conid to a contract, so stocks on
  any exchange, IDEALPRO FX, futures and options all trade. A stop and
  target go with the entry as one bracket. IBKR's precautionary prompts are
  confirmed and returned as `warnings`. Paper account ids start with `D`, and
  the connection's mode must match its account, which must also be one the
  gateway is signed in to. The connection check tickles the gateway, which
  keeps its session alive; the daily sign-in is a person's.
- **Alpaca and OANDA: cloud REST, no sidecar host.** Unlike MT5, both are
  reachable directly over HTTPS, so
  [`AlpacaAdapter`](../broker_service/alpaca_adapter.py) and
  [`OANDAAdapter`](../broker_service/oanda_adapter.py) run in-process in
  `broker_service`. Their connections take API credentials (Alpaca: API key
  and secret; OANDA: account id and token) instead of a bridge URL. Both implement the same data + execution surface as
  MT5. OANDA has a native 8-hour candle (unlike MT5) so every app timeframe
  maps cleanly. A `STP_LMT` goes to OANDA as a STOP with a `priceBound` (the
  limit is the worst fill price; what can't fill inside it is cancelled, not
  left resting). Units may be fractional where the instrument allows. OANDA
  entries carry their stop loss and take profit on the fill, positions report
  the stop per trade and are marked with one pricing call.
- **IG: cloud REST.** [`IGAdapter`](../broker_service/ig_adapter.py) logs in
  with the connection's API key, username and password and trades CFDs
  through IG's REST API (demo or live by the connection's mode). Spot FX in
  the app's form maps to IG's CFD epics; other markets use their epic. Stops
  and targets ride on the entry (as force-open deals), every deal is checked
  on `/confirms`, and positions are netted per epic with the least protective
  stop reported. No 8-hour bars or stop-limit orders.
- **cTrader brokers: one integration.**
  [`CTraderAdapter`](../broker_service/ctrader_adapter.py) speaks Spotware's
  cTrader Open API (JSON over WebSocket), so one connection type reaches IC
  Markets, Pepperstone, FP Markets, Fusion and every other cTrader broker.
  It covers search, history (walked in windows), quotes, native price
  streaming, every order type including stop-limit, stops on the entry
  (as distances on a market order), position stops, positions netted across
  a hedged account, account equity and fills. Quantities are in units.
  Access tokens last about 30 days and are renewed by hand.
- **One connection type per firm:** every connection names its firm
  (OANDA, IG, IC Markets, Pepperstone, FP Markets, Fusion, another cTrader
  firm, Interactive Brokers, Alpaca, Axi, Eightcap, Vantage, another MT5
  firm), and the firm sets the platform: its web API when it has one, the
  MT5 sidecar when it does not. Interactive Brokers alone has two entries,
  its Web API and the older IB Gateway. The
  backend refuses any other pairing (`backend/src/services/firms.ts`). Axi
  has no public trading API, and its MCP server serves Claude only, so Axi
  accounts go through the MT5 sidecar. Connections saved before firms are
  listed on Getting started until each is given its firm.
- **Provider health:** the broker service exposes `/providers` (and folds
  provider status into `/health`) so operators can see which venues are
  registered.
- **`.env` connections (legacy):** a `BROKER_CONNECTIONS` manifest or the old
  single-account variables (`IB_HOST`, `MT5_BRIDGE_URL`, `OANDA_API_TOKEN`,
  `ALPACA_API_KEY` and so on) in `.env` still define connections, and for
  that broker they win over the app's (shown as overridden). Only a
  manifest can carry a per-connection `symbol_map` or `account_info_from`
  today. `./tradingapp.sh install` keeps such lines and reports them. New
  installs should not use them.

### REST & WebSocket API

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/health` | GET | Backend, DB, broker service health summary |
| `/api/health/ready` | GET | 200 once the database is reachable, migrated and opened by the encryption key; otherwise 503 with the reason |
| `/api/database/health` | GET | Postgres connection probe |
| `/api/market-data/search` | POST | Contract search |
| `/api/market-data/search/advanced` | POST | Contract search with derivatives filters |
| `/api/market-data/history` | GET | Historical bars (DB first, IB fallback) |
| `/api/market-data/realtime` | GET | Latest bid / ask / last quote |
| `/api/market-data/indicators` | GET | Computed indicators |
| `/api/market-data/upload` | POST | Persist downloaded bars to Postgres |
| `/api/market-data/database/stats` | GET | Per-symbol storage statistics |
| `/api/market-data/database/clean` | POST | Run retention cleanup |
| `/api/settings` | GET | Every Settings-page setting, its value (secrets only as set or not) and where it comes from |
| `/api/settings/:key` | PUT·DELETE | Store a setting, or return it to its default (audited) |
| `/api/settings/checklist` | GET | The Getting started checklist |
| `/api/brokers/connections` | GET·POST | List / add broker connections |
| `/api/brokers/connections/:id` | PUT·DELETE | Edit / remove a connection |
| `/api/market-data/collection` | GET·POST | Data collection entries (`data_collection_config`) |
| `/api/market-data/recorder/status` | GET | The live recorder: lag, totals, each recorded instrument's feed, and the last reconcile |
| `/api/market-data/recorder/reconcile` | POST | Replace the last two days of recorded bars with the broker's, now |
| `/api/backtesting/strategies` | GET | Available backtest strategies (cached 1h) |
| `/api/backtesting/run` | POST | Run a backtest on stored bars: by `strategy` key, saved `definition_id` or inline `rule_set`; `409` with the coverage when bars are missing |
| `/api/backtesting/coverage` | GET | How well stored bars cover an instrument, timeframe and range |
| `/api/market-data/replay` | GET | Stored 1-minute bars from a start time, and the candles before it, for bar replay |
| `/api/backtesting/runs` | GET | List persisted runs (filterable, paginated) |
| `/api/backtesting/runs/:id` | GET | Full record for a persisted run |
| `/api/export/parquet` | POST | Convert `{ columns, rows }` to a Parquet download |
| `/api/orders` | POST | Place an order (validation + audit; `broker=` venue; gated by `LIVE_TRADING_ENABLED` for live) |
| `/api/orders/:id` | DELETE | Cancel a working order |
| `/api/orders/:id` | PUT | Modify a working order |
| `/api/orders/audit` | GET | Persisted order attempts (blotter feed; `broker` filter) |
| `/api/orders/config` | GET | Live-trading gate + supported enums + brokers + the trading connections with the order types each takes |
| `/api/strategies/definitions` | GET·POST | List / create rule-set definitions (symbol + `sec_type`/`exchange`/`currency`/`broker`) |
| `/api/strategies/runs` | GET·POST | List / start systematic runs |
| `/api/strategies/runs/:id/stop` | POST | Stop a run (kill switch) |
| `/api/strategies/runs/:id/signals` | GET | Recorded signals for a run |
| `/api/strategies/evaluate` | POST | Ad-hoc rule-set evaluation (proxy) |
| `/metrics` | GET | Prometheus scrape endpoint (backend) |

Market-data reads (`/api/market-data/*`) and orders accept a `source=` /
`broker=` parameter (`ib`, `mt5`, `oanda`, `ig`, `ctrader`, `alpaca`) selecting the venue,
plus `account=` to pick a connection.

Socket.IO is mounted on the backend at the default path and its handshake
is authenticated (see [Authentication & CORS](#authentication--cors)).
Clients call `subscribe-market-data` / `unsubscribe-market-data` for a
given symbol; the backend's streaming bridge refcounts the subscription,
joins the socket to the `market-data:<platform>:<account>:<SYMBOL>` room and fans every Redis
tick out to that room. The full pipeline is described under
[Real-time streaming pipeline](#real-time-streaming-pipeline).

All endpoints return JSON. Errors carry an `error`, `message` and
`timestamp` payload. Common HTTP statuses are `400` for validation, `503`
when the broker service is unreachable, `504` on IB timeouts.

### Authentication & CORS

- **Login + API token** (`backend/src/middleware/auth.ts`): the browser signs
  in at `/login` with the password set on the first-run screen (or
  `APP_PASSWORD`) and gets an HttpOnly session cookie (signed with the stored
  session key or `SESSION_SECRET`, lifetime `SESSION_TTL_HOURS`); scripts send
  `Authorization: Bearer <token>` (or `X-API-Token`) with an API token from
  Settings > Security or `API_TOKEN`. Nothing secret is
  compiled into the frontend. Every route except health, `/metrics` and the
  login routes needs one of the two; comparisons run through
  `crypto.timingSafeEqual`.
- **Authenticated Socket.IO handshake**: the session cookie, or the token
  from `auth.token`, the `Authorization` header or a `?token=` query
  parameter.
- **Broker service lock-down**: the broker service listens on loopback only
  and rejects any call without the broker service token, which the backend
  attaches. The token and the Redis password are not in `.env`: a one-shot
  `secrets` service generates them into the `internal_secrets` Docker volume
  on first start, and `./tradingapp.sh rotate-internal-secrets` replaces
  them.
- **Trader role and order MFA**: once a trading token exists (made on
  Settings > Security, or `TRADING_TOKENS` in `.env`), order-mutating
  requests need an `X-Trading-Token`. Once order MFA is enrolled (Settings >
  Security, or `ORDER_MFA_SECRET`), they need a TOTP `X-MFA-Code`. Both are
  required for live trading, and for changing a setting that loosens a
  gate or raises a cap.
- **Startup checks**: the backend refuses to start on an unsafe
  configuration and logs the key at fault: in production, an open API,
  template secrets or a default database password; always, live trading
  without the trader role and MFA, or risk settings it cannot read
  (`KILL_SWITCH_ACTION`, `TRADING_DAY_TIMEZONE`, `PROP_RULES__*`, heartbeat
  URLs).
- **Strict CORS**: origins are validated against `CORS_ORIGINS` instead of a
  blanket wildcard. It and `TRUST_PROXY` are on Settings > Network; behind
  nginx, set the public origin there.
- **Settings API**: `/api/settings` lists only registered settings. Secret
  values are never returned, only whether they are set, and they are stored
  encrypted with `SETTINGS_ENCRYPTION_KEY`. Bootstrap values (database,
  encryption key, internal secrets, ports) are not registered, so they are
  neither listed nor writable. Every change is recorded (Settings > History).
- **Dev escape hatch**: outside production, with no login password and no
  API token anywhere (or `CORS_ORIGINS=*`), the backend prints a loud startup
  warning and accepts unauthenticated / any-origin requests. Convenient
  locally, never for production. In production the same state shows the
  first-run setup screen instead.

### Redis caching

The bundled Redis container is wired into the backend
(`backend/src/services/cache.ts`) as a read-through cache:

- `/api/market-data/realtime`: `CACHE_TTL_REALTIME` seconds (default `2`).
- `/api/market-data/indicators/available`: long-lived, refreshed through
  the cache wrapper.

A Redis outage degrades to a cache miss: every endpoint keeps working.
Cache health surfaces in `/api/health` under `services.cache`. Turn
`REDIS_ENABLED` off (Settings > Schedulers and data) to bypass caching entirely.

### Interactive Brokers integration

- Built on the official Interactive Brokers TWS API (`ibapi`).
- A **single synchronous IB client** by default. An opt-in pool
  (`IB_CLIENT_POOL_SIZE` of 2 or more, `broker_service/ib_pool.py`) exists,
  but `./tradingapp.sh install` currently removes that line from `.env` as
  obsolete, so it does not survive a re-run.
- `get_ib_connection()` in `broker_service/ib_client.py` re-establishes the socket if
  IB Gateway drops the connection.
- IB is added as a connection on Settings > Connections (Gateway host, Port,
  Client ID).
- UTC timezone enforcement throughout the broker service so timestamps round-
  trip cleanly to lightweight-charts.

### Performance

- **Database-first reads.** Chart history reads stored bars first and asks
  the broker only for what is missing, so repeat loads are fast and avoid
  broker rate limits.
- **TimescaleDB.** Bars and ticks live in hypertables (time-chunked), with a
  daily continuous aggregate. Ticks are dropped after 30 days; bars are kept
  until the app's own retention cleanup removes them.
- **Redis cache.** The busiest read endpoints go through a read-through
  cache that degrades to a miss when Redis is down.
- **Streaming, not polling.** Live ticks are pushed over Socket.IO, with one
  broker subscription per symbol however many browsers watch it.
- **Linear backtests.** Jesse indicator results are memoised per candle
  history, so a bar-by-bar backtest stays linear in the number of bars.

### Settings page and Getting started

- **Settings page** (`/settings`): every runtime setting, grouped into
  tabs: Connections, Trading, Risk, Alerts and safety, Strategies,
  Schedulers and data, Security, Network, History. Each shows its key, its
  value and where the value comes from. Changes are stored in the database
  and audited. A setting that loosens a gate or raises a cap needs the
  trader role and MFA, like placing an order; the safer direction does
  not.
- **Pinning in `.env`:** any setting can still be set in `.env` by its key.
  It then wins and shows as locked. `./tradingapp.sh settings-import` moves
  such lines into the app.
- **Getting started checklist:** at the top of the Settings page, computed
  from state: login password set, a trading token and order MFA, a broker
  connection added, instruments chosen for data collection with the
  backfill scheduler on, and alerts (Telegram and the heartbeat URL).
- **First sign-in:** with no login password set, the backend prints a
  one-time setup code at startup (`./tradingapp.sh setup-code` shows it).
  The first visit asks for it, then for the password. `APP_PASSWORD` in
  `.env` is the way back in if the password is lost.

### Deployment & operations

- Docker Compose stack: `frontend`, `backend`, `broker_service`, `redis`,
  and by default a bundled TimescaleDB (`docker-compose.db.yml`). An external
  PostgreSQL with TimescaleDB works too (`--external-db`).
- **One command to commission:** `./tradingapp.sh install` installs Docker if
  needed, writes a seven-key `.env` (the `POSTGRES_*` connection and
  `SETTINGS_ENCRYPTION_KEY`), builds and starts the stack, waits until the
  backend is ready, and prints the address and setup code. Re-running it
  upgrades or repairs. It never replaces an existing password or key.
- **The database comes first:** the backend waits for its database, applies
  the schema and migrations, checks the encryption key, and only then serves.
  Until then every API route answers 503 with the reason and the page shows
  it.
- **Management script:** `./tradingapp.sh` with `install`, `deploy`,
  `redeploy`, `start`, `stop`, `restart`, `status`, `logs`, `setup-code`,
  `doctor`, `test`, `migrate`, `settings-import`, `backup-key`,
  `rotate-internal-secrets`, `forget-secrets`, `fix` and `clean`
  ([OPERATIONS.md](OPERATIONS.md#commands)).
- **Unattended install:** `install/install.sh` with an answers file, ending
  in a machine-checked report
  ([INSTALL.md Appendix A](INSTALL.md#appendix-a-the-installer-in-detail)).
- **MT5 sidecar** with a Task Scheduler launcher for Windows and a systemd
  unit and install script for Linux under Wine
  ([INSTALL.md § 4.2](INSTALL.md#42-metatrader-5-vm-120)).

### Testing, linting & CI

- **Backend:** ESLint + Prettier + Jest/Supertest
  (`npm run lint` / `format:check` / `type-check` / `test`).
- **Frontend:** ESLint + Prettier + Vitest (`apiFetch` test suite).
- **Broker service:** Ruff + Black + pytest (indicator math + streaming tests
  under `broker_service/tests/`).
- **MT5 sidecar:** Ruff + Black + pytest against a fake `MetaTrader5`
  module, plus a contract test running `MT5Adapter` against the sidecar.
- **End-to-end paper run:** `e2e/run.sh` starts the backend and broker
  service against TimescaleDB and two simulated MT5 terminals behind the real
  sidecar, deploys a strategy and checks the orders, stops, trailing and
  fills that follow (the paper runbook's steps 11 to 22).
- **CI:** `.github/workflows/ci.yml` runs lint, format-check, type-check,
  tests and build for every service, plus the end-to-end paper run, on every
  push / PR to `master` (and `main`).

---

## Planned / Roadmap

Not yet implemented. Design records for the larger pieces are in
[`plans/`](plans/); deferred decisions are registered in
[`FUTURE_DECISION_POINTS.md`](plans/FUTURE_DECISION_POINTS.md).
The current review, with every planned enhancement in priority order and
which model can do each, is
[`ENHANCEMENT_PLAN.md`](plans/ENHANCEMENT_PLAN.md).

### Known gaps in what ships

- **Connections form:** an MT5 connection's symbol map and its "account info
  from" link cannot be entered on Settings > Connections yet. Until they can,
  they need SQL or a `.env` manifest, each with a catch
  ([INSTALL.md § 4.9](INSTALL.md#49-not-yet-on-the-form-symbol-maps-and-account-info-from)).
- **Single points of failure per venue:** IB Gateway and each MT5 terminal
  are one logged-in session on one host with no standby. A logout stops that
  venue until someone logs it back in; the connection checks and alerts make
  it visible.
- **Price-action rule vocabulary:** the rule engine expresses indicator logic;
  candle geometry, swing structure and sequenced setups are planned
  ([`SYSTEMATIC_STRATEGY_IMPLEMENTATION_PLAN.md`](plans/SYSTEMATIC_STRATEGY_IMPLEMENTATION_PLAN.md)).

### Systematic trading: open follow-ons

The authoring loop (build a rule-set → backtest it → deploy it live on any
instrument or venue) ships today. What remains, in priority order. See
[`SYSTEMATIC_TRADING_ROADMAP.md`](plans/SYSTEMATIC_TRADING_ROADMAP.md) §9:

- **Entry and exit fills at the market.** Protective stops now fill inside
  the bar (see [Backtesting](#backtesting)). Entries and rule exits still
  fill at the close of the signal bar, where live they fill at the next
  price; with 1-minute bars stored that could be the next minute's open.
- **Futures / options contract multipliers on IB.** The IB instrument spec is
  the whole-share constant: right for the equity path the app trades, but a
  futures contract's multiplier would need `reqContractDetails`.

### Authentication, authorisation & secrets (advanced)

- Per-user accounts and finer-grained roles. A single login, the trader
  role (`TRADING_TOKENS`), order MFA and the `order_audit` log ship today.

### Observability: open follow-ons

The first two observability passes have shipped (`pino` / `structlog` /
`/metrics` / `X-Request-Id` / Grafana dashboard / service-layer log
sweep), and the Prometheus alerting rules now ship in
[`ops/prometheus/alerts.yml`](../ops/prometheus/alerts.yml) (target-down,
5xx error-rate, p95 latency and event-loop-lag alerts that reuse the
dashboard's metrics). What is still open:

- Route handlers in `backend/src/routes/marketData/*` still use
  `console.*` for one-line per-call logging. It is covered by the
  observability middleware's structured "request completed" entry, but
  worth converting on a touch-as-you-go basis.

### Frontend UX

- Price-alert delivery beyond the browser tab (email/SMS/webhook). In-app
  price alerts with browser notifications have shipped, see
  [Watchlist](#watchlist). Trading and risk alerts already go to Telegram
  ([Risk controls](#risk-controls-kill-switch--alerting)).
- Sector / scanner browsing.

### Test coverage expansion

The lint / format / type-check / test scaffolding and a CI workflow gated
on `master` have **shipped** (see
[Testing, linting & CI](#testing-linting--ci)). What remains is breadth:

- Frontend component tests (React Testing Library) beyond the current
  `apiFetch` suite.
- Backend route/integration coverage beyond the initial validation tests.
- Done: IB-service tests around the historical-data assembly path: a
  `FakeIBApp` stand-in for `EClient`/`EWrapper`
  ([`broker_service/tests/test_market_data_history_route.py`](../broker_service/tests/test_market_data_history_route.py))
  exercises `GET /market-data/history` end-to-end (contract-qualification,
  the period vs. date-range branches, the 404/503 failure paths, and the
  hand-off into `bars_processing`) without a real IB Gateway, network
  call or background thread.

---

## How to Use Today's Features

### Workflow: explore a US stock

1. Open the app in your browser and go to the home page.
2. In **Market Data Search & Filter**, type a symbol (e.g. `AAPL`) and
   select security type `STK`, exchange `SMART`.
3. Click search; pick the desired contract from the results.
4. Switch timeframes / periods on the chart that appears.
5. Toggle indicators (SMA, EMA, RSI, MACD, Bollinger Bands, etc.) from the
   indicator selector.

### Workflow: persist 1 year of bars

1. Open `/download`.
2. Choose symbol, security type, exchange and timeframe.
3. Pick the `1Y` period (or a custom date range).
4. Click **Download from IB API**, review the DataFrame preview.
5. Click **Load to PostgreSQL**; the backend upserts the bars and reports
   inserted / updated counts.
6. Future chart loads read from the database (faster, no broker rate
   limits). To keep the bars topped up automatically, add the instrument on
   Settings > Schedulers and data instead.

### Workflow: run a backtest

From the UI:

1. Open `/backtest` (linked from the home page).
2. Pick a strategy from the dropdown (`ma_crossover`, `rsi_mean_reversion`).
3. Set the symbol, timeframe, period, starting capital and commission, then
   click **Run backtest**.
4. Review the metrics summary, equity-curve chart and trade-list table.

Or call the backend API with an API token from Settings > Security:

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://<server-ip>:4000/api/backtesting/strategies | jq

curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"symbol":"MSFT","strategy":"ma_crossover","timeframe":"1day"}' \
  http://<server-ip>:4000/api/backtesting/run
```

---

If you spot a feature here that should be in *Available* but isn't, or
vice-versa, please open an issue. Keeping this split honest is ongoing
hygiene.
