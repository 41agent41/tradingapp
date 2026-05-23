# TradingApp - Gap Analysis, Enhancements & Next Steps

_Last reviewed: 2026-05-23 against commit `ca34726` on `master`._

This document captures the result of a structured review of the TradingApp
codebase and its existing documentation set (`README.md`, `DEPLOYMENT.md`,
`FEATURES.md`, `TROUBLESHOOTING.md`, `DOWNLOAD_FEATURE.md`, the database
READMEs and the `tradingapp.sh` management script). It is intended to be a
living planning document — items below are **observed gaps** between what the
documentation claims, what the code implements, and what a quant trading
platform sourcing data from IB Gateway should provide.

---

## 1. Executive Summary

The application is a Next.js + Express + FastAPI stack that connects to an
Interactive Brokers Gateway (`ibapi`) and surfaces market data via TradingView
`lightweight-charts`. Core capabilities (contract search, historical bars,
basic real-time quotes, indicator calculation, manual download-to-Postgres)
are implemented. However, there is a meaningful drift between the
documentation and the code, several aspirational features are described as
delivered, and a number of foundational concerns (tests, auth, observability,
streaming, data lifecycle) have not been addressed.

The single biggest risks today are:

1. **Documentation drift** — multiple guides reference scripts that no longer
   exist in the repo (`deploy-tradingapp.sh`, `fix-ib-config.sh`,
   `fix-ib-connection.sh`, `diagnose-connection.sh`).
2. **No tests, no linting, no real CI** — the GitHub Actions job is a stub.
3. **Database story is ambiguous** — PostgreSQL is required by the backend
   but is not provisioned by `docker-compose.yml`; three competing schemas
   exist (`schema.sql`, `init.sql`, `timescaledb-schema.sql`).
4. **"Real-time" is mostly polling** — there is no IB streaming subscription
   actually piped through Socket.IO to the chart.
5. **Security posture is unfinished** — `FEATURES.md` claims JWT/MFA/RBAC but
   no auth middleware exists in the backend and default secrets are
   committed.

---

## 2. Documentation vs. Reality Gaps

### 2.1 Stale / contradictory deployment instructions

| Doc | Claims | Reality |
|---|---|---|
| `README.md` | One unified script: `./tradingapp.sh` | ✅ Present and authoritative |
| `DEPLOYMENT.md` | `./deploy-tradingapp.sh install/deploy/...`, `./fix-ib-config.sh`, `./fix-ib-connection.sh`, `./diagnose-connection.sh` | ❌ None of these scripts exist in the repo |
| `TROUBLESHOOTING.md` | Same stale scripts as above | ❌ Same issue |
| `DEPLOYMENT.md` | Uses `your-username/tradingapp.git` placeholder | Real repo is `41agent41/tradingapp` |
| `env.template` vs `.env` vs `.env.example` | Three env files | All three exist with different shapes; `.env` is committed and contains a corrupted token (`\`nTZ=UTC`) that looks like a botched PowerShell edit |
| `DEPLOYMENT.md` "Database Configuration" | Says `POSTGRES_PASSWORD=your_secure_password` in `.env` | `docker-compose.yml` no longer provisions Postgres (commit `0bcb437`); backend points at an *external* DB |

**Action:** Either delete the stale scripts from `DEPLOYMENT.md` /
`TROUBLESHOOTING.md` and consolidate everything around `tradingapp.sh`, or
re-introduce the legacy scripts as thin wrappers. The first option is
strongly preferred to match what `README.md` already says.

### 2.2 `FEATURES.md` over-promises

`FEATURES.md` is written as marketing copy and lists capabilities that are
**not** in the code. The following are described as features but are not
implemented (or only partially):

- Dark / light theme toggle (not present — Tailwind only ships one theme).
- Custom watchlists, alerts, sharing.
- Portfolio P&L analytics, position-sizing risk metrics.
- Multi-factor authentication, JWT/RBAC, GDPR controls.
- Order placement (UI is read-only; backend has no `placeOrder` flow even
  though `ib_service` exposes positions/orders read endpoints).
- Connection pooling / failover for IB Gateway (README explicitly says the
  service was simplified to a single synchronous connection).
