# TradingApp - Gap Analysis, Enhancements & Next Steps

_Last reviewed: 2026-05-30 against branch `feat/order-management`
(env-gated live order placement: IB service place / cancel / modify
routes, backend validation + audit proxy, OrderTicket / OrderBlotter
components, new `/trade` page)._

This document captures the result of a structured review of the TradingApp
codebase and its documentation set (`README.md`, `DEPLOYMENT.md`,
`FEATURES.md`, `TROUBLESHOOTING.md`, `DOWNLOAD_FEATURE.md`,
`DEVELOPMENT_ITERATION_GUIDANCE.md`, the database README and the
`tradingapp.sh` management script). It is a **living planning document** —
items below are observed gaps between what the documentation claims, what
the code implements, and what a quant trading platform sourcing data from IB
Gateway should provide.

> **What changed since the previous review.** Phases 1–4 of the roadmap and
> the bulk of Phase 5 have now landed: the data-lifecycle gaps (§3.1), the
> indicator-persistence mismatch (§3.2), the `marketData.ts` split (§3.4) and
> the backtesting UI (§5) are all in `master`. This review re-baselines the
> document around the work that **remains** (Phase 6 observability + refactors,
> plus a handful of single-feature gaps).

---

## 1. Executive Summary

The application is a Next.js + Express + FastAPI stack that connects to an
Interactive Brokers Gateway (`ibapi`) and surfaces market data via TradingView
`lightweight-charts`. Core capabilities (contract search, historical bars,
real-time tick streaming, indicator calculation, manual download-to-Postgres,
scheduled backfill + retention, read-only account endpoints, and a backtesting
engine fronted by a `/backtest` page) are implemented and now sit behind
bearer-token auth with a Redis read-through cache.

The platform is in materially better shape than at the previous review:

- **Documentation and reality now agree.** `DEPLOYMENT.md` and
  `TROUBLESHOOTING.md` reference only `tradingapp.sh`; `FEATURES.md` is split
  into *Currently Available* vs *Planned*; `.env` is no longer tracked.
- **There is a real quality bar.** ESLint/Prettier/Jest (backend),
  ESLint/Prettier/Vitest (frontend) and Ruff/Black/pytest (IB service) all
  run in CI on `master`.
- **"Real-time" is real.** `ib_service` publishes `reqMktData` ticks to
  Redis; the backend bridge fans them out over Socket.IO rooms; the frontend
  consumes them via `useRealtimeStream`.
- **Security baseline exists.** Bearer-token auth on every route and the
  Socket.IO handshake, CORS bound to `CORS_ORIGINS`, and a whitelisted
  `/api/settings`.
- **One canonical schema.** `timescaledb-schema.sql` is authoritative; the
  legacy SQL/docs are archived; `--with-db` brings up TimescaleDB locally.

The remaining risks are now smaller and mostly about **breadth and polish**:

1. **No observability.** No structured logging, metrics endpoint or
   request-id propagation. (The home-page IB status is now a live
   `HealthBadge` driven by `/api/health` — that gap is closed.)
2. **Single-feature UI gaps.** Order management now ships
   (`/trade` page + ticket on `/account`, env-gated via
   `LIVE_TRADING_ENABLED` — §6); backtesting already shipped
   (`/backtest`). All four OHLCV chart components now render through the
   shared `<Chart>` primitive (§3.5).
3. **IB concurrency is capped at one.** The single synchronous IB client
   serialises every request (§3.3); `ib_service/main.py` is still monolithic
   (§3.4).

---

## 2. Completed Since the Previous Review (Phases 1–4)

These items were open gaps in earlier revisions of this document and are now
**done**. They are recorded here so the history of the platform is legible.

### Phase 1 — Documentation & repo hygiene ✅
- Stale script references (`deploy-tradingapp.sh`, `fix-ib-config.sh`,
  `fix-ib-connection.sh`, `diagnose-connection.sh`) removed; everything
  routes through `tradingapp.sh`.
