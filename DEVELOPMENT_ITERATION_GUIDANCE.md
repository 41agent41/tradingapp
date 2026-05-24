# Development Iteration Guidance

## Codebase Review Summary

**Date**: May 24, 2026
**Branch**: `master`
**Base commit**: `c258a9d` (Phase 4 real-time pipeline merged)

> This is a point-in-time engineering snapshot. For the full prioritised
> gap list and roadmap see [`GAP_ANALYSIS.md`](GAP_ANALYSIS.md); for the
> user-facing capability list see [`FEATURES.md`](FEATURES.md). This file
> deliberately overlaps with those but stays focused on *build health* and
> *the next iteration's task order*.

---

## 1. Build Status

| Component | Status | Details |
|-----------|--------|---------|
| **Backend (TypeScript)** | PASS | `tsc --noEmit` clean; ESLint + Prettier + Jest/Supertest wired and green in CI |
| **Frontend (Next.js 14)** | PASS | `next build` compiles all routes (`/`, `/account`, `/download`, `/historical`, `/msft`); ESLint + Prettier + Vitest in CI |
| **IB Service (Python/FastAPI)** | PASS | Ruff + Black + pytest (`tests/test_indicators.py`, `tests/test_streaming.py`) in CI |
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
  `MSFTRealtimeChart` (not yet consolidated — see §3).

### Interactive Brokers integration
- TWS API client (`EClient`/`EWrapper`) in `ib_service/main.py`.
- Contract search (basic + advanced) and 3-phase symbol discovery.
- Historical data retrieval with UTC timestamp handling.
- Technical indicators (`indicators.py`) and an API-only backtesting engine
  (`backtesting.py`).
- **Real-time streaming** (`streaming.py`): `reqMktData` → Redis publish.

### Data & backend services
- PostgreSQL/TimescaleDB via `pg` with a 20-connection pool
  (`services/database.ts`); CRUD in `services/marketDataService.ts`.
- Single canonical schema (`timescaledb-schema.sql`); legacy SQL archived.
- Redis read-through cache (`services/cache.ts`).
- Real-time bridge (`services/streamingBridge.ts`): Redis subscribe →
  Socket.IO room fan-out with per-symbol refcounting.
- Bearer-token auth (`middleware/auth.ts`) on REST + Socket.IO; strict CORS;
  allow-listed `routes/settings.ts`.

### Frontend pages
- **Home** (`/`): dashboard, market-data search, trading-account toggle.
- **Historical** (`/historical`): exchange-driven filters, indicator
  overlays, dataframe viewer.
- **Download** (`/download`): IB download → PostgreSQL upload pipeline.
- **MSFT Real-time** (`/msft`): streaming chart via `useRealtimeStream`.
- **Account** (`/account`): summary, positions, orders, connection status.

### Quality & hygiene
- `.gitignore` present; `.env` removed from tracking; `.env.example` is the
  single template.
- Lint/format/type-check/test scripts for all three services + CI gate.

---

## 3. Current Issues & Gaps

The Phase 1–4 issues from the previous snapshot (committed `.env`, malformed
env values, CI-on-`main`, unused Redis, no real-time push, no tests,
aspirational `FEATURES.md`, stale deploy scripts, no linting) are **resolved**.
What remains:

### P1 — Functional gaps
| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 1 | **`data_quality_metrics` never populated** | `services/marketDataService.ts` | `updateDataQualityMetrics()` has no caller; the table and quality scores stay empty |
| 2 | **`clean_old_data()` returns hard-coded `0`** | `services/marketDataService.ts:404` | `POST /api/market-data/database/clean` always reports `{ deleted: 0 }` |
| 3 | **Indicator persistence mismatch** | `services/marketDataService.ts:127`, `routes/marketData.ts:491` | `INSERT INTO technical_indicators` targets a table the canonical schema omits → errors on a fresh DB |
| 4 | **No backfill scheduler** | `ib_service` | Data collection is fully manual via the Download page |
| 5 | **Backtesting & order placement have no UI** | frontend, `backend/src/routes` | Backtesting is API-only; order placement is unimplemented end to end |

