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
   - [Account read endpoints](#account-read-endpoints)
   - [Order management](#order-management)
   - [Systematic trading (auto-execution)](#systematic-trading-rule-driven-auto-execution)
   - [Multi-broker: IB + MetaTrader (MT5)](#multi-broker-interactive-brokers--metatrader-mt5)
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
IB Gateway ──reqMktData──▶ ib_service ──redis.publish──▶ Redis
                            (StreamingManager)            │ pSUBSCRIBE
                                                          ▼
                       frontend  ◀── Socket.IO room ◀── backend StreamingBridge
                  (useRealtimeStream)
```

- **Publisher:** `ib_service/streaming.py` runs an in-process
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

`ib_service/indicators.py` ships a pandas/numpy implementation of:

- **Trend:** SMA, EMA, WMA, MACD
- **Momentum:** RSI, Stochastic, Williams %R
- **Volatility:** Bollinger Bands, ATR, Keltner Channels
- **Volume:** OBV, Volume SMA, VWAP

These are exposed via `GET /api/market-data/indicators` (backend) and
`GET /indicators/available` (IB service). The frontend
`IndicatorSelector` and `TechnicalIndicatorsFilter` components let users
toggle them on the chart.

### Backtesting

`ib_service/backtesting.py` ships an event-driven backtest engine and two
sample strategies:

- `ma_crossover` (simple moving-average crossover)
- `rsi_mean_reversion`

Reachable two ways:

- **API:** `GET /backtesting/strategies` and `POST /backtesting/run` on the
  IB service, or the validating backend proxy at `GET /api/backtesting/strategies`
  and `POST /api/backtesting/run` (`backend/src/routes/backtesting.ts`).
- **UI:** the `/backtest` page (`frontend/app/backtest/page.tsx`) with a
  strategy picker, parameter form, metrics summary, equity-curve chart
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

### Account read endpoints

The backend proxies the following read-only IB account endpoints to the
frontend:

- `GET /api/account/summary` — account balances and key metrics.
- `GET /api/account/positions` — current positions.
- `GET /api/account/orders` — open orders.
- `GET /api/account/all` — all of the above in one call.
- `GET /api/account/connection` — IB connection state.

> The `/api/account/orders` endpoint is read-only. The write path lives
> under `/api/orders/*` and requires `LIVE_TRADING_ENABLED=true` for any
> live order — see the *Order management* section below.

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
  ([`ib_service/rule_strategy.py`](ib_service/rule_strategy.py)). Evaluated
  statelessly via `POST /strategies/evaluate`.
- **Definitions & runs:** create/list rule-sets and start/stop runs through
  `/api/strategies/*`; each run pins a definition to a broker + `account_mode`.
- **Live signal runner:** an opt-in backend timer (`SYSTEMATIC_ENABLED=true`)
  evaluates every running strategy on its closed-bar cadence, persists each
  decision to `strategy_signals` (one per bar) and fans it out on the
  `strategy:<runId>` Socket.IO room.
- **Gated auto-execution:** with `SYSTEMATIC_EXECUTION_ENABLED=true` an
  actionable signal is turned into an order through the **same** audited
  `/api/orders` path — inheriting the live gate, `order_audit`, the fat-finger
  caps and the position-limit guard. Engine-level guards on top: a per-run kill
  switch, per-run `max_orders_per_day` + a global `SYSTEMATIC_MAX_ORDERS_PER_DAY`
  backstop, broker-unit-aware sizing (`fixed` / `notional` / `pct_equity`), and
  signal→order dedupe. Both gates default **off**; live (vs paper) auto-trading
  additionally needs `LIVE_TRADING_ENABLED`.
- **Monitoring UI (`/systematic`):** a rule builder, a definitions list (start a
  run), a run dashboard (status, last-eval, per-run **Stop**) and a per-run
  detail with a candle chart carrying buy/sell **signal markers** (acted orders
  bolder), a summary strip (net position, signals, orders placed) and a
  live-updating signal feed.

### Multi-broker: Interactive Brokers + MetaTrader (MT5)

The IB Gateway is no longer hard-wired — a venue-agnostic adapter seam lets a
second broker plug in without touching the routes.

- **Adapter registry** ([`ib_service/adapters.py`](ib_service/adapters.py)):
  `MarketDataAdapter` / `BrokerAdapter` protocols keyed by provider. A request's
  `source=` (market data) / `broker=` (orders) resolves to the concrete adapter,
  defaulting to `ib`; an unknown provider → 400, a recognised-but-unconfigured
  one → 501. `source=ib` / `broker=ib` behaviour is byte-for-byte unchanged.
- **Broker-scoped instruments:** contract catalogues, positions and the
  net-exposure cap are keyed per broker — no cross-broker symbol reconciliation,
  and a strategy run targets exactly one venue.
- **MetaTrader (MT5) via sidecar:** `MetaTrader5` is Windows-only, so MT5 runs as
  a small HTTP service on a Windows host; the Linux
  [`MT5Adapter`](ib_service/mt5_adapter.py) is a thin client pointed at
  `MT5_BRIDGE_URL`, implementing both **data** (search / bars / quotes / ticks,
  normalised to the app's shapes) and **execution** (place / cancel / modify /
  positions / account, with the same validation + live gate as IB). When
  `MT5_BRIDGE_URL` is set, `source=mt5` / `broker=mt5` become available;
  otherwise MT5 is a recognised-but-unavailable provider.
- **Provider health:** the IB service exposes `/providers` (and folds provider
  status into `/health`) so operators can see which venues are registered.

### REST & WebSocket API

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/health` | GET | Backend, DB, IB service health summary |
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
| `/api/backtesting/run` | POST | Run a backtest via the IB service |
| `/api/backtesting/runs` | GET | List persisted runs (filterable, paginated) |
| `/api/backtesting/runs/:id` | GET | Full record for a persisted run |
| `/api/export/parquet` | POST | Convert `{ columns, rows }` to a Parquet download |
| `/api/orders` | POST | Place an order (validation + audit; `broker=` venue; gated by `LIVE_TRADING_ENABLED` for live) |
| `/api/orders/:id` | DELETE | Cancel a working order |
| `/api/orders/:id` | PUT | Modify a working order |
| `/api/orders/audit` | GET | Persisted order attempts (blotter feed; `broker` filter) |
| `/api/orders/config` | GET | Live-trading gate + supported enums + brokers |
| `/api/strategies/definitions` | GET·POST | List / create rule-set definitions |
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
- Auto-reconnect logic in `ib_service/main.py` re-establishes the socket if
  IB Gateway drops the connection.
- Configurable IB host, port, client id and timeout via `.env`.
- UTC timezone enforcement throughout the IB service so timestamps round-
  trip cleanly to lightweight-charts.

### Deployment & operations

- Docker Compose stack: `frontend`, `backend`, `ib_service`, `redis`.
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
  under `ib_service/tests/`).
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
> ib_service.
>
> **Also recently shipped (Tier 2 polish).** Loading skeletons on
> `/historical`, `/msft` and `/backtest`; the service-layer
> `console.log` sweep now routes every backend log through pino with
> structured payloads; a pre-built Grafana dashboard
> ([`ops/grafana/tradingapp-dashboard.json`](ops/grafana/tradingapp-dashboard.json))
> + Prometheus scrape config in `DEPLOYMENT.md`; and an *Export Parquet*
> button in `DataframeViewer` backed by `POST /api/export/parquet`.
>
> **Also recently shipped (Tier 3 refactors).** `ib_service/main.py`
> split into [`models.py`](ib_service/models.py), [`ib_client.py`](ib_service/ib_client.py),
> [`ib_helpers.py`](ib_service/ib_helpers.py) and
> [`bars_processing.py`](ib_service/bars_processing.py) (2,700 → 1,840
> LoC); opt-in IB connection pool
> ([`ib_service/ib_pool.py`](ib_service/ib_pool.py), parameterised by
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
> `/systematic` monitoring UI, the IB/MetaTrader broker abstraction, and the
> MetaTrader (MT5) data **and** execution venue via the Windows sidecar. Now
> live under [Systematic trading](#systematic-trading-rule-driven-auto-execution)
> and [Multi-broker: IB + MetaTrader (MT5)](#multi-broker-interactive-brokers--metatrader-mt5).
> The full design lives in
> [`SYSTEMATIC_TRADING_ROADMAP.md`](SYSTEMATIC_TRADING_ROADMAP.md).

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
- Watchlists and alerts.
- Sector / scanner browsing.

### Test coverage expansion

The lint / format / type-check / test scaffolding and a CI workflow gated
on `master` have **shipped** (see
[Testing, linting & CI](#testing-linting--ci)). What remains is breadth:

- Frontend component tests (React Testing Library) beyond the current
  `apiFetch` suite.
- Backend route/integration coverage beyond the initial validation tests.
- IB-service tests around the historical-data assembly path (a fake
  `EClient` / `EWrapper`), on top of the existing indicator and streaming
  tests.

### Refactors

- Split the ~2,700-line `ib_service/main.py` into `routes/`, `ib_client/`,
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