- `FEATURES.md` rewritten into *Currently Available* vs *Planned / Roadmap*.
- `.env` removed from version control; `.gitignore` added; `.env.example` is
  the single documented reference (the duplicate `env.template` is gone).
- Single canonical SQL schema (`timescaledb-schema.sql`); `schema.sql`,
  `init.sql`, `migrate-to-timescaledb.sql` and the legacy TimescaleDB docs
  moved to `backend/src/database/archive/`.

### Phase 2 — Safe to run (security + DB) ✅
- `docker-compose.db.yml` override + `--with-db` flag bring up TimescaleDB
  locally and apply the schema on first run.
- `routes/settings.ts` rewritten to an allow-list with credential deny
  patterns; it reads `process.env`, not `/app/.env`.
- CORS bound to `CORS_ORIGINS`; bearer-token auth middleware on every route
  (except the health checks) and on the Socket.IO handshake, using
  `crypto.timingSafeEqual`.
- Redis wired into the backend as a read-through cache (`services/cache.ts`)
  with graceful degradation and a `services.cache` health block.

### Phase 3 — Quality bar (tests, lint, CI) ✅
- ESLint + Prettier configs and `lint` / `format:check` / `type-check`
  scripts for backend and frontend; Ruff + Black via `pyproject.toml` for the
  IB service.
- Initial test suites: Jest/Supertest (backend), Vitest (`apiFetch`,
  frontend), pytest (`indicators`, `streaming`) for the IB service.
- `.github/workflows/ci.yml` rewritten to trigger on `master`/`main` and run
  lint → format-check → type-check → test → build per service.

### Phase 4 — Real-time pipeline ✅
- `ib_service/streaming.py` `StreamingManager` publishes `reqMktData` ticks
  to `marketdata:tick:<SYMBOL>` on Redis.
- `backend/src/services/streamingBridge.ts` subscribes and emits into
  `market-data:<SYMBOL>` Socket.IO rooms with per-symbol refcounting and
  disconnect cleanup.
- `frontend/app/lib/useRealtimeStream.ts` consumes the stream; the MSFT page
  no longer polls. A one-shot REST call seeds the price before the first
  tick and acts as a fallback when `STREAMING_ENABLED=false`.

---

## 3. Remaining Architectural & Code Gaps

### 3.1 Data lifecycle & storage (Phase 5) ✅ resolved

This section's three gaps have been closed:

- **Backfill scheduler.** `backend/src/services/backfillScheduler.ts` runs an
  opt-in (`BACKFILL_ENABLED`) timer that reads every enabled `auto_collect`
  row from `data_collection_config`, fetches the recent `BACKFILL_PERIOD`
  window from the IB service and upserts it via `marketDataService`,
  respecting each row's `collection_interval_minutes`. It writes a
  `data_collection_sessions` row per attempt and reports under
  `services.backfill` in `/api/health`. It lives in the **backend**, not
  `ib_service` as originally proposed, because only the backend has database
  access — the IB service can neither read `data_collection_config` nor write
  `candlestick_data`.
- **`data_quality_metrics` is populated.** `MarketDataService.recordDataQuality()`
  computes per-UTC-day total / missing / duplicate / invalid counts (pure and
  unit-tested in `tests/dataQuality.test.ts`) and is called from the upload
  path, the `/history` IB-fallback store path and the backfill scheduler. The
  quality score is clamped to `[0,1]`.
- **`clean_old_data()` returns real counts.** `cleanOldData()` no longer calls
  the non-existent `clean_old_data()` SQL function (it lived only in the
  archived schemas). It now deletes per `data_collection_config.retention_days`
  and returns the actual rows removed, with a per-config breakdown.

> While fixing the store path it emerged that the `/history` route's
> cache-on-fetch was silently dead — it read `response.data.data[].time`
> whereas the IB service returns `bars[].timestamp`. That mapping is fixed, so
> the read path now persists fetched bars (and records their quality) as
> intended.