- Market scanners, sector browsing, search history.
- CSV / JSON / PDF export — only the in-page DataframeViewer exists.
- Keyboard shortcuts and right-click context menus.
- Screen-reader / accessibility / high-contrast modes.

**Action:** Re-baseline `FEATURES.md` into two clearly labelled sections —
*"Currently Available"* and *"Planned / Roadmap"* — so users do not assume
the platform is more featureful than it is.

### 2.3 Database documentation fragmentation

Three SQL schemas + three docs all describe overlapping intent:

- `backend/src/database/schema.sql`
- `backend/src/database/init.sql`
- `backend/src/database/timescaledb-schema.sql`
- `backend/src/database/migrate-to-timescaledb.sql`
- `backend/src/database/README.md`
- `backend/src/database/README_TIMESCALEDB.md`
- `backend/src/database/TIMESCALEDB_SETUP.md`

There is no single "this is the schema we run in production" file. The
backend code (`MarketDataService`) references tables that exist in both
schemas but uses plain Postgres semantics (no hypertable awareness, no
continuous aggregates).

**Action:** Pick one schema (recommend TimescaleDB), delete the others or
move them to an `archive/` folder, update `README.md` to point at it, and
add a Postgres+TimescaleDB service into a separate `docker-compose.db.yml`
override so local dev does not need an external DB.

---

## 3. Architectural & Code Gaps

### 3.1 Data store provisioning

- `docker-compose.yml` declares only `frontend`, `backend`, `ib_service` and
  `redis`. There is **no** `postgres` service.
- Backend defaults `POSTGRES_HOST=localhost`, so out-of-the-box a fresh
  Docker deployment cannot reach a database. The DB health check at
  `/api/database/health` will fail until the operator hand-rolls a Postgres.
- Redis is provisioned but **not used** — `backend` lists `redis` as a
  dependency but `rg redis backend/src` finds zero references in the code.

**Action:**
- Provide an optional `docker-compose.db.yml` that brings up TimescaleDB and
  applies `timescaledb-schema.sql` automatically.
- Either wire Redis into the backend (cache for IB quotes, pub/sub for
  real-time fanout) or remove it from `docker-compose.yml` and from the
  backend's `package.json`.

### 3.2 "Real-time" is not really streaming

- `MSFTRealtimeChart.tsx` is large (916 LoC) but its real-time path appears
  to be: REST poll → Socket.IO subscribe → backend forwards to
  `/market-data/subscribe` on `ib_service` → no actual `emit` of tick data
  back to clients in `backend/src/index.ts`.
- `ib_service` has tick endpoints (`/market-data/tick`) but they are
  request/response — there is no IB `reqMktData` subscription whose ticks
  are pushed back out over a WebSocket.

**Action:**
- Implement an IB `reqMktData` / `reqRealTimeBars` worker in `ib_service`
  that publishes onto a Redis pub/sub channel.
- Have `backend` consume the channel and `io.to('market-data-MSFT').emit()`
  to subscribed clients.
- Throttle/batch on the server side so 100ms tick storms don't melt the
  frontend.

### 3.3 IB connection model

- The service intentionally uses a single synchronous IB client (per
  `README.md`). At scale this caps concurrent requests at 1 and any slow
  historical request will starve interactive lookups.
- `IB_TIMEOUT=15` in `.env` but `30` in `tradingapp.sh`. Inconsistent.
- No `clientId` strategy for multiple workers — every container/replica
  shares `IB_CLIENT_ID=1`, which IB rejects.

**Action:**
- Introduce a small connection pool per worker, parameterised by a
  `clientId` range (`1..N`), so historical/contract/account flows can run
  in parallel.
- Move retry/backoff logic into a dedicated `ib_session.py` module instead
  of inlined in `main.py` (which is now 2,587 lines).

### 3.4 Monolithic modules

| File | LoC | Concern |
|---|---:|---|
| `ib_service/main.py` | 2,587 | Mixes HTTP, IB client, threading, caching, indicators wiring and account handling |
| `frontend/app/components/MSFTRealtimeChart.tsx` | 916 | Chart + data fetch + state + UI controls all in one |
| `frontend/app/components/MarketDataFilter.tsx` | 822 | Filter UI + chart trigger + state |
| `backend/src/routes/marketData.ts` | 773 | All market-data endpoints, validation, DB write-through |

