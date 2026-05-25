# TradingApp - Gap Analysis, Enhancements & Next Steps

_Last reviewed: 2026-05-24 against commit `c258a9d` on `master`._

This document captures the result of a structured review of the TradingApp
codebase and its documentation set (`README.md`, `DEPLOYMENT.md`,
`FEATURES.md`, `TROUBLESHOOTING.md`, `DOWNLOAD_FEATURE.md`,
`DEVELOPMENT_ITERATION_GUIDANCE.md`, the database README and the
`tradingapp.sh` management script). It is a **living planning document** —
items below are observed gaps between what the documentation claims, what
the code implements, and what a quant trading platform sourcing data from IB
Gateway should provide.

> **What changed since the previous review.** Phases 1–4 of the roadmap have
> landed. Documentation drift, the missing test/lint/CI scaffolding, the
> ambiguous database story, the polling-not-streaming "real-time" path and
> the open security posture have all been addressed. This review re-baselines
> the document around the work that **remains** (Phases 5–6 plus a few code
> mismatches).

---

## 1. Executive Summary

The application is a Next.js + Express + FastAPI stack that connects to an
Interactive Brokers Gateway (`ibapi`) and surfaces market data via TradingView
`lightweight-charts`. Core capabilities (contract search, historical bars,
real-time tick streaming, indicator calculation, manual download-to-Postgres,
read-only account endpoints, an API-only backtesting engine) are implemented
and now sit behind bearer-token auth with a Redis read-through cache.

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
   request-id propagation; the home-page IB status is still static text.
2. **Single-feature UI gaps.** Backtesting and order management have no
   frontend; the four chart components remain unconsolidated (§3.5).
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

### 3.3 IB connection model

- The service intentionally uses a single synchronous IB client. At scale
  this caps concurrent requests at 1; a slow historical request can starve
  interactive lookups and the streaming worker.
- Every container/replica shares `IB_CLIENT_ID=1`, which IB rejects for a
  second concurrent connection.

**Action:** introduce a small connection pool parameterised by a `clientId`
range (`1..N`) so historical / contract / account / streaming flows can run
in parallel; move retry/backoff into a dedicated `ib_session.py`.

### 3.4 Monolithic modules (partially resolved)

| File | LoC (approx) | Concern | Status |
|---|---:|---|---|
| `backend/src/routes/marketData.ts` | ~870 | All market-data endpoints, validation, DB write-through | ✅ split into `routes/marketData/{shared,search,history,realtime,indicators,database}.ts`; the old file is now a ~25-line aggregator |
| `ib_service/main.py` | ~2,700 | HTTP routes, IB client, threading, caching, indicators wiring, account handling | ⬜ pending |
| `frontend/app/components/MSFTRealtimeChart.tsx` | ~900 | Chart + data fetch + state + UI controls | ⬜ pending (see §3.5) |
| `frontend/app/components/MarketDataFilter.tsx` | ~820 | Filter UI + chart trigger + state | ⬜ pending |

**Remaining action:** carve `main.py` into `routes/`, `ib_client/`, `cache/`,
`streaming/` and `models/` packages (entangled with §3.3 — the IB connection
global becomes the pool); split `MSFTRealtimeChart` into a data hook, a chart
presenter and a control bar (see §3.5).

> **Why `main.py` / the charts are not in this PR.** They are large refactors
> whose correctness depends on runtime behavior (live IB Gateway; the browser
> chart) that the thin pytest/vitest suites do not cover. They are best landed
> as their own runtime-validated PRs rather than bundled with the
> type-checked backend changes above. The `marketData.ts` split was included
> here because TypeScript's type-checker gives a strong correctness signal.

### 3.5 Overlapping chart components

`HistoricalChart.tsx`, `TradingChart.tsx`, `EnhancedTradingChart.tsx` and
`MSFTRealtimeChart.tsx` each create their own `lightweight-charts` instance
with subtly different feature sets, guaranteeing divergence.

**Action:** collapse into one configurable `<Chart>` that accepts a data
source (`useHistorical` / `useRealtimeStream`), timeframe list, indicator
list and a `mode: 'live' | 'static'` prop. Make `/msft` a thin wrapper with
`symbol="MSFT"` prefilled.

---

## 4. Observability (Phase 6)