### P2 — Architecture / quality
| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 6 | **`ib_service/main.py` is ~2,700 lines** | `ib_service/main.py` | Routes, IB client, threading, caching, indicators and accounts in one file |
| 7 | **Four overlapping chart components** | `frontend/app/components` | `HistoricalChart` / `TradingChart` / `EnhancedTradingChart` / `MSFTRealtimeChart` diverge |
| 8 | **No observability** | all services | No structured logging, `/metrics`, or `x-request-id` propagation |
| 9 | **Static IB status on the home page** | `frontend/app/page.tsx` | Label is hard-coded rather than driven by `/api/health` |
| 10 | **No global `error.tsx` / `ResizeObserver`** | `frontend/app` | Chart exceptions unmount the page; charts don't re-fit on resize |
| 11 | **Single synchronous IB client** | `ib_service/main.py` | Caps concurrency at 1; shared `IB_CLIENT_ID=1` blocks replicas |

---

## 4. Recommended Next Iteration

### Tier 1 — Close the data-lifecycle gaps (high value, contained)
1. Call `updateDataQualityMetrics()` from the upload/store path.
2. Make `clean_old_data()` return real row counts.
3. Resolve the `technical_indicators` mismatch (drop the persistence path or
   add the table to the canonical schema).

### Tier 2 — Surface existing engines
4. Add `backend/src/routes/backtesting.ts` proxy + a `/backtest` page.
5. Add a scheduled backfill worker in `ib_service` driven by
   `data_collection_config`.

### Tier 3 — Operational polish
6. Structured logging (`pino` / `structlog`), `/metrics`, `x-request-id`.
7. `<HealthBadge />` reflecting IB / DB / cache / streaming state.
8. `error.tsx` boundary + `ResizeObserver`s on chart containers.

### Tier 4 — Refactors
9. Split `ib_service/main.py` into `routes/` / `ib_client/` / `streaming/` /
   `models/`.
10. Consolidate the four chart components into one configurable `<Chart>`;
    make `/msft` a thin wrapper.
11. Connection-pool the IB client across a `clientId` range.

---

## 5. Suggested Development Order for Next Sprint

```
Priority  Task                                                Effort
────────  ──────────────────────────────────────────────────  ──────
  1       Wire updateDataQualityMetrics() into upload path     Small
  2       Return real counts from clean_old_data()             Small
  3       Resolve technical_indicators schema/code mismatch    Small
  4       Backend backtesting proxy + /backtest UI             Medium
  5       Scheduled backfill worker (APScheduler)              Medium
  6       Structured logging + /metrics + x-request-id         Medium
  7       Live HealthBadge on the home page                    Small
  8       error.tsx boundary + ResizeObserver on charts        Small
  9       Split ib_service/main.py into modules                Medium
 10       Consolidate chart components into one <Chart>        Medium
 11       IB client connection pool (clientId range)           Large
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
```

- REST: every route except the health checks requires a bearer token; the
  frontend `apiFetch` attaches it automatically.
- Real-time: `ib_service` publishes ticks to Redis; the backend bridge fans
  them out to Socket.IO rooms; `useRealtimeStream` consumes them.
- Caching: `/api/market-data/realtime` and `/indicators/available` are served
  through the Redis read-through cache, degrading to a miss on outage.
- Storage: historical bars read DB-first (`use_database=true`) with a live IB
  fallback.

### Remaining technical decisions
1. **Indicator persistence**: compute-on-demand only, or add a
   `technical_indicators` hypertable to the canonical schema.
2. **IB concurrency**: keep the single synchronous client, or pool across a
   `clientId` range for parallel historical / streaming / account flows.
3. **Order management**: whether to implement live order placement at all,
   and if so, behind what safeguard.
```