**Action:** Carve `main.py` into `routes/`, `ib_client/`, `cache/` and
`models/` packages. On the frontend, split `MSFTRealtimeChart` into a data
hook (`useRealtimeBars`), a chart presenter and a control bar.

### 3.5 Overlapping chart components

`HistoricalChart.tsx`, `TradingChart.tsx`, `EnhancedTradingChart.tsx` and
`MSFTRealtimeChart.tsx` all create their own `lightweight-charts` instance
with subtly different feature sets (timeframes, periods, indicator overlays).
This guarantees divergence as features are added.

**Action:** Collapse into a single configurable `<Chart>` component that
accepts: data source (`useHistorical` / `useRealtime`), timeframe list,
indicator list and a `mode: 'live' | 'static'` prop.

### 3.6 Settings endpoint reads `/app/.env` directly

`backend/src/routes/settings.ts` reads the container's `.env` file and
returns its parsed contents to whoever calls `GET /api/settings`. Today
that includes `JWT_SECRET`, `SESSION_SECRET`, `POSTGRES_PASSWORD`,
`REDIS_PASSWORD`, `IB_HOST`, etc.

**Action:** Whitelist the keys that are safe to expose (server IP, public
ports, IB host *without* credentials) and never serialise secrets. Add an
explicit `denyList` for `*_SECRET`, `*_PASSWORD`, `*_KEY`.

### 3.7 No authentication / authorisation

- Express app has `app.use(cors())` with no origin restriction (despite
  `CORS_ORIGINS` env var being defined).
- No middleware enforces auth on any route.
- Account, positions, orders, contract search and historical download are
  all open to any caller that can reach the backend port.
- Socket.IO `cors.origin: '*'` — anyone can subscribe to any symbol.

**Action:** Add a token-based auth middleware (header bearer token from the
existing `JWT_SECRET`), tighten CORS to `CORS_ORIGINS`, and require the same
token for Socket.IO `handshake.auth`.

### 3.8 Secrets in repo

- `.env` is committed and contains a corrupted token (`SERVER_IP=localhost\`nTZ=UTC`)
  — looks like a Windows PowerShell escape that landed verbatim in the file.
- `JWT_SECRET=trading_app_jwt_secret_2025` is committed.
- `docker-compose.yml` falls back to `changeme_jwt_secret` /
  `changeme_session_secret`.

**Action:** Delete `.env` from the repository, add it to `.gitignore`,
rotate the leaked secrets, and rely on `.env.example` + `env.template` for
documentation. Consolidate the two example files into one.

---

## 4. Testing, CI/CD & Quality

### 4.1 No tests anywhere

- `backend/package.json` has no test script.
- `frontend/package.json` has no test script.
- `ib_service` has no `pytest`, `tests/` directory or fixtures.
- `.github/workflows/ci.yml` ends with `run: echo "Add your tests here"`.

**Action:**
- Backend: Jest + Supertest covering the validation paths in
  `routes/marketData.ts` and `routes/account.ts`.
- Frontend: Vitest + React Testing Library for `MarketDataFilter`,
  `MSFTRealtimeChart` data hooks and `IndicatorSelector`.
- IB service: `pytest` with a fake `EClient` / `EWrapper` to exercise the
  historical-data assembly logic and indicators math (`indicators.py` is
  pure and a great first target).

### 4.2 CI mismatches the repo

- Workflow triggers on `branches: [main]` but the repo's default branch is
  `master`.
- No linting step (ESLint, Prettier, Ruff, mypy, black are all absent).
- No type-check step for the frontend.
- No Docker build / push step.

**Action:**
- Switch triggers to `master` (or rename the default branch to `main`).
- Add `npm run lint`, `npm run type-check`, `ruff check`, `mypy` and a
  `docker buildx build` smoke test per service.
- Cache `~/.npm` and the pip wheel cache to keep CI fast.

### 4.3 No linting / formatting configuration

There is no `.eslintrc`, no Prettier config, no `pyproject.toml` for Ruff
or Black. `TROUBLESHOOTING.md` references `npm run lint:fix` / `npm run
format` but those scripts do not exist in `frontend/package.json`.

