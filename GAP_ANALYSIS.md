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
- **"Real-time" is real.** `broker_service` publishes `reqMktData` ticks to
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
   serialises every request (§3.3); `broker_service/main.py` is still monolithic
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
- `broker_service/streaming.py` `StreamingManager` publishes `reqMktData` ticks
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
  `broker_service` as originally proposed, because only the backend has database
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
the IB service (`broker_service/indicators.py`). No backend code references the
`technical_indicators` table anymore, so a fresh canonical database no longer
errors. See
[`backend/src/database/README.md`](backend/src/database/README.md#indicators-are-not-persisted-by-design).

### 3.3 IB connection model ✅ resolved (opt-in)

- ✅ A connection pool is now available in
  [`broker_service/ib_pool.py`](broker_service/ib_pool.py), parameterised by
  `IB_CLIENT_POOL_SIZE` (defaults to 1, which preserves the existing
  single-client behaviour byte-for-byte). When set to `N>=2` the pool
  reserves the clientId range `[IB_CLIENT_ID, IB_CLIENT_ID+N-1]` so
  concurrent flows (historical / contract / streaming / account) can run
  in parallel and a second replica can claim a disjoint range without
  racing the primary. Acquire / release / context-manager `borrow()` and
  `stats()` are covered by hermetic pytest using a fake IBApp.
- The existing `get_ib_connection()` in
  [`broker_service/ib_client.py`](broker_service/ib_client.py) is intentionally
  unchanged — opting in only requires the env var, and the next time a
  route handler is touched it can adopt `pool.borrow()` without
  breaking any defaults.

### 3.4 Monolithic modules (largely resolved)

| File | LoC (approx) | Concern | Status |
|---|---:|---|---|
| `backend/src/routes/marketData.ts` | ~870 | All market-data endpoints, validation, DB write-through | ✅ split into `routes/marketData/{shared,search,history,realtime,indicators,database}.ts`; the old file is now a ~25-line aggregator |
| `broker_service/main.py` | ~2,700 → ~1,840 → ~80 | HTTP routes, IB client, threading, caching, indicators wiring, account handling | ✅ split into [`models.py`](broker_service/models.py), [`ib_client.py`](broker_service/ib_client.py), [`ib_helpers.py`](broker_service/ib_helpers.py), [`bars_processing.py`](broker_service/bars_processing.py); the route handlers are now carved into a [`routes/`](broker_service/routes) subpackage (health / market_data / backtesting / streaming / contracts / account / symbols), so `main.py` is a ~80-line app shell and is itself now under Ruff/Black. |
| `frontend/app/components/MSFTRealtimeChart.tsx` | ~975 → ~640 | Chart + data fetch + state + UI controls | ✅ chart rendering delegated to `<Chart>` (§3.5); the bespoke lightweight-charts instance, series management and per-tick timestamp loop are gone. Controls / streaming / DataframeViewer stay. |
| `frontend/app/components/MarketDataFilter.tsx` | ~801 → ~180 | Filter UI + chart trigger + state | ✅ split: the data flow moved to a [`useContractSearch`](frontend/app/lib/useContractSearch.ts) hook and the JSX into presentational pieces under [`components/marketData/`](frontend/app/components/marketData) (ConnectionStatusBar / QuickSearch / SearchFilters / SearchResultsList / MarketDataPanel / SearchTips + shared types/constants). `MarketDataFilter` is now a ~180-line container. |

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
  backend → broker_service hop so the trace flows end-to-end.
- **IB service:** `structlog` + `prometheus_fastapi_instrumentator` wired
  in [`broker_service/observability.py`](broker_service/observability.py); a
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
  a structured "request completed" line per request. `broker_service` has no
  `print()` calls; its stdlib `logger` is transparently reconfigured by
  `broker_service/observability.py` to emit through `structlog`.
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

`broker_service/backtesting.py` and `AVAILABLE_STRATEGIES` are wired into FastAPI
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
`broker_service/tests/test_backtesting.py`.

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

- **IB service** ([`broker_service/orders.py`](broker_service/orders.py)) —
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

**MFA / RBAC on the order endpoints:** ✅ two opt-in layers now guard the
mutating order routes (`POST /api/orders`, `DELETE`/`PUT /api/orders/:id`)
on top of the shared `API_TOKEN`, via
[`orderAuth`](backend/src/middleware/orderAuth.ts):

- **RBAC (trader role)** — when `TRADING_TOKENS` (a comma-separated
  allowlist) is set, a mutating request must present a matching
  `X-Trading-Token` header. A trading token is a credential distinct from
  `API_TOKEN`, so a read-only viewer can't place orders. Missing/wrong →
  HTTP 403.
- **MFA (TOTP)** — when `ORDER_MFA_SECRET` (a base32 secret) is set, the
  request must present a valid 6-digit `X-MFA-Code`, verified against a
  dependency-free RFC 6238 implementation
  ([`totp`](backend/src/services/totp.ts), ±1 step of skew tolerance).
  Missing/invalid → HTTP 401.

Both default off (unset = current behaviour) and apply to paper and live
orders alike. `GET /api/orders/config` advertises which are active
(`trading_auth_required` / `mfa_required`), and the
[`OrderTicket`](frontend/app/components/OrderTicket.tsx) surfaces a trading-token
/ authenticator-code field only when the backend reports them required,
sending them as request headers (never baked into the bundle).

**Not in scope (stretch):** an order-history chart overlay; a
position-limit guard sourced from live IB positions rather than the audit
log.

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
- ✅ **Watchlist + in-app price alerts.** A flat, broker-scoped watchlist
  (`watchlist_items` table, `WatchlistRepository`, `/api/watchlist` CRUD)
  with a `/watchlist` page (`Watchlist` component + `useWatchlist` hook)
  and a home-page quick-access tile. Each row polls the existing
  (Redis-cached) `/api/market-data/realtime` endpoint for its live quote
  — adding a symbol introduces no new IB traffic. On top of that, in-app
  price alerts (`price_alerts` table, `PriceAlertRepository`, mounted at
  `/api/alerts`): set an above/below target price on a row, the row
  itself compares its already-polled quote against active alerts and
  calls `POST /api/alerts/:id/trigger` the moment one crosses (no
  server-side price watcher), a page-level banner (backed by
  `usePriceAlerts({status: 'triggered'})`) surfaces triggered alerts
  across a refresh, and an optional Web `Notification` adds an OS-level
  toast. Manual reordering, multiple named lists and any delivery channel
  beyond the browser tab (email/SMS/webhook) are not in scope.
- No scanners or sector browsing.

**Remaining action:** treat scanners / sector browsing as a larger
follow-on feature.

> **Update — the largest follow-on has shipped.** The systematic-trading and
> multi-broker (IB + MetaTrader) work that this section once hand-waved as
> "larger follow-on features" is now delivered in full — see
> [`SYSTEMATIC_TRADING_ROADMAP.md`](SYSTEMATIC_TRADING_ROADMAP.md) for the design
> and [`FEATURES.md`](FEATURES.md#systematic-trading-rule-driven-auto-execution)
> for what's live. The watchlist and in-app price alerts have since
> shipped too (see §7 above); scanners / sector browsing remain the open
> item.
>
> **Update — the systematic authoring loop is now closed end-to-end (§12).**
> A review of "can this app create and deploy systematic systems on any
> instrument, in backtest and live?" found three breaks that shipped silently;
> all three are fixed. See §12 below.

---

## 8. Operational / Deployment Gaps

- ✅ **`tradingapp.sh` env generation footgun — resolved.** `config`/`env`
  now **merge** into the existing `.env` via `env_set` (force-updates
  `SERVER_IP`, `IB_HOST` and the URLs derived from `SERVER_IP` — the
  values the command is explicitly asked to change) and `env_set_default`
  (fills in everything else — ports, Postgres/Redis credentials — only if
  missing). Hand-added keys the script has never heard of
  (`POSTGRES_HOST`, `API_TOKEN`, `BACKFILL_ENABLED`, `LIVE_TRADING_ENABLED`,
  …) and hand-edited defaults now survive a re-run untouched. A
  `--non-interactive` global flag skips the IB Gateway IP prompt (falls
  back to `DEFAULT_IB_HOST` unless `IB_HOST` is already exported) for
  scripted/CI installs.
- ✅ **`verify_timestamp_config.sh` wired in.** `./tradingapp.sh
  verify-timestamps` runs it against the current stack; `diagnose` points
  at the new subcommand, and `TROUBLESHOOTING.md` documents it under a new
  *Wrong years / timezone in historical bars* entry.
- The installer is Linux/Ubuntu-only (`apt`, `usermod`, `systemctl`); the
  README's macOS mention does not hold for `setup`.

**Remaining action:** none tracked here beyond the macOS installer gap
above — low priority given the deployment target is a Linux host.

- The multi-broker topology (`DEPLOYMENT.md` §
  [Multi-Broker Host Topology](DEPLOYMENT.md#multi-broker-host-topology-ib--mt5))
  runs IB Gateway and the MT5 sidecar as two separate GUI-session hosts, each
  a single point of failure for its venue, and the MT5 sidecar's HTTP
  contract (`broker_service/mt5_adapter.py`) carries no authentication.
  Alpaca and OANDA (`broker_service/alpaca_adapter.py` /
  `oanda_adapter.py`) don't share this risk — both are direct HTTPS calls
  to the broker's own authenticated API, no self-hosted sidecar involved.

**Action (future consideration — not yet scheduled):**
1. ✅ **Client side done, sidecar side still open.** `MT5Adapter`
   (`broker_service/mt5_adapter.py`) now sends an `X-MT5-Bridge-Secret`
   header on every request when `MT5_BRIDGE_SECRET` is set, and
   `broker_service` logs a startup warning if `MT5_BRIDGE_URL` is configured
   without it. The other half of the contract — the sidecar rejecting
   requests missing the header or presenting the wrong value — has to be
   implemented on the Windows host itself, outside this repo. Until that
   lands there, anything that can reach `MT5_BRIDGE_URL` can still
   place/cancel/modify orders. mTLS remains a valid alternative to the
   shared-secret header if the sidecar framework makes it easier.
2. Firewall both the IB Gateway host and the MT5 host so only the app host's
   IP can reach them (private network/VPN, not public internet); document
   this alongside the existing `ufw` guidance in `DEPLOYMENT.md`.
3. Add a liveness check + alert for both broker sessions (IB Gateway login
   state, MT5 terminal login state) — today a silent logout on either host
   is indistinguishable from "no trading opportunity" until someone notices.
4. Revisit whether IB Gateway and the MT5 terminal need separate physical/
   virtual hosts at all, or whether OS-level isolation (separate users/
   services on one Windows host) meets the same isolation goal with half
   the hosts to patch and monitor — decide this deliberately rather than by
   default.

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
7. ✅ Structured logging (`pino` backend, `structlog` broker_service),
   `x-request-id` propagation browser → backend → broker_service, `/metrics`
   endpoints on both services. (Replacing residual `console.log` / `print`
   calls in heavier modules is a follow-on as those files are touched.)
8. ✅ Live `<HealthBadge />` reflecting IB / DB / cache / streaming /
   backfill state on the home page.
9. ✅ Opt-in IB connection pool across a `clientId` range
   ([`broker_service/ib_pool.py`](broker_service/ib_pool.py); §3.3).
10. Split the monolithic modules (§3.4) — ✅ `marketData.ts` done;
    ✅ `broker_service/main.py` split into models / ib_client / ib_helpers /
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
    pytest coverage for `bars_processing`. ✅ IB-service historical-data
    assembly path now covered too — a `FakeIBApp` stand-in for
    `EClient`/`EWrapper` drives `GET /market-data/history` through
    `routes/market_data.py` end-to-end
    ([`test_market_data_history_route.py`](broker_service/tests/test_market_data_history_route.py)),
    leaving frontend RTL coverage beyond hooks and broader backend route
    coverage as the two remaining test-breadth items (see
    [`FEATURES.md`](FEATURES.md#test-coverage-expansion)).

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

## 12. Systematic Strategies — Capability Review (2026-08-06)

_Reviewed on branch `claude/systematic-strategies-review-ov6zx1` against the
question: **can a user create a systematic strategy on any given instrument,
validate it in a backtest, and deploy it live?**_

The engine, risk layer, adapter seam and monitoring UI were all present and
sound. What was missing sat in the seams between them — and each gap failed
*silently*, which is what made them worth prioritising: nothing errored, the
results were simply wrong or the feature was unreachable.

### 12.1 The authoring loop was broken at its first hop ✅ fixed

`POST /backtesting/run` accepted only a key from `AVAILABLE_STRATEGIES`. A
rule-set authored in the `/systematic` rule builder — the app's own primary
way of creating a strategy — had **no route into the backtester at all**. The
roadmap's stated rule is "if it can't be backtested, it can't be traded", yet
a user-created definition could be deployed live having never been tested.

Fixed by teaching `POST /backtesting/run` to compile an inline `rule_set` body,
and the backend proxy to accept `definition_id` (loading the saved row) or an
inline `rule_set` — exactly one selector, validated. The `/backtest` picker now
groups saved rule-sets above the built-ins, and the definitions list links
straight to `/backtest?definition=<id>`.

### 12.2 Everything was hardwired to US stocks on IB ✅ fixed

Two independent hardcodes defeated the "any given instrument" goal:

- `/backtesting/run` built its contract as a literal `STK`/`SMART`/`USD` and
  never qualified it, so futures, FX, CFDs and non-USD instruments were
  un-backtestable.
- `StrategyRunner.fetchHistory` requested history with no `source=`, so **every
  live run read IB data** — including runs pinned to MT5, Alpaca or OANDA,
  which would evaluate against a different venue's prices than they traded on.

Fixed by adding `sec_type`/`exchange`/`currency` to `strategy_definitions`
(with `ADD COLUMN IF NOT EXISTS` for existing deployments), threading them
through the repository, routes and rule builder, qualifying the contract in the
backtest route via `reqContractDetails`, dispatching non-IB `source=` through
the adapter registry, and passing the whole run (instrument + `source=broker`)
into `fetchHistory`.

### 12.3 Position-aware rules were inert in backtest ✅ fixed

The most consequential one. `BacktestEngine.run_backtest` called
`strategy.generate_signals(...)` **once, up front**, before any trade existed,
then walked the precomputed signal columns. Every `position.*` operand
therefore read a flat position on every bar. Concretely: a strategy with a -2%
stop (`position.unrealized_pct <= -2.0`) or a pyramiding cap
(`position.size < 300`) — both of which appear in the roadmap's own showcase
example — backtested as though those rules did not exist, then behaved
differently the moment it went live. No error, no warning.

Fixed by giving `RuleStrategy` a stateful pair (`prepare_stateful()` +
`evaluate_bar()`) that the engine drives **per bar** with its running position
and the open trade's entry price. `generate_signals` is reimplemented on top of
`evaluate_bar` so the two paths cannot drift, and a strategy without the
stateful hooks keeps the original one-shot pass. Two regression tests assert a
stop actually triggers and that `avg_price` reaches the operands; both fail
against the previous engine.

Live, the same rules needed a real entry price — the runner had `avg_price = 0`
hardcoded with a TODO. It now reads the venue's reported average cost from
`/account/positions` (cached ~30s, fail-soft to 0).

### 12.4 Remaining — prioritised

1. ~~**`/account/positions` is IB-only.**~~ ✅ **Closed** — see §12.5.
2. **`risk.max_daily_loss` is a silent no-op.** Accepted by the schema and the
   builder, enforced nowhere — the same failure shape as §12.3. Needs realised
   P&L, hence (3).
3. **Positions are inferred from submitted orders, not fills.** Both
   `ORDER_MAX_POSITION` and the runner's position size read `order_audit` rows
   that reached the broker. Partial fills, post-acknowledgement rejections and
   manual trades all desynchronise them. An executions feed
   (`execDetails`/`commissionReport` and equivalents) is the foundation for
   authoritative positions, realised P&L and therefore (2).
4. **The backtester ignores `sizing` and `scale_out`.** `BacktestEngine` is
   all-in / all-out, so backtest returns won't match a live run's even when the
   signals agree.

### 12.5 Positions are venue-aware ✅ fixed (follow-up)

`GET /account/positions` called `get_ib_connection()` unconditionally, so a
live run on MT5, Alpaca or OANDA read **IB's** positions — which in practice
meant no match for its symbol, `avg_price = 0`, and every unrealised-P&L rule
silently inert on exactly the venues where the app had just gained execution
support.

The route now takes `broker=` and dispatches through `get_broker_adapter()`;
`broker=ib` keeps the existing synchronous path byte-for-byte, an unknown
broker is a 400 and a recognised-but-unconfigured one a 501, matching the
convention everywhere else.

The substance was in normalisation. Each adapter's `positions()` existed but
had **zero callers**, so it had never been shaped — every venue returned its
raw payload, none of which matches the app's `Position` model. They now
normalise, and that is where the per-venue quirks live:

- **Alpaca** signs `qty` directly (negative for a short), so the sign carries
  through; flat rows are dropped.
- **OANDA** splits an instrument into independent `long` / `short` legs (short
  units already negative). The legs are netted into one signed size, and the
  average price is taken from whichever leg is actually open — averaging the
  two prices would be meaningless. Instruments come back underscore-separated
  and map to the app's dotted form, the inverse of the request path.
- **MT5** is read defensively, since the sidecar is out-of-repo: either MT5's
  native `volume` (unsigned, direction in `type`) / `price_open` / `profit`, or
  the app's own vocabulary if the sidecar already speaks it.

The runner's avg-cost cache is keyed per broker and passes `broker=` through,
so `position.unrealized_pct` stops now fire on every venue.

**Deliberately not changed:** a run's `position.size` still comes from the
order-audit net, not the venue. The venue's size *is* fill-derived and would
address §12.4(3), but it reports whole-**account** exposure — a second run on
the same symbol, or a manual trade, would fold into this run's position and
change what its sizing and pyramiding rules do. That is a live-behaviour change
that needs an attribution decision (per-run sub-accounts, an attribution ledger,
or accepting account-level semantics explicitly), so it is flagged rather than
slipped in. `/account/summary` and `/account/orders` also remain IB-only.

---

_This document is intended for ongoing planning; please update it (or
supersede sections) as work lands._
