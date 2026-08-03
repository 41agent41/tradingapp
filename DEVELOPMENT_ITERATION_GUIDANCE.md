# Development Iteration Guidance

## Codebase Review Summary

**Date**: 2026-05-30
**Branch**: `feat/order-management`
**Base commit**: `0d58652` (master, post Tier 3 merge). This branch
ships **Tier 4 item 9** — env-gated order placement end to end: IB
service `POST/DELETE/PUT /orders`, backend `/api/orders/*` with
validation and an `order_audit` table, OrderTicket + OrderBlotter
components, a new `/trade` page, and a compact ticket on `/account`.

> This is a point-in-time engineering snapshot. For the full prioritised
> gap list and roadmap see [`GAP_ANALYSIS.md`](GAP_ANALYSIS.md); for the
> user-facing capability list see [`FEATURES.md`](FEATURES.md). This file
> deliberately overlaps with those but stays focused on *build health* and
> *the next iteration's task order*.

---

## 1. Build Status

| Component | Status | Details |
|-----------|--------|---------|
| **Backend (TypeScript)** | PASS | `tsc --noEmit` clean; ESLint + Prettier + Jest/Supertest wired and green in CI; `routes/marketData/` split into a 6-file package |
| **Frontend (Next.js 14)** | PASS | `next build` compiles all routes (`/`, `/account`, `/backtest`, `/download`, `/historical`, `/msft`); ESLint + Prettier + Vitest in CI |
| **IB Service (Python/FastAPI)** | PASS | Ruff + Black + pytest (`tests/test_indicators.py`, `tests/test_streaming.py`, `tests/test_backtesting.py`) in CI |
| **CI Pipeline (GitHub Actions)** | ACTIVE | `.github/workflows/ci.yml` runs lint → format-check → type-check → test → build per service on push/PR to `master`/`main` |
| **Docker Compose** | DEFINED | 4 base services (frontend, backend, ib_service, redis); optional TimescaleDB via `docker-compose.db.yml` + `--with-db` |

---

## 2. What Has Been Completed

### Core architecture
- Three-service Docker Compose stack (Next.js 14 frontend, Express/TypeScript
  backend, FastAPI/Python IB service) on a static `172.20.0.x` network, plus
  Redis.
- Unified management script (`tradingapp.sh`) with a `--with-db` override for
  a bundled TimescaleDB.