### 3.2 Indicator persistence mismatch ✅ resolved

Resolved by **dropping the persistence path** (indicators stay
compute-on-demand). `storeTechnicalIndicators()` and the `technical_indicators`
`LEFT JOIN` in `getHistoricalData()` are gone; `getHistoricalData()` now
returns raw OHLCV only, and `/api/market-data/indicators` proxies straight to
the IB service (`ib_service/indicators.py`). No backend code references the
`technical_indicators` table anymore, so a fresh canonical database no longer
errors. See
[`backend/src/database/README.md`](backend/src/database/README.md#indicators-are-not-persisted-by-design).

### 3.3 IB connection model ✅ resolved (opt-in)

- ✅ A connection pool is now available in
  [`ib_service/ib_pool.py`](ib_service/ib_pool.py), parameterised by
  `IB_CLIENT_POOL_SIZE` (defaults to 1, which preserves the existing
  single-client behaviour byte-for-byte). When set to `N>=2` the pool
  reserves the clientId range `[IB_CLIENT_ID, IB_CLIENT_ID+N-1]` so
  concurrent flows (historical / contract / streaming / account) can run
  in parallel and a second replica can claim a disjoint range without
  racing the primary. Acquire / release / context-manager `borrow()` and
  `stats()` are covered by hermetic pytest using a fake IBApp.
- The existing `get_ib_connection()` in
  [`ib_service/ib_client.py`](ib_service/ib_client.py) is intentionally
  unchanged — opting in only requires the env var, and the next time a
  route handler is touched it can adopt `pool.borrow()` without
  breaking any defaults.

### 3.4 Monolithic modules (largely resolved)

| File | LoC (approx) | Concern | Status |
|---|---:|---|---|
| `backend/src/routes/marketData.ts` | ~870 | All market-data endpoints, validation, DB write-through | ✅ split into `routes/marketData/{shared,search,history,realtime,indicators,database}.ts`; the old file is now a ~25-line aggregator |
| `ib_service/main.py` | ~2,700 → ~1,840 | HTTP routes, IB client, threading, caching, indicators wiring, account handling | ✅ split into [`models.py`](ib_service/models.py), [`ib_client.py`](ib_service/ib_client.py), [`ib_helpers.py`](ib_service/ib_helpers.py), [`bars_processing.py`](ib_service/bars_processing.py); routes remain in `main.py` for this commit. Carving the routes into a `routes/` subpackage is the remaining follow-on. |
| `frontend/app/components/MSFTRealtimeChart.tsx` | ~975 → ~640 | Chart + data fetch + state + UI controls | ✅ chart rendering delegated to `<Chart>` (§3.5); the bespoke lightweight-charts instance, series management and per-tick timestamp loop are gone. Controls / streaming / DataframeViewer stay. |
| `frontend/app/components/MarketDataFilter.tsx` | ~820 | Filter UI + chart trigger + state | ⬜ pending (its embedded `EnhancedTradingChart` now uses `<Chart>`, but the filter shell itself is still monolithic) |

### 3.5 Overlapping chart components (primitive shipped)

- ✅ A canonical `<Chart>`
  ([`frontend/app/components/Chart.tsx`](frontend/app/components/Chart.tsx))
  now owns the candlestick + volume + indicator-overlay + ResizeObserver
  story in one place. The strict-time-order invariant is enforced by an
  internal `sortAndDedupe` helper that is unit-tested.
- ✅ A companion data hook
  ([`frontend/app/lib/useHistoricalData.ts`](frontend/app/lib/useHistoricalData.ts))
  wraps `/api/market-data/history` and projects raw bars into the
  `ChartBar` shape, exposing `{ bars, loading, error, source, refresh }`.
- ✅ `HistoricalChart` is now a thin wrapper around `<Chart>` —
  >100 LoC of lightweight-charts boilerplate dropped.
- ✅ `TradingChart`, `EnhancedTradingChart` and `MSFTRealtimeChart` now
  render through the shared `<Chart>` primitive too. Each keeps its own
  surrounding UI (symbol input, contract header, streaming price badges,
  data switch, indicator selector, custom date range, DataframeViewer)
  but no longer embeds a bespoke lightweight-charts instance, series
  management or timestamp-validation loop — that all lives in `<Chart>`
  now. `MSFTRealtimeChart` and `EnhancedTradingChart` reuse the streaming
  (`useRealtimeStream`) / historical (`useHistoricalData`) hooks rather
  than hand-rolled Socket.IO / fetch wiring. Net effect: ~800 lines of
  duplicated chart boilerplate removed across the four wrappers.
- `<Chart>` gained an optional `priceScaleId` per indicator series so
  oscillators (RSI / MACD) render on their own axis instead of flattening
  the candles — this is what let the MSFT indicator overlays move onto the
  shared primitive without a visual regression.

---

## 4. Observability (Phase 6) ✅ shipped

The first observability pass has landed:

- **Backend:** `pino` root logger
  ([`backend/src/services/logger.ts`](backend/src/services/logger.ts))
  with auth-header redaction and an `AsyncLocalStorage` request context;
  `prom-client` default metrics + `http_request_duration_seconds`
  histogram + `backtest_runs_persisted_total` counter
  ([`backend/src/services/metrics.ts`](backend/src/services/metrics.ts))
  scraped at `GET /metrics` (added to the auth allow-list).
- **`observabilityMiddleware`**
  ([`backend/src/middleware/observability.ts`](backend/src/middleware/observability.ts))
  accepts or mints `X-Request-Id`, echoes it on the response, pushes it
  into ALS, times the request, and emits one structured log line on
  finish.
- An axios request interceptor auto-attaches `X-Request-Id` on every
  backend → ib_service hop so the trace flows end-to-end.
- **IB service:** `structlog` + `prometheus_fastapi_instrumentator` wired
  in [`ib_service/observability.py`](ib_service/observability.py); a
  `RequestIdMiddleware` binds the id to `contextvars` so every log record
  in the request carries it, and `/metrics` is exposed on the FastAPI
  app.
- **Frontend:** `apiFetch` mints `X-Request-Id` (uuid4) when the caller
  doesn't supply one, so the trace starts in the browser.
- **Home-page status:** ✅ live `<HealthBadge />` (shipped in the
  previous branch) — see §7.

**Remaining (stretch):**
- ✅ The heavy `services/` files (`marketDataService.ts`,
  `streamingBridge.ts`, `backfillScheduler.ts`, `cache.ts`,
  `database.ts`) now route every log through pino with structured
  payloads (this branch). Route handlers' `console.*` calls are
  intentionally left alone — the observability middleware already emits
  a structured "request completed" line per request. `ib_service` has no
  `print()` calls; its stdlib `logger` is transparently reconfigured by
  `ib_service/observability.py` to emit through `structlog`.
- ✅ Grafana dashboard
  ([`ops/grafana/tradingapp-dashboard.json`](ops/grafana/tradingapp-dashboard.json))
  + README + DEPLOYMENT.md *Monitoring & Maintenance* section now
  document the full Prometheus / Grafana / X-Request-Id story.
- ✅ Prometheus alerting rules
  ([`ops/prometheus/alerts.yml`](ops/prometheus/alerts.yml)) pair with
  the dashboard: target-down (critical), 5xx error-rate, p95 latency and
  Node event-loop-lag (warning), and an IB-service no-traffic info alert.
  Wired into the DEPLOYMENT.md scrape config via `rule_files`.

---

## 5. Backtesting (Phase 5) ✅ exposed in the UI

`ib_service/backtesting.py` and `AVAILABLE_STRATEGIES` are wired into FastAPI
(`GET /backtesting/strategies`, `POST /backtesting/run`). These are now
fronted by:

- **A backend proxy** (`backend/src/routes/backtesting.ts`, mounted at
  `/api/backtesting`) that validates inputs (symbol/strategy required,
  timeframe whitelist, positive capital, commission in `[0,1]`), caches the
  strategy catalogue for an hour, and forwards run requests to the IB service
  as query params on a bodyless POST.
- **A `/backtest` page** (`frontend/app/backtest/page.tsx`) with a strategy
  picker, parameter form, a metrics summary, an equity-curve chart
  (`components/EquityCurveChart.tsx`) and a trade-list table (reusing
  `DataframeViewer`), linked from the home page.

While wiring this up, `BacktestResults.to_dict()` was made JSON-safe — it now
emits the `equity_curve` the chart needs and coerces non-finite metrics (e.g.
`profit_factor` with zero losing trades) to `null`, which Starlette's
`allow_nan=False` encoder would otherwise reject. Covered by
`ib_service/tests/test_backtesting.py`.

> ⚠️ Implemented but **not yet runtime-validated** against a live IB Gateway —
> the authoring environment has no Node/Python, so type-check, lint and pytest
> must still pass in CI before this is considered done.

**Persistence:** ✅ a `backtest_runs` table is now part of the canonical
TimescaleDB schema and every successful run is written to it
(`backend/src/services/backtestRunRepository.ts`). The `/backtest` page
gained a "Previous Runs" panel that lists prior runs and rehydrates the
metrics summary, equity-curve chart and trade-list table from
`GET /api/backtesting/runs/:id` without re-running the engine.

---

## 6. Order Management (Tier 4 item 9) ✅ shipped

Full place / cancel / modify path now lives behind the
`LIVE_TRADING_ENABLED` env-var gate (defaulting to `false` so paper
orders work but any `account_mode=live` request is rejected with 403):

- **IB service** ([`ib_service/orders.py`](ib_service/orders.py)) —
  `POST /orders`, `DELETE /orders/{id}`, `PUT /orders/{id}`,
  `GET /orders/config`. Supports MKT / LMT / STP / STP_LMT and
  DAY / GTC / IOC / FOK. The STP_LMT form is translated to IB's wire
  format (`"STP LMT"`) at build time so the rest of the system uses
  the underscored variant. `eTradeOnly` / `firmQuoteOnly` are forced
  off to dodge IB error 10268, and `cancelOrder()` survives both the
  9.81-style and newer signatures.
- **Backend** ([`backend/src/routes/orders.ts`](backend/src/routes/orders.ts))
  — same surface mounted at `/api/orders/*`. `validateOrder()`
  ([`orderTypes.ts`](backend/src/services/orderTypes.ts)) runs first
  (symbol uppercased, action / order_type / tif / account_mode
  whitelisted, price-field cross-checks, fat-finger caps via
  `ORDER_MAX_QUANTITY` / `ORDER_MAX_PRICE`), then the gate, then a
  write to the new `order_audit` table ([schema](backend/src/database/timescaledb-schema.sql)).
  Insert failure aborts the request — we refuse to send an unaudited
  order to IB. The audit row is updated with the IB order id /
  status / error after the IB hop.
- **Frontend** — [`OrderTicket`](frontend/app/components/OrderTicket.tsx)
  + [`OrderBlotter`](frontend/app/components/OrderBlotter.tsx) and a
  new [`/trade`](frontend/app/trade/page.tsx) page. The compact
  ticket is also mounted on `/account` under the existing Orders tab.
  Live submissions require a confirmation modal that lists every
  field. The Live option in the account-mode dropdown is greyed out
  when the config probe reports the gate as off.

**Defence in depth:** both the backend route and the IB service
handler re-check `LIVE_TRADING_ENABLED` — setting it only on one
service doesn't silently enable live orders on the other.

**Position-limit guard:** ✅ an opt-in `ORDER_MAX_POSITION` cap now
guards `POST /api/orders`. The backend computes the net signed exposure
per `(symbol, account_mode)` from the `order_audit` log
(`OrderAuditRepository.netExposure` — latest row per `ib_order_id`,
dead orders excluded, within `ORDER_POSITION_LOOKBACK_HOURS`) and rejects
a create whose projected net would exceed the cap with HTTP 422, before
any IB call or audit write. It fails closed if the net can't be computed.
It is a *soft* guard built on submitted orders, not authoritative IB
fills — runaway-order protection rather than a hard risk limit.

**Not in scope (stretch):** MFA / RBAC on the order endpoints; an
order-history chart overlay; a position-limit guard sourced from live IB
positions rather than the audit log.

---

## 7. Frontend UX Gaps (Phases 5–6)

- ✅ Static IB status text on the home page — replaced by `HealthBadge`
  (`frontend/app/components/HealthBadge.tsx`, polled against `/api/health`).
- ✅ Global `error.tsx` boundary now in place
  ([`frontend/app/error.tsx`](frontend/app/error.tsx)) — a thrown chart
  exception no longer unmounts the rest of the page.
- ✅ `ResizeObserver` wiring — all five lightweight-charts surfaces share
  [`useChartResize`](frontend/app/lib/useChartResize.ts), which observes
  the container itself (not just the viewport) and keeps a `window.resize`
  fallback.
- ✅ Last-used symbol/timeframe is persisted via
  [`usePersistentState`](frontend/app/lib/usePersistentState.ts) under
  the `tradingapp.lastSymbol` / `tradingapp.lastTimeframe` keys; the
  home filter and `/historical` share them.
- ✅ CSV export from `DataframeViewer` is now RFC 4180-correct
  (CRLF terminators, double-quote escaping, comma/CR/LF quoting); JSON
  export was already present.
- ✅ Parquet export ships via a backend `POST /api/export/parquet` route
  built on `@dsnp/parquetjs`; the viewer gains an *Export Parquet*
  button next to CSV / JSON.
- ✅ Loading skeletons (`frontend/app/components/ChartSkeleton.tsx`)
  show on `/historical`, `/msft` and `/backtest` while data is in
  flight; the layout no longer jumps when the chart canvas mounts.
- No watchlists, alerts, scanners or sector browsing.

**Remaining action:** treat watchlists / alerts / scanners as larger
follow-on features.

---

## 8. Operational / Deployment Gaps

- `tradingapp.sh` rewrites `.env` with `cat > .env` on `config`/`env`,
  overwriting any hand-added keys (`POSTGRES_HOST`, `API_TOKEN`, …). This is
  documented as a caveat in `DEPLOYMENT.md` but is still a footgun.
- The installer is Linux/Ubuntu-only (`apt`, `usermod`, `systemctl`); the
  README's macOS mention does not hold for `setup`.
- `verify_timestamp_config.sh` exists at the repo root but is not referenced
  from any doc or folded into `./tradingapp.sh diagnose`.

**Action:** make environment generation **merge** into the existing `.env`
(or write `.env.local`); add a `--non-interactive` mode for CI; reference
`verify_timestamp_config.sh` from `TROUBLESHOOTING.md` or fold it into
`diagnose`.

---

## 9. Functional Status Against the `.cursorrules` Brief

The repo-level `.cursorrules` asks for TradingView lightweight charts showing
**real-time MSFT** across the 5m/15m/30m/1h/4h/8h/1d timeframes with 12
months of history, sourced from IB Gateway, running remotely.

- ✅ Timeframes available (plus `1m` and `tick`).
- ✅ 12-month period selectable (`1Y`).
- ✅ Real-time is now a genuine IB → Redis → Socket.IO → chart stream.
- ✅ Runs entirely via Docker on a remote host (no local deps).
- ✅ `/msft` now renders through the shared `<Chart>` primitive (§3.5) —
  the duplicated chart code is gone.

---

## 10. Suggested Roadmap (Prioritised)

Phases 1–4 are complete (see §2). Remaining work, ordered by dependency:

### Phase 5 — Feature expansion
1. ✅ Add a `backend/src/routes/backtesting.ts` proxy and a `/backtest` UI
   (§5). ✅ Persistence shipped: `backtest_runs` table + Previous Runs
   panel.
2. ✅ Add a scheduled backfill worker (in the **backend**) driven by
   `data_collection_config`. (See §3.1.)
3. ✅ Wire `updateDataQualityMetrics()` from the upload/store path; return real
   counts from `clean_old_data()`. (See §3.1.)
4. ✅ Resolve the `technical_indicators` persistence mismatch (§3.2 —
   persistence dropped).
5. ✅ Persist last-used symbol/timeframe; CSV export from the
   DataframeViewer (Parquet still open).
6. ✅ Order management behind an explicit `LIVE_TRADING_ENABLED`
   flag (§6).

### Phase 6 — Operational polish
7. ✅ Structured logging (`pino` backend, `structlog` ib_service),
   `x-request-id` propagation browser → backend → ib_service, `/metrics`
   endpoints on both services. (Replacing residual `console.log` / `print`
   calls in heavier modules is a follow-on as those files are touched.)
8. ✅ Live `<HealthBadge />` reflecting IB / DB / cache / streaming /
   backfill state on the home page.
9. ✅ Opt-in IB connection pool across a `clientId` range
   ([`ib_service/ib_pool.py`](ib_service/ib_pool.py); §3.3).
10. Split the monolithic modules (§3.4) — ✅ `marketData.ts` done;
    ✅ `ib_service/main.py` split into models / ib_client / ib_helpers /
    bars_processing (routes still in main.py — carving them into a
    `routes/` subpackage is a follow-on); the largest frontend
    components still pending. ✅ Shared `<Chart>` primitive +
    `useHistoricalData` hook now exist (§3.5); **all four** OHLCV chart
    wrappers (HistoricalChart / TradingChart / EnhancedTradingChart /
    MSFTRealtimeChart) now render through it.
11. ✅ Global `error.tsx` boundary and `ResizeObserver`s on all chart
    containers.
12. ✅ Test breadth expanded: route-level Supertest coverage for
    `/api/backtesting/*` and `/api/export/parquet`, RTL interaction tests
    for the HealthBadge popover, hook tests for `useHistoricalData`, and
    pytest coverage for `bars_processing`.

---

## 11. Concrete "Definition of Done" Checklist

Carried forward from the original analysis; checked items have landed.

- [x] `DEPLOYMENT.md` and `TROUBLESHOOTING.md` reference only scripts that
      exist in the repo.
- [x] `FEATURES.md` accurately reflects what ships today; aspirational items
      live under a clearly-labelled *Planned* heading.
- [x] `.env` is no longer tracked; `.env.example` is the single source of
      truth for documented environment variables.
- [x] A single canonical SQL schema is shipped; legacy schemas archived.
- [x] `docker compose` from a fresh clone (with `--with-db`) produces a
      working frontend, backend, IB service and database — without manual
      schema bootstrap.
- [x] `npm run lint`, `type-check`, `ruff check`, `pytest` and `npm test`
      all run in CI and gate merges.
- [x] Backend has authentication middleware and CORS is bound to
      `CORS_ORIGINS`.
- [x] Real-time chart receives ticks via Socket.IO emitted from a
      backend-side Redis subscription, not browser polling.
- [x] Backtesting is exposed in the UI (proxy + `/backtest` page; pending
      runtime validation in CI / against a live IB Gateway).
- [x] A health badge on the home page reflects live IB Gateway, database,
      cache and streaming state (`frontend/app/components/HealthBadge.tsx`,
      polled every 10s against `/api/health`; includes the
      `services.backfill` block too).
- [x] `data_quality_metrics` is populated and `clean_old_data()` returns real
      counts.
- [x] The `technical_indicators` schema/code mismatch is resolved (§3.2 —
      persistence dropped; indicators stay compute-on-demand).

---

_This document is intended for ongoing planning; please update it (or
supersede sections) as work lands._