- No structured logging — everything is `console.log` / `print`.
- No `/metrics` endpoint, no Prometheus scraping target.
- No `x-request-id` propagation across `frontend → backend → ib_service`
  (the header is allow-listed in CORS but nothing generates or threads it).
- The home page still renders a **static** "Connected to IB Gateway" label
  rather than reflecting live `/api/health` state.

**Action:**
- Backend: `pino` + `pino-http`, expose `/metrics` via `prom-client`.
- IB service: `structlog` + `prometheus-fastapi-instrumentator`.
- Generate and propagate `x-request-id` end-to-end.
- Add a `<HealthBadge />` polling `/api/health` (including the new
  `services.streaming` / `services.cache` blocks).

---

## 5. Backtesting (Phase 5)

`ib_service/backtesting.py` and `AVAILABLE_STRATEGIES` are wired into FastAPI
(`GET /backtesting/strategies`, `POST /backtesting/run`). There is **no
frontend UI** and no backend proxy route, so the feature is reachable only by
hitting the IB service directly.

**Action:** add a `backend/src/routes/backtesting.ts` proxy with validation;
build a `/backtest` page (strategy picker, parameter form, equity-curve
chart, trade-list table); persist runs into Postgres for comparison.

---

## 6. Order Management (Phase 5)

The IB service exposes read-only account/positions/orders endpoints and the
backend proxies them. There is **no order placement** anywhere — no
`placeOrder` flow in `ib_service`, no `POST /api/orders`, no order ticket in
the UI.

**Action:** add a guarded `placeOrder` path in `ib_service`, a validated
`POST /api/orders` (create/cancel/modify), and a frontend order ticket +
blotter. Keep it behind an explicit config flag given the live-trading risk.

---

## 7. Frontend UX Gaps (Phases 5–6)

- Static IB status text on the home page (see §4).
- No global `error.tsx` boundary; an exception in a chart unmounts the page.
- No loading skeletons; charts pop in once data arrives.
- Charts do not re-fit cleanly on viewport change (no `ResizeObserver`).
- Last-used symbol/timeframe is not persisted to `localStorage`.
- No CSV / Parquet export from the DataframeViewer.
- No watchlists, alerts, scanners or sector browsing.

**Action:** add the `error.tsx` boundary and `ResizeObserver` wiring;
persist last symbol/timeframe; add export from the DataframeViewer; treat
watchlists/alerts/scanners as larger follow-on features.

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
- ⚠️ `/msft` still duplicates generic chart code instead of reusing a shared
  `<Chart>` (see §3.5).

---

## 10. Suggested Roadmap (Prioritised)

Phases 1–4 are complete (see §2). Remaining work, ordered by dependency:

### Phase 5 — Feature expansion
1. Add a `backend/src/routes/backtesting.ts` proxy and a `/backtest` UI;
   persist runs.
2. ✅ Add a scheduled backfill worker (in the **backend**) driven by
   `data_collection_config`. (See §3.1.)
3. ✅ Wire `updateDataQualityMetrics()` from the upload/store path; return real
   counts from `clean_old_data()`. (See §3.1.)
4. ✅ Resolve the `technical_indicators` persistence mismatch (§3.2 —
   persistence dropped).
5. Persist last-used symbol/timeframe; add CSV/Parquet export from the
   DataframeViewer.
6. (Stretch) Order management behind an explicit live-trading flag.

### Phase 6 — Operational polish
7. Structured logging, `x-request-id` propagation, `/metrics` endpoints.
8. Live `<HealthBadge />` reflecting IB / DB / cache / streaming state.
9. Connection-pool the IB client across a `clientId` range (§3.3).
10. Split the monolithic modules (§3.4) — ✅ `marketData.ts` done; `main.py`
    and the largest frontend components still pending — and consolidate the
    four chart components into one `<Chart>` (§3.5).
11. Add an `error.tsx` boundary and `ResizeObserver`s on chart containers.
12. Expand test breadth (frontend component tests, backend integration,
    IB-service historical-assembly tests).

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
- [ ] Backtesting is exposed in the UI.
- [ ] A health badge on the home page reflects live IB Gateway, database,
      cache and streaming state.
- [x] `data_quality_metrics` is populated and `clean_old_data()` returns real
      counts.
- [x] The `technical_indicators` schema/code mismatch is resolved (§3.2 —
      persistence dropped; indicators stay compute-on-demand).

---

_This document is intended for ongoing planning; please update it (or
supersede sections) as work lands._
