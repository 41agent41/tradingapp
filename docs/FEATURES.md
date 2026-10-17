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
   - [Real-time MSFT view](#real-time-msft-view)
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
| Stocks and ETFs | MSFT, AAPL, SPY | IB, Alpaca |
| Options | MSFT calls and puts | IB, Alpaca |
| Futures | ES, NQ, YM | IB |
| Forex | EUR.USD, GBP.USD | OANDA, MT5, IB |
| CFDs | indices, metals | OANDA, MT5 |

### Historical charts

A TradingView **lightweight-charts** candlestick chart with volume bars,
served from the `/historical` and per-symbol pages.

- **Timeframes shipped:** `tick`, `1min`, `5min`, `15min`, `30min`, `1hour`,
  `4hour`, `8hour`, `1day`.
- **Periods shipped:** `1D`, `5D`, `1M`, `3M`, `6M`, `1Y`, plus a
  `CUSTOM` start/end date range.
- **Data source:** backend reads from the database first
  (`use_database=true`, the default) and falls back to a live request to the
  broker if the rows aren't stored.
- **Interactions:** zoom, pan, crosshair, auto-fit, all built into
  `lightweight-charts`.

### Real-time MSFT view

A dedicated `/msft` page implements the `.cursorrules` brief: an MSFT chart
that you can switch across the 5m / 15m / 30m / 1h / 4h / 8h / 1d
timeframes with up to 12 months of history.

The page now consumes a true real-time tick stream: the broker service
calls `reqMktData` on IB Gateway and publishes every tick to Redis,
the backend forwards each tick into a Socket.IO room, and the page's
`useRealtimeStream` hook updates the price display as ticks arrive.
A one-shot REST call seeds the badge before the first tick lands and
acts as a fallback when streaming is disabled.

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
  every tick to `marketdata:tick:<SYMBOL>` on Redis.
- **Bridge:** `backend/src/services/streamingBridge.ts` holds a second
  Redis client in subscribe mode and forwards each tick to the
  `market-data:<SYMBOL>` Socket.IO room.
- **Consumer:** the frontend `useRealtimeStream` hook
  (`frontend/app/lib/useRealtimeStream.ts`) joins the room and updates the
  price display as ticks arrive.
- **Refcounting & cleanup:** both sides refcount per symbol, so multiple
  browsers on one symbol create a single IB subscription; on disconnect the
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
toggle them on the chart.

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
  to scope the instrument and the venue (defaults: `STK`/`SMART`/`USD`/`ib`).
- **UI:** the `/backtest` page (`frontend/app/backtest/page.tsx`) with a
  strategy picker (saved rule-sets grouped above the built-ins), parameter
  form, instrument fields, metrics summary, equity-curve chart
  (`EquityCurveChart`), trade-list table and a **Previous Runs** panel
  that click-to-loads any prior run without re-running the engine.

**Persistence** ships now: every successful run is upserted into
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
- **Data-quality metrics.** Every store path (manual upload, the
  `/history` cache-on-fetch and the backfill worker) records per-day
  total / missing / duplicate / invalid bar counts and a quality score
  into `data_quality_metrics`. They surface through
  `GET /api/market-data/database/stats`.
- **Retention cleanup with real counts.** `POST /api/market-data/database/clean`
  deletes bars older than each row's `retention_days` and reports the
  actual number removed (per config). This complements TimescaleDB's own
  chunk-dropping retention policy.

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
  The backtester qualifies the contract before requesting bars, and both the
  backtester and the live runner fetch data from the run's **own** broker
  rather than always from IB.
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

- **Connections in the app:** brokers are added on Settings > Connections,
  one connection per account, in priority order OANDA, then MT5, then IB,
  then Alpaca (the order can be changed there). Each connection has a name,
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
- **Alpaca and OANDA: cloud REST, no sidecar host.** Unlike MT5, both are
  reachable directly over HTTPS, so
  [`AlpacaAdapter`](../broker_service/alpaca_adapter.py) and
  [`OANDAAdapter`](../broker_service/oanda_adapter.py) run in-process in
  `broker_service`. Their connections take API credentials (Alpaca: API key
  and secret; OANDA: account id and token) instead of a bridge URL. Both implement the same data + execution surface as
  MT5. OANDA has a native 8-hour candle (unlike MT5) so every app timeframe
  maps cleanly; `STP_LMT` orders aren't representable on OANDA and are
  rejected with a 400. OANDA entries carry their stop loss and take profit
  on the fill, and positions report the stop per trade.
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
| `/api/backtesting/strategies` | GET | Available backtest strategies (cached 1h) |
| `/api/backtesting/run` | POST | Run a backtest: by `strategy` key, saved `definition_id` or inline `rule_set` |
| `/api/backtesting/runs` | GET | List persisted runs (filterable, paginated) |
| `/api/backtesting/runs/:id` | GET | Full record for a persisted run |
| `/api/export/parquet` | POST | Convert `{ columns, rows }` to a Parquet download |
| `/api/orders` | POST | Place an order (validation + audit; `broker=` venue; gated by `LIVE_TRADING_ENABLED` for live) |
| `/api/orders/:id` | DELETE | Cancel a working order |
| `/api/orders/:id` | PUT | Modify a working order |
| `/api/orders/audit` | GET | Persisted order attempts (blotter feed; `broker` filter) |
| `/api/orders/config` | GET | Live-trading gate + supported enums + brokers |
| `/api/strategies/definitions` | GET·POST | List / create rule-set definitions (symbol + `sec_type`/`exchange`/`currency`/`broker`) |
| `/api/strategies/runs` | GET·POST | List / start systematic runs |
| `/api/strategies/runs/:id/stop` | POST | Stop a run (kill switch) |
| `/api/strategies/runs/:id/signals` | GET | Recorded signals for a run |
| `/api/strategies/evaluate` | POST | Ad-hoc rule-set evaluation (proxy) |
| `/metrics` | GET | Prometheus scrape endpoint (backend) |

Market-data reads (`/api/market-data/*`) and orders accept a `source=` /
`broker=` parameter (`ib`, `mt5`, `oanda`, `alpaca`) selecting the venue,
plus `account=` to pick a connection.

Socket.IO is mounted on the backend at the default path and its handshake
is authenticated (see [Authentication & CORS](#authentication--cors)).
Clients call `subscribe-market-data` / `unsubscribe-market-data` for a
given symbol; the backend's streaming bridge refcounts the subscription,
joins the socket to the `market-data:<SYMBOL>` room and fans every Redis
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
  daily continuous aggregate and retention policies that drop old chunks.
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

### Known gaps in what ships

- **Connections form:** an MT5 connection's symbol map and its "account info
  from" link cannot be entered on Settings > Connections yet. Until they can,
  they need SQL or a `.env` manifest, each with a catch
  ([INSTALL.md § 4.6](INSTALL.md#46-not-yet-on-the-form-symbol-maps-and-account-info-from)).
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

- **Intrabar fills.** The backtester fills at the bar close; live fills happen
  at the market. Sessions, multi-timeframe operands, position-aware rules,
  sizing and scale-outs now share one code path between the two engines, so
  this is the main remaining source of backtest↔live drift.
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