### TradingView charts
- Lightweight Charts v4 candlestick + volume rendering.
- Timeframes: `tick`, `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `8h`, `1d`.
- Periods: `1D`, `5D`, `1M`, `3M`, `6M`, `1Y`, plus custom date ranges.
- Chart components: `HistoricalChart`, `TradingChart`, `EnhancedTradingChart`,
  `MSFTRealtimeChart`, `EquityCurveChart` (the four OHLCV charts are still
  unconsolidated — see §3).

### Interactive Brokers integration
- TWS API client (`EClient`/`EWrapper`) in `ib_service/main.py`.
- Contract search (basic + advanced) and 3-phase symbol discovery.
- Historical data retrieval with UTC timestamp handling.
- Technical indicators (`indicators.py`) — compute-on-demand, not persisted.
- Backtesting engine (`backtesting.py`) — exposed via the IB service, the
  backend proxy (`routes/backtesting.ts`) and the `/backtest` page.
- **Real-time streaming** (`streaming.py`): `reqMktData` → Redis publish.

### Data & backend services
- PostgreSQL/TimescaleDB via `pg` with a 20-connection pool
  (`services/database.ts`); CRUD in `services/marketDataService.ts`.
- Single canonical schema (`timescaledb-schema.sql`); legacy SQL archived.
- Redis read-through cache (`services/cache.ts`).
- Real-time bridge (`services/streamingBridge.ts`): Redis subscribe →
  Socket.IO room fan-out with per-symbol refcounting.
- **Scheduled backfill worker** (`services/backfillScheduler.ts`): opt-in
  via `BACKFILL_ENABLED`, driven by `data_collection_config`, reports under
  `services.backfill` in `/api/health`.
- **`data_quality_metrics` populated** on every store path (manual upload,
  `/history` cache-on-fetch and the backfill worker).
- **Real retention counts** from `POST /api/market-data/database/clean`
  (deletes per `retention_days`; returns the actual rows removed).
- Bearer-token auth (`middleware/auth.ts`) on REST + Socket.IO; strict CORS;
  allow-listed `routes/settings.ts`.

### Frontend pages
- **Home** (`/`): dashboard, market-data search, trading-account toggle.
- **Historical** (`/historical`): exchange-driven filters, indicator
  overlays, dataframe viewer.
- **Download** (`/download`): IB download → PostgreSQL upload pipeline.
- **MSFT Real-time** (`/msft`): streaming chart via `useRealtimeStream`.
- **Backtest** (`/backtest`): strategy picker, parameter form, metrics
  summary, equity-curve chart, trade-list table.
- **Account** (`/account`): summary, positions, orders, connection status.

### Quality & hygiene
- `.gitignore` present; `.env` removed from tracking; `.env.example` is the
  single template.
- Lint/format/type-check/test scripts for all three services + CI gate.

---

## 3. Current Issues & Gaps

The Phase 1–5 issues from the previous snapshot — committed `.env`, malformed
env values, CI-on-`main`, unused Redis, no real-time push, no tests,
aspirational `FEATURES.md`, stale deploy scripts, no linting, the
`data_quality_metrics` / `clean_old_data()` / `technical_indicators`
mismatches, the missing backfill scheduler and the API-only backtesting — are
**resolved**. What remains:

### P1 — Functional gaps
| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 1 | ~~No order placement~~ | — | ✅ Env-gated place / cancel / modify shipped on this branch (`ib_service/orders.py`, `backend/src/routes/orders.ts`, `OrderTicket` + `OrderBlotter` + `/trade`). |
| 2 | ~~Backtesting runs are not persisted~~ | — | ✅ `backtest_runs` + Previous Runs panel shipped on this branch. |
| 3 | ~~Static IB status on the home page~~ | — | ✅ Replaced by `HealthBadge` (previous branch). |

### P2 — Architecture / quality
| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 4 | ~~`ib_service/main.py` is ~2,700 lines~~ | — | ✅ Split into models / ib_client / ib_helpers / bars_processing, then the route handlers carved into a `routes/` subpackage (health / market_data / backtesting / streaming / contracts / account / symbols). `main.py` is now a ~80-line app shell, under Ruff/Black. |
| 5 | ~~Four overlapping chart components~~ | — | ✅ Shared `<Chart>` primitive + `useHistoricalData` hook, and all four wrappers (`HistoricalChart` / `TradingChart` / `EnhancedTradingChart` / `MSFTRealtimeChart`) now render through it. `<Chart>` gained per-indicator `priceScaleId` so RSI/MACD keep their own axis. |
| 6 | ~~No observability~~ | — | ✅ First pass shipped on this branch (pino backend, structlog ib_service, /metrics on both, end-to-end X-Request-Id). Residual `console.log` / `print` cleanup is a touch-as-you-go follow-on. |
| 7 | ~~No global `error.tsx` / `ResizeObserver`~~ | — | ✅ `error.tsx` + shared `useChartResize` shipped (previous branch). |
| 8 | ~~Single synchronous IB client~~ | — | ✅ Opt-in pool shipped this branch (`ib_pool.IBPool` keyed by `IB_CLIENT_POOL_SIZE`, defaults to 1 = unchanged behaviour). |

---

## 4. Recommended Next Iteration

### Tier 1 — Surface remaining engines
1. ✅ Live `<HealthBadge />` on the home page, polling `/api/health`
   (covers `database`, `ib_service`, `cache`, `streaming`, `backfill`).
2. ✅ Persist backtest runs into Postgres + Previous Runs panel on
   `/backtest`.

### Tier 2 — Operational polish
3. ✅ Structured logging (`pino` backend, `structlog` ib_service),
   `/metrics` on both, end-to-end `X-Request-Id` propagation.
4. ✅ Frontend `error.tsx` boundary + `ResizeObserver`s on chart containers
   (all five charts now share `useChartResize`).
5. ✅ Persist last-used symbol/timeframe to `localStorage` (via
   `usePersistentState`); CSV export from `DataframeViewer` rewritten as an
   RFC 4180-correct encoder. ✅ Parquet export now ships too (via
   `POST /api/export/parquet` backed by `@dsnp/parquetjs`).
6. ✅ Loading skeletons on `/historical`, `/msft` and `/backtest`
   (shared `ChartSkeleton` component).
7. ✅ Grafana dashboard ([`ops/grafana/tradingapp-dashboard.json`](ops/grafana/tradingapp-dashboard.json))
   and DEPLOYMENT.md *Monitoring & Maintenance* section.
8. ✅ Structured-logger sweep across `services/` (marketDataService,
   streamingBridge, backfillScheduler, cache, database).

### Tier 3 — Refactors
6. ✅ Split `ib_service/main.py` — models / ib_client / ib_helpers /
   bars_processing landed, then the route handlers were carved into a
   dedicated `routes/` subpackage (health / market_data / backtesting /
   streaming / contracts / account / symbols). `main.py` is now a
   ~80-line app shell and is itself under Ruff/Black.
7. ✅ Shared `<Chart>` primitive + `useHistoricalData` hook landed and
   **all four** OHLCV chart wrappers now render through it
   (`HistoricalChart` / `TradingChart` / `EnhancedTradingChart` /
   `MSFTRealtimeChart`). The three streaming/contract charts keep their
   own surrounding UI + data hooks but no longer embed a bespoke
   lightweight-charts instance.
8. ✅ Opt-in IB connection pool (`IB_CLIENT_POOL_SIZE`,
   [`ib_service/ib_pool.py`](ib_service/ib_pool.py)).

### Tier 4 — Live trading (gated)
9. ✅ `placeOrder` path in `ib_service`, validated
   `POST/DELETE/PUT /api/orders`, order ticket + blotter UI — all
   gated by `LIVE_TRADING_ENABLED` on both services. Every attempt
   is persisted in `order_audit`; the live submission flow is
   protected by a confirmation modal. Fat-finger caps via
   `ORDER_MAX_QUANTITY` / `ORDER_MAX_PRICE`.

---

## 5. Suggested Development Order for Next Sprint

```
Priority  Task                                                Effort
────────  ──────────────────────────────────────────────────  ──────
  ✅      Live HealthBadge on the home page                    (done)
  ✅      error.tsx boundary + ResizeObserver on charts        (done)
  ✅      Persist last symbol/timeframe + RFC 4180 CSV export  (done)
  ✅      Persist backtest runs + Previous Runs panel          (done)
  ✅      Structured logging + /metrics + x-request-id         (done)
  ✅      Loading skeletons on chart pages                     (done)
  ✅      Grafana dashboard JSON + DEPLOYMENT.md reference     (done)
  ✅      Parquet export + service-layer logger sweep          (done)
  ✅      Split ib_service/main.py (models / ib_client /        (done)
            ib_helpers / bars_processing) — routes still in main
  ✅      Shared <Chart> + useHistoricalData (HistoricalChart   (done)
            adopts; other three charts pending browser-validation)
  ✅      Opt-in IB connection pool (IB_CLIENT_POOL_SIZE)      (done)
  ✅      Test breadth expansion across all three services     (done)
  ✅      Order management gated by LIVE_TRADING_ENABLED       (done)
  ✅      Order modify path now audited (parity with create /  (done)
            cancel) + order-route test suite repaired
  ✅      Prometheus alerting rules (ops/prometheus/alerts.yml) (done)
  ✅      Position-limit guard (ORDER_MAX_POSITION) on creates  (done)
            computed from order_audit net exposure
  ✅      Rewrite TradingChart / EnhancedTradingChart /        (done)
            MSFTRealtimeChart on top of <Chart>
  ✅      Carve ib_service routes/ subpackage out of main.py  (done)
  ✅      Split MarketDataFilter.tsx into hook + presentational  (done)
            pieces (useContractSearch + components/marketData/*)
  ✅      MFA / RBAC on /api/orders (live-trading hardening):    (done)
            opt-in TRADING_TOKENS (X-Trading-Token) + TOTP
            ORDER_MFA_SECRET (X-MFA-Code) on mutating routes
  2       Watchlists / alerts / scanners                       Large
```

---

## 6. Architecture Notes

### Current data flow
```
Browser ──REST (apiFetch + bearer token)──▶ Express backend ──▶ FastAPI IB service ──▶ IB Gateway
   ▲                                              │  ▲                    │
   │  Socket.IO (market-data:<SYMBOL> room)       │  │ read-through       │ reqMktData
   └──────────── StreamingBridge ◀── Redis ◀──────┘  └── PostgreSQL/      └── publish ticks
                                  pub/sub               TimescaleDB           to Redis
                                                              ▲
                                                              │ upsert + quality
                                                              │
                                                       BackfillScheduler
                                                       (opt-in, driven by
                                                        data_collection_config)
```

- REST: every route except the health checks requires a bearer token; the
  frontend `apiFetch` attaches it automatically.
- Real-time: `ib_service` publishes ticks to Redis; the backend bridge fans
  them out to Socket.IO rooms; `useRealtimeStream` consumes them.
- Caching: `/api/market-data/realtime` and `/indicators/available` are served
  through the Redis read-through cache, degrading to a miss on outage.
- Storage: historical bars read DB-first (`use_database=true`) with a live IB
  fallback. The backfill scheduler keeps the DB topped up; every store path
  records per-day quality counts.
- Indicators: computed on demand in `ib_service/indicators.py` and proxied
  through `/api/market-data/indicators` — **not persisted**.
- Backtesting: the IB service runs the engine; the backend proxies and
  validates; the `/backtest` page consumes the result. Runs are not yet
  persisted across requests.

### Remaining technical decisions
1. **IB concurrency**: keep the single synchronous client, or pool across a
   `clientId` range for parallel historical / streaming / account flows.
2. **Order management**: whether to implement live order placement at all,
   and if so, behind what safeguard.
3. **Backtest persistence shape**: a single `backtest_runs` table keyed on
   `(strategy, symbol, timeframe, params_hash)`, or a `runs` + `trades`
   pair for trade-level drill-down.