**Action:** Add `eslint-config-next`, Prettier (with `.prettierrc`), Ruff
and Black, plus matching `package.json` / `pyproject.toml` scripts.

### 4.4 No observability

- No structured logging (everything is `console.log` / `print`).
- No metrics endpoint, no Prometheus scraping target.
- No request-id propagation between `frontend → backend → ib_service`.
- No alerting on IB disconnects (the service silently retries).

**Action:**
- Backend: `pino` with `pino-http`, expose `/metrics` via `prom-client`.
- IB service: `structlog` + `prometheus-fastapi-instrumentator`.
- Propagate `x-request-id` end-to-end.
- Add a `/api/health` summary on the frontend status bar that reflects
  IB connection state instead of the hard-coded "Connected to IB Gateway"
  label currently on the home page.

---

## 5. Functional Gaps Against the `.cursorrules` Brief

The repo-level `.cursorrules` states:

> Implement tradingview lightweight charts to display realtime data for the
> stock MSFT, allowing to show 12 months of data across the
> 5minute,15m,30m,1hour,4hour,8hour and 1day timeframes.

Today:

- ✅ Timeframes available: 1m / 5m / 15m / 30m / 1h / 4h / 8h / 1d (the spec
  did not include 1m, but it is implemented anyway — fine).
- ✅ 12-month period selectable (`1Y` option present).
- ⚠️ "Realtime" is not actually streaming (see §3.2).
- ⚠️ MSFT is hard-coded into one page (`/msft`) but the rest of the app is
  generic. The dedicated MSFT page duplicates the generic chart code rather
  than reusing it.

**Action:**
- Make `/msft` a thin wrapper around the generic chart with `symbol="MSFT"`
  prefilled.
- Persist the user's last symbol/timeframe in `localStorage` so the realtime
  view reopens to where they left off.

---

## 6. Data Lifecycle & Storage

- No retention policy is enforced in code, only declared in the schema doc.
- `cleanOldData()` in `marketDataService.ts` calls `SELECT clean_old_data()`
  but returns a hard-coded `{ deleted: 0 }` — the count is never read.
- No backfill scheduler. Users must manually click the *Download* page for
  every symbol / timeframe combination.
- No deduplication / repair job for missing bars (`data_quality_metrics`
  table exists but nothing writes to it).

**Action:**
- Implement a small backfill scheduler in `ib_service` (APScheduler or
  `asyncio.create_task` loop) driven by `data_collection_config` rows.
- Wire `data_quality_metrics` from the actual upload/store path.
- Promote `clean_old_data()` to return row counts so the API isn't lying.

---

## 7. Backtesting

`ib_service/backtesting.py` (434 LoC) and `AVAILABLE_STRATEGIES` are wired
into FastAPI (`GET /backtesting/strategies`, `POST /backtesting/run`). There
is **no frontend UI** for any of this and no backend proxy route, so the
feature is invisible to end users and undocumented in `FEATURES.md`.

**Action:**
- Add `backend/src/routes/backtesting.ts` proxy with input validation.
- Build a `/backtest` page with strategy picker, parameter form, equity
  curve chart and trade-list table.
- Persist backtest results into Postgres so they can be compared
  side-by-side.

---

## 8. Frontend UX Gaps

- The home page reports "Connected to IB Gateway" as static text — there is
  no live indicator wired to `/api/health`.
- No global error boundary; an exception in any chart unmounts the page.
- No loading skeletons; charts pop in once data arrives.
- No keyboard handling on the symbol search (Enter triggers a form submit
  inside `MarketDataFilter` but Escape does not clear, arrow keys do not
  cycle results).
- Mobile layout works (Tailwind responsive classes are everywhere) but the
  TradingView chart container does not resize cleanly on viewport change.

**Action:**
- Add a `<HealthBadge />` that polls `/api/health` every 10 s.
- Add a top-level `error.tsx` boundary (Next.js App Router supports this).
- Hook `ResizeObserver` into every chart container.

---

## 9. Operational / Deployment Gaps

- `tradingapp.sh` is the only deployment path and is documented as the
  authoritative one in `README.md`, but `DEPLOYMENT.md` still tells users
  to run scripts that no longer exist.
