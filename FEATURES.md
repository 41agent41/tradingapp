# TradingApp Features

This document describes what TradingApp does **today** and what is on the
**roadmap**. The two are kept in separate sections so the available
capabilities never get conflated with aspirational plans.

> The full gap analysis and prioritised roadmap live in
> [`GAP_ANALYSIS.md`](GAP_ANALYSIS.md). The list below is a more accessible
> summary aimed at end users.

---

## Table of Contents

1. [Currently Available](#currently-available)
   - [Market data search](#market-data-search)
   - [Historical charts](#historical-charts)
   - [Real-time MSFT view](#real-time-msft-view)
   - [Real-time streaming pipeline](#real-time-streaming-pipeline)
   - [Technical indicators](#technical-indicators)
   - [Backtesting](#backtesting)
   - [Historical data download](#historical-data-download)
   - [Automated data collection & retention](#automated-data-collection--retention)
   - [Fills, positions & realised P&L](#fills-positions--realised-pl)
   - [Account read endpoints](#account-read-endpoints)
   - [Watchlist](#watchlist)
   - [Order management](#order-management)
   - [Systematic trading (auto-execution)](#systematic-trading-rule-driven-auto-execution)
   - [Multi-broker: IB + MetaTrader + Alpaca + OANDA](#multi-broker-interactive-brokers-metatrader-mt5-alpaca-oanda)
   - [REST & WebSocket API](#rest--websocket-api)
   - [Authentication & CORS](#authentication--cors)
   - [Redis caching](#redis-caching)
   - [Interactive Brokers integration](#interactive-brokers-integration)
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
- **Exchanges**: any exchange IB exposes — including `SMART`, US exchanges
  (`NYSE`, `NASDAQ`, …) and the Australian exchanges configured under the
  exchange-driven filters.
- **Currency** filter (USD, AUD, EUR, etc., as IB returns them).
- **Advanced search** with optional `expiry`, `strike`, `right`,
  `multiplier`, `includeExpired` for derivatives.
- **Symbol discovery** endpoint (`/symbols/discover`) with a 1-hour TTL
  cache.

Contracts returned are persisted into the `contracts` table so they don't
have to be re-resolved.

### Historical charts

A TradingView **lightweight-charts** candlestick chart with volume bars,
served from the `/historical` and per-symbol pages.

- **Timeframes shipped:** `tick`, `1min`, `5min`, `15min`, `30min`, `1hour`,
  `4hour`, `8hour`, `1day`.
- **Periods shipped:** `1D`, `5D`, `1M`, `3M`, `6M`, `1Y`, plus a
  `CUSTOM` start/end date range.
- **Data source:** backend reads from the external Postgres first
  (`use_database=true`, the default) and falls back to live IB requests if
  the rows aren't cached.
- **Interactions:** zoom, pan, crosshair, auto-fit — all built into
  `lightweight-charts`.

### Real-time MSFT view

A dedicated `/msft` page implements the `.cursorrules` brief: an MSFT chart
that you can switch across the 5m / 15m / 30m / 1h / 4h / 8h / 1d
timeframes with up to 12 months of history.

The page now consumes a true real-time tick stream: the IB service
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
- **Controls:** set `STREAMING_ENABLED=false` to disable the bridge (charts
  fall back to one-shot REST seeding). Health is reported under
  `services.streaming` in `/api/health` and at the IB service's
  `GET /market-data/stream/status`.

### Technical indicators

`broker_service/indicators.py` ships a pandas/numpy implementation of:

- **Trend:** SMA, EMA, WMA, MACD
- **Momentum:** RSI, Stochastic, Williams %R
- **Volatility:** Bollinger Bands, ATR, Keltner Channels
- **Volume:** OBV, Volume SMA, VWAP

These are exposed via `GET /api/market-data/indicators` (backend) and
`GET /indicators/available` (IB service). The frontend
`IndicatorSelector` and `TechnicalIndicatorsFilter` components let users
toggle them on the chart.

### Backtesting

`broker_service/backtesting.py` ships an event-driven backtest engine and two
sample strategies:

- `ma_crossover` (simple moving-average crossover)
- `rsi_mean_reversion`

Reachable two ways:

plus every **saved rule-set** authored in the `/systematic` rule builder — see
[Systematic trading](#systematic-trading-rule-driven-auto-execution).

- **API:** `GET /backtesting/strategies` and `POST /backtesting/run` on the
  IB service, or the validating backend proxy at `GET /api/backtesting/strategies`
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

### Historical data download

A `/download` page lets you pull historical OHLCV bars from IB and persist
them into the external Postgres. See [`DOWNLOAD_FEATURE.md`](DOWNLOAD_FEATURE.md)
for the full walk-through.

- Choose market / exchange / security type / symbol / currency.
- Predefined periods (`1D`, `1W`, `1M`, `3M`, `6M`, `1Y`) or a custom date
  range.
- Any of the shipped timeframes including tick.
- Preview the result in an in-page DataFrame viewer.
- Push to Postgres via `POST /api/market-data/upload` with upsert
  semantics.
- Export the visible (filtered + sorted) rows as **CSV** (RFC 4180,
  client-side), **JSON** (client-side) or **Parquet** (encoded server-side
  via `POST /api/export/parquet`, then streamed back as a download).

### Automated data collection & retention

Beyond the manual *Download* page, the backend can keep the database
topped up and pruned on its own:

- **Scheduled backfill (opt-in).** With `BACKFILL_ENABLED=true`, the
  backend periodically reads every enabled `auto_collect` row from the
  `data_collection_config` table, fetches the recent `BACKFILL_PERIOD`
  window from the IB service and upserts it — respecting each row's
  `collection_interval_minutes` so slow-moving data isn't refetched every
  tick. Progress is visible under `services.backfill` in `/api/health`.
- **Data-quality metrics.** Every store path (manual upload, the
  `/history` cache-on-fetch and the backfill worker) records per-day
  total / missing / duplicate / invalid bar counts and a quality score
  into `data_quality_metrics`. They surface through
  `GET /api/market-data/database/stats`.
- **Retention cleanup with real counts.** `POST /api/market-data/database/clean`
  deletes bars older than each row's `retention_days` and reports the
  actual number removed (per config). This complements TimescaleDB's own
  chunk-dropping retention policy.

See [`DEPLOYMENT.md`](DEPLOYMENT.md#data-collection--retention-phase-5) for
how to populate `data_collection_config` and tune the scheduler.

### Fills, positions & realised P&L

`order_audit` records what the app *asked* a venue to trade. That is not the
same as what traded — a partial fill, a rejection that lands after the
acknowledgement, and any trade placed outside the app all leave the two
disagreeing, silently. With `EXECUTIONS_SYNC_ENABLED=true` the backend closes
that gap:

- **The fills feed.** `GET /account/executions` on the broker service reports
  each venue's own execution reports, normalised to one shape (IB via
  `execDetails` + `commissionReport`, Alpaca via `FILL` activities, OANDA via
  `ORDER_FILL` transactions, MT5 via the sidecar's deals). A backend poller
  pulls each active venue on a timer into the `order_executions` table.
- **Idempotent by design.** Every poll re-reads an overlapping window, because
  a fill can be reported late and IB delivers a fill's commission on a callback
  separate from the fill itself. Rows upsert on `(broker, exec_id)`, so
  re-delivery updates rather than duplicates — and a late commission can fill a
  blank without a later poll ever erasing one already recorded.
- **Attribution.** Each fill is linked back through the venue's order id to its
  `order_audit` row and, from there, to the `strategy_run` that caused it. A
  fill polled before its order id was recorded is picked up by a re-link pass
  on the next tick. A fill with *no* order of ours behind it stays unattributed
  on purpose — a manual trade is real exposure and belongs in the position.
- **Realised P&L.** Computed on an average-cost basis with commissions
  subtracted at the time they are charged, handling partial exits and
  reversals through flat. Exposed at `GET /api/account/pnl`, and consumed by a
  strategy run's `max_daily_loss` cap.
- **Positions come from fills *plus* still-working orders.** Neither alone is
  right: fills lag the poller, so an order placed seconds ago would read as
  flat and a strategy could re-enter a position it already holds; submitted
  orders can't see a partial fill and drop a partially-filled-then-cancelled
  order entirely. Every fill counts whatever became of its order, and every
  live order contributes only its *unfilled remainder* — so an order moves
  from "in flight" to "filled" without ever being double-counted or briefly
  invisible. Scoped to a run it is that run's own ledger (a second run on the
  same symbol can't change its pyramiding); unscoped it is account exposure at
  the venue, which is what `ORDER_MAX_POSITION` caps.
- **Reconciliation.** Per-run attribution can drift from the account — a manual
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

- `GET /api/account/summary` — balances and key metrics. Also the source of
  the equity that `pct_equity` position sizing reads.
- `GET /api/account/positions` — current positions.
- `GET /api/account/orders` — orders still working at the venue.
- `GET /api/account/all` — all of the above in one call.
- `GET /api/account/connection` — IB connection state.

Two further endpoints read the local **fills** store rather than the venue:

- `GET /api/account/executions` — recorded fills, filterable by
  `broker` / `symbol` / `account_mode` / `run_id`. Each row carries its
  attribution (`order_audit_id`, `run_id`) — something a raw venue payload
  has no idea about. `?fresh=true` reads live from the venue instead.
- `GET /api/account/pnl` — realised P&L and per-symbol breakdown over those
  fills (defaults to today, the window a run's `max_daily_loss` is measured
  over).
- `GET /api/account/reconciliation` — the app's recorded net position per
  symbol against the venue's, with a `matched` flag per row.

> These endpoints are read-only. The write path lives under `/api/orders/*`
> and requires `LIVE_TRADING_ENABLED=true` for any live order — see the
> *Order management* section below.

### Watchlist

A single flat list of symbols to keep an eye on, independent of any
broker/backtest workflow:

- **Page:** `/watchlist`, plus a quick-access tile on the home page.
- **Component:** [`Watchlist`](frontend/app/components/Watchlist.tsx),
  backed by the [`useWatchlist`](frontend/app/lib/useWatchlist.ts) hook.
- **Backend:** `GET /api/watchlist` (list), `POST /api/watchlist` (add —
  idempotent: adding an already-watched contract returns the existing
  row instead of erroring), `DELETE /api/watchlist/:id` (remove),
  persisted in the `watchlist_items` table
  ([`WatchlistRepository`](backend/src/services/watchlistRepository.ts)).
- **Live quotes:** each row polls the existing (Redis-cached)
  `GET /api/market-data/realtime` endpoint every 15s — no new IB traffic
  or streaming subscription is introduced by adding a symbol here.
- Symbols are broker-scoped (`broker`/`sec_type`/`exchange`/`currency`,
  defaulting to `ib`/`STK`/`SMART`/`USD`) so the same ticker on two
  venues can be tracked as separate rows.
- **Price alerts (in-app only):** set an "above" or "below" target price
  on any watchlist row. There is no server-side price watcher or external
  delivery channel — the row already polls its quote every 15s, so the
  frontend itself compares each active alert against that quote and flips
  it to `triggered` the moment it crosses
  (`POST /api/alerts/:id/trigger`). Triggered alerts persist in the
  `price_alerts` table (`PriceAlertRepository`) — mounted at
  `/api/alerts` (`GET`/`POST /api/alerts`, `POST /api/alerts/:id/trigger`,
  `POST /api/alerts/:id/dismiss`, `DELETE /api/alerts/:id`) — so they
  survive a refresh and show up in a banner at the top of the page (with
  a **Dismiss** button) even in a second tab. A **Enable browser
  notifications** control (Web `Notification` API, permission-gated) adds
  an OS-level toast on top of the in-page banner. Deleting a watchlist
  item cascades to its alerts.
- **Not yet implemented:** email/SMS/webhook delivery, manual reordering,
  multiple named lists.

### Order management

Place, cancel and modify orders against IB Gateway from the UI:

- **Components:** [`OrderTicket`](frontend/app/components/OrderTicket.tsx)
  and [`OrderBlotter`](frontend/app/components/OrderBlotter.tsx).
- **Pages:** a full surface at `/trade` (ticket + blotter), plus a
  compact ticket on the Orders tab of `/account`.
- **Order types:** MKT, LMT, STP, STP_LMT. **TIF:** DAY, GTC, IOC,
  FOK. The ticket reveals limit / stop inputs only when the order
  type needs them.
- **Backend proxy:** `POST /api/orders` (create),
  `DELETE /api/orders/:id` (cancel), `PUT /api/orders/:id` (modify),
  `GET /api/orders/audit` (blotter feed), `GET /api/orders/config`
  (surface the gate + enums to the UI).
- **Audit log:** every attempt — paper or live — writes a row to
  `order_audit` with the input set, the IB order id once known, the
  `X-Request-Id`, status transitions and raw IB response. The
  backend refuses to forward an order if the audit insert fails.
- **Defence-in-depth gate:** `LIVE_TRADING_ENABLED=true` must be set
  on **both** the backend and the IB service. Setting it on only one
  rejects every live submission with HTTP 403. Paper orders work
  regardless. The Live option is also greyed out in the UI when the
  config probe reports the gate as off, and a confirmation modal
  protects every live submission.
- **Fat-finger caps:** `ORDER_MAX_QUANTITY` (default 100k) and
  `ORDER_MAX_PRICE` (default $1M) are enforced by the validator.
- **Position-limit guard (opt-in):** set `ORDER_MAX_POSITION` > 0 to cap
  the net signed exposure per `(broker, symbol, account_mode)` implied by the
  audit log. A create whose projected net would breach the cap is
  rejected with HTTP 422 before any broker call. Only orders within
  `ORDER_POSITION_LOOKBACK_HOURS` (default 24) count. It is a soft guard
  on submitted orders, not authoritative fills. Keying on `broker` means
  exposure never nets across venues.

### Systematic trading (rule-driven auto-execution)

Evaluate declarative criteria against live bars and place orders
automatically — paper-first, staged behind gates. See the
[Systematic Trading roadmap](SYSTEMATIC_TRADING_ROADMAP.md) for the full design.

- **Rule-driven strategies:** a strategy is one declarative rule-set (entry /
  exit conditions, sessions, multi-timeframe operands, position-aware fields,
  sizing, risk) shared by the backtester **and** the live runner
  ([`broker_service/rule_strategy.py`](broker_service/rule_strategy.py)). Evaluated
  statelessly via `POST /strategies/evaluate`.
- **Definitions & runs:** create/list rule-sets and start/stop runs through
  `/api/strategies/*`; each run pins a definition to a broker + `account_mode`.
- **Backtest before you deploy:** a saved definition can be backtested without
  being re-keyed — the `/backtest` strategy picker lists *Saved rule-sets*
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
  `position.size`, `position.avg_price` and `position.unrealized_pct` — stops,
  pyramiding caps, scale-out thresholds — behave in a backtest the way they
  behave live. Live, the average entry price comes from the venue's reported
  average cost, so an unrealised-loss stop actually fires.
- **Sizing and partial exits are simulated too:** the backtester resolves the
  definition's `sizing` block (`fixed` / `notional` / `pct_equity`) instead of
  going all-in, and drives its `scale_out` rungs per bar against the open
  trade — each rung firing at most once per trade. A strategy sized at 100
  shares with "take half off at +3%" therefore produces the same trade
  sequence in backtest as it does live. A strategy that declares no sizing
  keeps the original all-in behaviour, so the built-in strategies are
  unchanged.
- **Sizing is in the venue's own units.** "Buy 1" is one share on IB or Alpaca,
  one unit of the base currency on OANDA, and one *lot* on MT5 — which at a
  standard contract size controls 100,000 units. The venue supplies an
  instrument spec (`GET /instrument/spec`) with its `contract_size`,
  `size_step` and `min_size`; notional and percent-of-equity sizing divide by
  `price × contract_size`, sizes floor onto the step (never round up past what
  was asked for) and are refused below the minimum. The live sizer and the
  backtester share these semantics, so an FX strategy backtests at the size it
  would actually trade.
- **Live signal runner:** an opt-in backend timer (`SYSTEMATIC_ENABLED=true`)
  evaluates every running strategy on its closed-bar cadence, persists each
  decision to `strategy_signals` (one per bar) and fans it out on the
  `strategy:<runId>` Socket.IO room.
- **Gated auto-execution:** with `SYSTEMATIC_EXECUTION_ENABLED=true` an
  actionable signal is turned into an order through the **same** audited
  `/api/orders` path — inheriting the live gate, `order_audit`, the fat-finger
  caps and the position-limit guard. Engine-level guards on top: a per-run kill
  switch, per-run `max_orders_per_day` + a global `SYSTEMATIC_MAX_ORDERS_PER_DAY`
  backstop, a per-run `max_daily_loss` measured against **realised P&L from
  fills**, broker-unit-aware sizing (`fixed` / `notional` / `pct_equity`, fed by
  the venue's own equity and instrument spec), and signal→order dedupe. Both
  gates default **off**; live (vs paper) auto-trading additionally needs
  `LIVE_TRADING_ENABLED`.

  `max_daily_loss` gates **entries only** — blocking an exit would strand the
  position in the trade that caused the loss. It needs the fills feed
  (`EXECUTIONS_SYNC_ENABLED=true`); with the feed off, a declared cap fails
  *closed* rather than trading against a limit it cannot evaluate.
- **Monitoring UI (`/systematic`):** a rule builder, a definitions list (start a
  run), a run dashboard (status, last-eval, per-run **Stop**) and a per-run
  detail with a candle chart carrying buy/sell **signal markers** (acted orders
  bolder), a summary strip (net position, signals, orders placed) and a
  live-updating signal feed.

### Multi-broker: Interactive Brokers, MetaTrader (MT5), Alpaca, OANDA

The IB Gateway is no longer hard-wired — a venue-agnostic adapter seam lets
other brokers plug in without touching the routes.

- **Adapter registry** ([`broker_service/adapters.py`](broker_service/adapters.py)):
  `MarketDataAdapter` / `BrokerAdapter` protocols keyed by provider. A request's
  `source=` (market data) / `broker=` (orders) resolves to the concrete adapter,
  defaulting to `ib`; an unknown provider → 400, a recognised-but-unconfigured
  one → 501. `source=ib` / `broker=ib` behaviour is byte-for-byte unchanged.
- **Broker-scoped instruments:** contract catalogues, positions and the
  net-exposure cap are keyed per broker — no cross-broker symbol reconciliation,
  and a strategy run targets exactly one venue.
- **MetaTrader (MT5) via sidecar:** `MetaTrader5` is Windows-only, so MT5 runs as
  a small HTTP service on a Windows host; the Linux
  [`MT5Adapter`](broker_service/mt5_adapter.py) is a thin client pointed at
  `MT5_BRIDGE_URL`, implementing both **data** (search / bars / quotes / ticks,
  normalised to the app's shapes) and **execution** (place / cancel / modify /
  positions / account, with the same validation + live gate as IB). When
  `MT5_BRIDGE_URL` is set, `source=mt5` / `broker=mt5` become available;
  otherwise MT5 is a recognised-but-unavailable provider. When
  `MT5_BRIDGE_SECRET` is also set, every request to the sidecar carries an
  `X-MT5-Bridge-Secret` header — the sidecar itself must enforce it, since the
  bridge contract otherwise has no auth story; `broker_service` logs a startup
  warning if the URL is configured without the secret.
- **Alpaca and OANDA — cloud REST, no sidecar host.** Unlike MT5, both are
  reachable directly over HTTPS, so
  [`AlpacaAdapter`](broker_service/alpaca_adapter.py) and
  [`OANDAAdapter`](broker_service/oanda_adapter.py) run in-process in
  `broker_service` — gated by API credentials
  (`ALPACA_API_KEY`/`ALPACA_API_SECRET`, `OANDA_API_TOKEN`/`OANDA_ACCOUNT_ID`)
  instead of a bridge URL. Both implement the same data + execution surface as
  MT5. OANDA has a native 8-hour candle (unlike MT5) so every app timeframe
  maps cleanly; `STP_LMT` orders aren't representable on OANDA and are
  rejected with a 400.
- **Provider health:** the broker service exposes `/providers` (and folds
  provider status into `/health`) so operators can see which venues are
  registered.

### REST & WebSocket API

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/health` | GET | Backend, DB, broker service health summary |
| `/api/database/health` | GET | Postgres connection probe |
| `/api/market-data/search` | POST | Contract search |
| `/api/market-data/search/advanced` | POST | Contract search with derivatives filters |
| `/api/market-data/history` | GET | Historical bars (DB first, IB fallback) |
| `/api/market-data/realtime` | GET | Latest bid / ask / last quote |
| `/api/market-data/indicators` | GET | Computed indicators |
| `/api/market-data/upload` | POST | Persist downloaded bars to Postgres |
| `/api/market-data/database/stats` | GET | Per-symbol storage statistics |
| `/api/market-data/database/clean` | POST | Run retention cleanup |
| `/api/settings` | GET | Allow-listed, non-credential environment variables (see [Authentication & CORS](#authentication--cors)) |
| `/api/backtesting/strategies` | GET | Available backtest strategies (cached 1h) |
| `/api/backtesting/run` | POST | Run a backtest — by `strategy` key, saved `definition_id` or inline `rule_set` |
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
`broker=` parameter (`ib` \| `mt5`, default `ib`) selecting the venue.

Socket.IO is mounted on the backend at the default path and its handshake
is authenticated (see [Authentication & CORS](#authentication--cors)).
Clients call `subscribe-market-data` / `unsubscribe-market-data` for a
given symbol; the backend's streaming bridge refcounts the subscription,
joins the socket to the `market-data:<SYMBOL>` room and fans every Redis
tick out to that room. The full pipeline is described under
[Real-time streaming pipeline](#real-time-streaming-pipeline).

All endpoints return JSON. Errors carry an `error`, `message` and
`timestamp` payload. Common HTTP statuses are `400` for validation, `503`
when the IB service is unreachable, `504` on IB timeouts.

### Authentication & CORS

- **Bearer-token auth** (`backend/src/middleware/auth.ts`): every backend
  route except `/api/health` and `/api/database/health` requires
  `Authorization: Bearer <API_TOKEN>` (or `X-API-Token`). The frontend's
  `apiFetch` helper attaches the header automatically; comparisons run
  through `crypto.timingSafeEqual`.
- **Authenticated Socket.IO handshake**: the token is read from
  `auth.token`, the `Authorization` header or a `?token=` query parameter.
- **Strict CORS**: origins are validated against `CORS_ORIGINS` instead of a
  blanket wildcard.
- **Whitelisted `/api/settings`**: only allow-listed, non-credential
  environment variables are returned, with deny patterns that strip
  anything matching `*_SECRET`, `*_PASSWORD`, `*_TOKEN`, `*_KEY`, etc.
- **Dev escape hatch**: leaving `API_TOKEN` empty (or `CORS_ORIGINS=*`)
  prints a loud startup warning and accepts unauthenticated / any-origin
  requests — convenient locally, never for production.

### Redis caching

The bundled Redis container is wired into the backend
(`backend/src/services/cache.ts`) as a read-through cache:

- `/api/market-data/realtime` — `CACHE_TTL_REALTIME` seconds (default `2`).
- `/api/market-data/indicators/available` — long-lived, refreshed through
  the cache wrapper.

A Redis outage degrades to a cache miss — every endpoint keeps working.
Cache health surfaces in `/api/health` under `services.cache`. Set
`REDIS_ENABLED=false` to bypass caching entirely.

### Interactive Brokers integration

- Built on the official Interactive Brokers TWS API (`ibapi`).
- A **single synchronous IB client** keeps the integration simple and
  reliable — this was an explicit simplification (see `README.md`).
- Auto-reconnect logic in `broker_service/main.py` re-establishes the socket if
  IB Gateway drops the connection.
- Configurable IB host, port, client id and timeout via `.env`.
- UTC timezone enforcement throughout the IB service so timestamps round-
  trip cleanly to lightweight-charts.

### Deployment & operations

- Docker Compose stack: `frontend`, `backend`, `broker_service`, `redis`.
- One unified management script: `./tradingapp.sh`
  (`setup`, `deploy`, `redeploy`, `config`, `env`, `start`, `stop`,
  `restart`, `status`, `logs`, `test`, `diagnose`, `fix`, `ib-help`,
  `clean`).
- Optional bundled TimescaleDB via the `--with-db` flag (layers
  `docker-compose.db.yml` and applies `timescaledb-schema.sql` on first
  run). Without it, the backend points at an external Postgres.
- See [`DEPLOYMENT.md`](DEPLOYMENT.md) for the full reference.

### Testing, linting & CI

- **Backend:** ESLint + Prettier + Jest/Supertest
  (`npm run lint` / `format:check` / `type-check` / `test`).
- **Frontend:** ESLint + Prettier + Vitest (`apiFetch` test suite).
- **IB service:** Ruff + Black + pytest (indicator math + streaming tests
  under `broker_service/tests/`).
- **CI:** `.github/workflows/ci.yml` runs lint, format-check, type-check,
  tests and build for all three services on every push / PR to `master`
  (and `main`).

---

## Planned / Roadmap

The items below are described in the existing documentation set or
implied by the codebase but are **not yet implemented**. They are the
forward-looking work tracked in [`GAP_ANALYSIS.md`](GAP_ANALYSIS.md).

> **Recently shipped (no longer roadmap).** Bearer-token auth, strict CORS,
> the whitelisted `/api/settings`, Redis caching, the `--with-db`
> TimescaleDB override, the real-time streaming pipeline, the scheduled
> backfill worker, `data_quality_metrics` population, real
> `clean_old_data()` counts and the `/backtest` UI all landed in Phases 2–5
> and now live under [Currently Available](#currently-available).
>
> **Also recently shipped (home-page UX polish).** A live `HealthBadge`,
> a global `error.tsx` boundary, `ResizeObserver`-driven chart refits,
> `localStorage`-backed last-symbol/timeframe persistence, and an
> RFC 4180-correct CSV export from the DataFrame viewer.
>
> **Also recently shipped (backtest persistence + observability).**
> A `backtest_runs` table with a Previous Runs UI; backend `pino` +
> `prom-client` + `/metrics`; IB-service `structlog` +
> `prometheus_fastapi_instrumentator` + `/metrics`; and end-to-end
> `X-Request-Id` propagation from `apiFetch` → backend axios →
> broker_service.
>
> **Also recently shipped (Tier 2 polish).** Loading skeletons on
> `/historical`, `/msft` and `/backtest`; the service-layer
> `console.log` sweep now routes every backend log through pino with
> structured payloads; a pre-built Grafana dashboard
> ([`ops/grafana/tradingapp-dashboard.json`](ops/grafana/tradingapp-dashboard.json))
> + Prometheus scrape config in `DEPLOYMENT.md`; and an *Export Parquet*
> button in `DataframeViewer` backed by `POST /api/export/parquet`.
>
> **Also recently shipped (Tier 3 refactors).** `broker_service/main.py`
> split into [`models.py`](broker_service/models.py), [`ib_client.py`](broker_service/ib_client.py),
> [`ib_helpers.py`](broker_service/ib_helpers.py) and
> [`bars_processing.py`](broker_service/bars_processing.py) (2,700 → 1,840
> LoC); opt-in IB connection pool
> ([`broker_service/ib_pool.py`](broker_service/ib_pool.py), parameterised by
> `IB_CLIENT_POOL_SIZE`); shared `<Chart>` primitive +
> [`useHistoricalData`](frontend/app/lib/useHistoricalData.ts) hook
> (HistoricalChart now delegates to them); test breadth expanded across
> all three services.
>
> **Also recently shipped (Tier 4 item 9 — order management).**
> Full place / cancel / modify path gated by `LIVE_TRADING_ENABLED`,
> with [`OrderTicket`](frontend/app/components/OrderTicket.tsx) /
> [`OrderBlotter`](frontend/app/components/OrderBlotter.tsx)
> components, a new [`/trade`](frontend/app/trade/page.tsx) page,
> backend validation + `order_audit` persistence and IB-service routes
> mirroring the gate.
>
> **Also recently shipped (Systematic Trading & Multi-Broker roadmap —
> all phases).** Rule-driven strategies (backtest == live), a live signal
> runner, gated paper auto-execution with a full risk layer, the
> `/systematic` monitoring UI, the broker abstraction, MetaTrader (MT5) data
> **and** execution via the Windows sidecar, and Alpaca/OANDA as two
> sidecar-free cloud brokers. Now live under
> [Systematic trading](#systematic-trading-rule-driven-auto-execution) and
> [Multi-broker: IB + MetaTrader + Alpaca + OANDA](#multi-broker-interactive-brokers-metatrader-mt5-alpaca-oanda).
> The full design lives in
> [`SYSTEMATIC_TRADING_ROADMAP.md`](SYSTEMATIC_TRADING_ROADMAP.md).
>
> **Also recently shipped (watchlist + in-app price alerts).** A flat,
> broker-scoped watchlist (`watchlist_items` table, `/api/watchlist`
> CRUD, the `/watchlist` page) with per-row live quotes polled from the
> existing `/api/market-data/realtime` endpoint, plus in-app-only price
> alerts (`price_alerts` table, `/api/alerts` CRUD, a triggered-alerts
> banner and an optional browser Notification) evaluated client-side
> against that same polled quote — see [Watchlist](#watchlist).
> Email/SMS/webhook delivery remain open.

### Systematic trading — open follow-ons

The authoring loop (build a rule-set → backtest it → deploy it live on any
instrument or venue) ships today. What remains, in priority order — see
[`SYSTEMATIC_TRADING_ROADMAP.md`](SYSTEMATIC_TRADING_ROADMAP.md) §9:

- **Intrabar fills.** The backtester fills at the bar close; live fills happen
  at the market. Sessions, multi-timeframe operands, position-aware rules,
  sizing and scale-outs now share one code path between the two engines, so
  this is the main remaining source of backtest↔live drift.
- **Futures / options contract multipliers on IB.** The IB instrument spec is
  the whole-share constant — right for the equity path the app trades, but a
  futures contract's multiplier would need `reqContractDetails`.
- **The MT5 sidecar's own auth**, and its `GET /orders` / `/deals` / `/symbol`
  endpoints — all implemented on the Windows host, outside this repo.

### Authentication, authorisation & secrets (advanced)

- Optional MFA, RBAC and audit logging on top of the existing
  bearer-token auth.

### Observability — open follow-ons

The first two observability passes have shipped (`pino` / `structlog` /
`/metrics` / `X-Request-Id` / Grafana dashboard / service-layer log
sweep), and the Prometheus alerting rules now ship in
[`ops/prometheus/alerts.yml`](ops/prometheus/alerts.yml) (target-down,
5xx error-rate, p95 latency and event-loop-lag alerts that reuse the
dashboard's metrics). What is still open:

- Route handlers in `backend/src/routes/marketData/*` still use
  `console.*` for one-line per-call logging — covered by the
  observability middleware's structured "request completed" entry, but
  worth converting on a touch-as-you-go basis.

### Frontend UX

- Loading skeletons on the chart pages.
- Parquet export from the DataFrame viewer (CSV and JSON ship today).
- Alert delivery beyond the browser tab (email/SMS/webhook) — in-app
  price alerts with browser notifications have shipped, see
  [Watchlist](#watchlist).
- Sector / scanner browsing.

### Test coverage expansion

The lint / format / type-check / test scaffolding and a CI workflow gated
on `master` have **shipped** (see
[Testing, linting & CI](#testing-linting--ci)). What remains is breadth:

- Frontend component tests (React Testing Library) beyond the current
  `apiFetch` suite.
- Backend route/integration coverage beyond the initial validation tests.
- ✅ IB-service tests around the historical-data assembly path — a
  `FakeIBApp` stand-in for `EClient`/`EWrapper`
  ([`broker_service/tests/test_market_data_history_route.py`](broker_service/tests/test_market_data_history_route.py))
  exercises `GET /market-data/history` end-to-end (contract-qualification,
  the period vs. date-range branches, the 404/503 failure paths, and the
  hand-off into `bars_processing`) without a real IB Gateway, network
  call or background thread.

### Refactors

- Split the ~2,700-line `broker_service/main.py` into `routes/`, `ib_client/`,
  `cache/` and `models/`. (The equivalent backend split has shipped —
  `backend/src/routes/marketData.ts` is now the 6-file
  `routes/marketData/` package.)
- Collapse the four overlapping chart components
  (`HistoricalChart`, `TradingChart`, `EnhancedTradingChart`,
  `MSFTRealtimeChart`) into one configurable `<Chart>` component.
- Connection-pool the IB client across a `clientId` range to support
  parallel requests.

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
6. Future chart loads will read from the database (faster, no IB rate
   limits) until you redeploy with `use_database=false`.

### Workflow: run a backtest

From the UI:

1. Open `/backtest` (linked from the home page).
2. Pick a strategy from the dropdown (`ma_crossover`, `rsi_mean_reversion`).
3. Set the symbol, timeframe, period, starting capital and commission, then
   click **Run backtest**.
4. Review the metrics summary, equity-curve chart and trade-list table.

Or hit the API directly:

```bash
curl -s http://<server-ip>:8000/backtesting/strategies | jq

curl -s -X POST 'http://<server-ip>:8000/backtesting/run' \
  --data-urlencode 'symbol=MSFT' \
  --data-urlencode 'strategy=ma_crossover' \
  --data-urlencode 'timeframe=1day'
```

---

If you spot a feature here that should be in *Available* but isn't, or
vice-versa, please open an issue. Keeping this split honest is ongoing
hygiene — the current gap list and roadmap live in
[`GAP_ANALYSIS.md`](GAP_ANALYSIS.md).