- The script edits `.env` with `cat > .env` and overwrites any user-added
  keys (e.g. `POSTGRES_HOST`, `JWT_SECRET`). Custom keys are silently lost
  on `./tradingapp.sh config`.
- No support for non-Linux hosts (script uses `apt`, `usermod`,
  `systemctl`). README mentions macOS; the script will fail on it.
- `verify_timestamp_config.sh` exists but is not referenced from any doc.

**Action:**
- Make `setup_environment` merge into the existing `.env` rather than
  overwrite it. Or write to `.env.local` and let docker-compose load both.
- Add a `--non-interactive` mode for CI use.
- Reference `verify_timestamp_config.sh` from `TROUBLESHOOTING.md` or
  fold it into `./tradingapp.sh diagnose`.

---

## 10. Suggested Roadmap (Prioritised)

Phases are ordered by dependency, not by calendar time.

### Phase 1 — Stabilise documentation & repo hygiene (low risk, high signal)
1. Delete references to non-existent scripts from `DEPLOYMENT.md` and
   `TROUBLESHOOTING.md`; point everything at `tradingapp.sh`.
2. Rewrite `FEATURES.md` into *Available* vs *Planned* sections.
3. Remove `.env` from the repo, rotate leaked secrets, consolidate
   `.env.example` + `env.template`.
4. Pick a single SQL schema (TimescaleDB), archive the others, update the
   database README to match.

### Phase 2 — Make the platform safe to run (security + DB)
5. Add Postgres/TimescaleDB to a `docker-compose.db.yml` override that the
   `tradingapp.sh deploy` flow can opt into.
6. Lock down `routes/settings.ts` to a whitelisted view.
7. Tighten CORS to `CORS_ORIGINS`; require a bearer token on backend routes
   and Socket.IO handshakes.
8. Either delete Redis from the stack or wire it into the backend cache /
   pub-sub paths.

### Phase 3 — Quality bar (tests, lint, CI)
9. Add ESLint + Prettier + Ruff + Black configs and matching npm/pip
   scripts.
10. Replace the placeholder CI step with type-check, lint and a small
    initial test suite (indicators math, request validation).
11. Switch CI triggers from `main` to `master`.

### Phase 4 — Real-time pipeline
12. Implement IB `reqMktData` / `reqRealTimeBars` in `ib_service` publishing
    to Redis.
13. Have backend consume Redis and emit ticks via Socket.IO rooms.
14. Refactor `MSFTRealtimeChart` to consume the streaming feed instead of
    polling.

### Phase 5 — Feature expansion
15. Surface the existing backtesting engine in the frontend.
16. Add a scheduled backfill worker and wire `data_quality_metrics`.
17. Persist last-used symbol/timeframe per session.
18. Add CSV/Parquet export from the DataframeViewer.

### Phase 6 — Operational polish
19. Structured logging, request IDs, Prometheus metrics, health badges.
20. Connection-pool the IB client with a `clientId` range.
21. Split the monolithic `main.py` and the largest frontend components.
22. Add an `error.tsx` boundary and resize observers on charts.

---

## 11. Concrete "Definition of Done" Checklist

A future PR closes out this gap analysis when **all** of the following are
true:

- [ ] `DEPLOYMENT.md` and `TROUBLESHOOTING.md` reference only scripts that
      exist in the repo.
- [ ] `FEATURES.md` accurately reflects what ships today; aspirational items
      live under a clearly-labelled *Planned* heading.
- [ ] `.env` is no longer tracked; `.env.example` is the single source of
      truth for documented environment variables.
- [ ] A single canonical SQL schema is shipped and applied by the default
      deployment.
- [ ] `docker compose up` from a fresh clone produces a working frontend,
      backend, IB service and database — without manual schema bootstrap.
- [ ] `npm run lint`, `npm run type-check`, `ruff check`, `pytest` and
      `npm test` all run in CI and gate merges.
- [ ] Backend has authentication middleware and CORS is bound to
      `CORS_ORIGINS`.
- [ ] Real-time chart receives ticks via Socket.IO emitted from a
      backend-side subscription, not browser polling.
- [ ] Backtesting is exposed in the UI.
- [ ] A health badge on the home page reflects live IB Gateway and database
      state.

---

_This document is intended for ongoing planning; please update it (or
supersede sections) as work lands._
