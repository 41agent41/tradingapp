# Development Iteration Guidance

## Codebase Review Summary

**Date**: March 31, 2026  
**Branch**: `cursor/development-iteration-guidance-d9dd`  
**Base**: `master`

---

## 1. Build Status

| Component | Build Status | Details |
|-----------|-------------|---------|
| **Backend (TypeScript)** | PASS | `tsc --noEmit` compiles with zero errors |
| **Frontend (Next.js)** | PASS | `next build` succeeds; all 6 routes compiled (/, /account, /download, /historical, /msft, /_not-found) |
| **IB Service (Python)** | PASS | All dependencies install; `indicators` and `backtesting` modules import cleanly |
| **CI Pipeline (GitHub Actions)** | PASS | All 10 recent runs on `main` are green (last run: June 29, 2025) |
| **Docker Compose** | DEFINED | 4 services configured: frontend, backend, ib_service, redis |

---

## 2. What Has Been Completed

### Core Architecture
- Three-service Docker Compose architecture (Next.js 14 frontend, Express/TypeScript backend, FastAPI/Python IB service)
- Static IP networking in Docker (172.20.0.x subnet)
- Unified management script (`tradingapp.sh`)

### TradingView Charts
- Lightweight Charts v4 integrated with candlestick + volume rendering
- Multiple chart components: `EnhancedTradingChart`, `HistoricalChart`, `MSFTRealtimeChart`, `TradingChart`
- Timeframes: tick, 1m, 5m, 15m, 30m, 1h, 4h, 8h, 1d
- Period selection: 1D, 5D, 1M, 3M, 6M, 1Y
- Responsive design with Tailwind CSS

### Interactive Brokers Integration
- Full TWS API client (`EClient`/`EWrapper`) implementation in `ib_service/main.py`
- Contract search (basic and advanced) with 3-phase symbol discovery
- Historical data retrieval with proper timestamp handling
- Real-time market data via polling
- Technical indicators calculation (SMA, EMA, RSI, MACD, Bollinger Bands)
- Backtesting engine with strategy framework

### Data Layer
- PostgreSQL integration with connection pooling (`pg` library)
- Database service with transaction support (`backend/src/services/database.ts`)
- Market data service for CRUD operations (`backend/src/services/marketDataService.ts`)
- SQL schemas: basic (`schema.sql`, `init.sql`) and TimescaleDB-optimized (`timescaledb-schema.sql`)
- Migration script for TimescaleDB (`migrate-to-timescaledb.sql`)

### Frontend Pages
- **Home** (`/`): Dashboard with quick-access cards, market data search, trading account toggle
- **Historical** (`/historical`): Chart with exchange-driven filters, indicator overlays, dataframe viewer
- **Download** (`/download`): IB data download -> PostgreSQL upload pipeline
- **MSFT Real-time** (`/msft`): Dedicated MSFT chart with indicators and custom date ranges
- **Account** (`/account`): Account info, positions, connection status

### Other
- Socket.IO configured for real-time subscriptions (backend)
- Data query enable/disable toggle on all pages
- Exchange-driven filtering (US + Australian markets)
- DataframeViewer component with pagination and CSV export
- CI pipeline (GitHub Actions) building all 3 services
- Comprehensive documentation (8 markdown files)

---

## 3. Critical Issues Found

### P0 - Blocking / Data Integrity

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 1 | **No `.gitignore` file** | Repository root | `node_modules/`, `.next/`, `dist/`, `__pycache__/`, `.env` could be committed; `.env` with IB Gateway IP and secrets IS currently committed | 
| 2 | **`.env` committed with secrets** | `/.env` | Contains `IB_HOST=10.7.3.21`, JWT/session secrets, database passwords in version control |
| 3 | **Malformed `.env` values** | `/.env` line 8-9 | `SERVER_IP=localhost\`nTZ=UTC` and `ENVIRONMENT=production\`nTZ=UTC` contain backtick-n instead of proper newlines |
| 4 | **CI triggers on `main` but repo uses `master`** | `.github/workflows/ci.yml` | CI listens on `branches: [main]` but all commits are on `master`; CI may not be triggering on pushes |

### P1 - Functional Gaps

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 5 | **`EnhancedTradingChart` and `TradingChart` skip `X-Data-Query-Enabled` header** | `frontend/app/components/EnhancedTradingChart.tsx:164`, `TradingChart.tsx:223` | These chart components make fetch calls WITHOUT the `X-Data-Query-Enabled: true` header; the backend `isDataQueryEnabled()` check returns `false`, so the backend returns `{ disabled: true }` instead of actual data |
| 6 | **`IndicatorSelector` bypasses backend proxy** | `frontend/app/components/IndicatorSelector.tsx:46` | Uses `apiUrl.replace(':4000', ':8000')` to call IB service directly; fragile, breaks in Docker where service name resolution is used |
| 7 | **Redis provisioned but never used** | `docker-compose.yml`, `backend/src/` | Redis container runs but zero backend code imports or uses it; it's consuming resources for nothing |
| 8 | **No real-time WebSocket data push** | `backend/src/index.ts:130-180` | Socket.IO is configured and accepts subscriptions, but there's no loop pushing real-time market data from IB to clients; subscriptions are acknowledged but data never flows |
| 9 | **No tests exist** | `ci.yml:54` | CI has `echo "Add your tests here"` placeholder; zero unit, integration, or e2e tests |
| 10 | **No lock files committed** | Repository root | No `package-lock.json` or `yarn.lock`; builds are non-deterministic |

### P2 - Architecture / Quality

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| 11 | **`ib_service/main.py` is 2500+ lines** | `ib_service/main.py` | Monolithic file combining API routes, IB client, data models, caching, indicators, backtesting; hard to maintain |
| 12 | **FEATURES.md is aspirational** | `FEATURES.md` | Lists unimplemented features as existing: dark/light themes, keyboard shortcuts, custom watchlists, portfolio P&L, market scanning, authentication, rate limiting |
| 13 | **Deployment docs reference non-existent scripts** | `DEPLOYMENT.md` | References `deploy-tradingapp.sh`, `diagnose-connection.sh`, `fix-ib-connection.sh` but only `tradingapp.sh` exists |
| 14 | **No linting or formatting configuration** | Repository root | No `.eslintrc`, `.prettierrc`, or similar |
| 15 | **TimescaleDB schema exists but isn't integrated** | `backend/src/` | SQL files for TimescaleDB are written but the backend Node.js service still uses basic PostgreSQL queries; no hypertable-aware code |

---

## 4. Recommended Next Iteration: Priority-Ordered Tasks

### Tier 1: Fix Critical Issues (do first)

**1.1 Add `.gitignore` and remove committed secrets**
- Create a comprehensive `.gitignore` covering: `node_modules/`, `.next/`, `dist/`, `__pycache__/`, `.env`, `*.log`
- Remove `.env` from tracking (`git rm --cached .env`)
- Ensure `.env.example` (already exists) serves as the template

**1.2 Fix `.env` malformed values**
- Fix lines 8-9 that have backtick-n artifacts
- Separate `TZ=UTC` into its own line properly

**1.3 Fix CI branch trigger**
- Change `.github/workflows/ci.yml` to trigger on `master` (or whichever branch is the actual default)
- Add trigger for pull requests against `master`

**1.4 Commit lock files**
- Run `npm install` in both `backend/` and `frontend/`, then commit the `package-lock.json` files for reproducible builds

### Tier 2: Fix Functional Bugs (high value)

**2.1 Add `X-Data-Query-Enabled` header to all fetch calls**
- `EnhancedTradingChart.tsx` and `TradingChart.tsx` are silently broken because they don't send this header
- Either: (a) add the header to all components, or (b) remove the server-side gate entirely since it creates a confusing UX where charts simply don't load

**2.2 Fix `IndicatorSelector` direct IB service call**
- Route through the backend API proxy instead of `.replace(':4000', ':8000')` 
- Ensure the backend exposes a `/api/market-data/indicators/available` endpoint that proxies to IB service

**2.3 Implement real-time WebSocket data flow**
- The Socket.IO infrastructure exists but no data is pushed
- Implement: IB service streams -> Backend receives -> Backend pushes via Socket.IO -> Frontend receives and updates chart
- This is the core value proposition: "realtime data for the stock MSFT"

### Tier 3: Infrastructure Improvements (important for scale)

**3.1 Decide on Redis: use it or remove it**
- Option A: Implement Redis caching for frequently-accessed market data, contract search results, and session management
- Option B: Remove Redis from `docker-compose.yml` to reduce operational complexity
- Recommendation: Use it for caching IB API responses (reduce rate limiting issues)

**3.2 Add basic test suite**
- Backend: API endpoint tests with supertest (health, search validation, history parameter validation)
- Frontend: Component render tests with React Testing Library
- IB Service: Unit tests for indicators module, backtesting module
- Update CI to run actual tests

**3.3 Add linting and formatting**
- ESLint + Prettier for TypeScript (frontend and backend)
- Ruff or flake8 for Python (IB service)
- Add to CI pipeline as a required check

**3.4 Refactor `ib_service/main.py`**
- Extract into modules: `routes/`, `services/ib_client.py`, `models/`, `config.py`
- Keep `main.py` as the FastAPI app entry point only

### Tier 4: Feature Development (next features)

**4.1 Complete the real-time MSFT chart experience**
- WebSocket-based live candlestick updates (not polling)
- Auto-reconnection with exponential backoff
- Visual connection status indicator (green/yellow/red)
- Smooth chart transitions when new bars arrive

**4.2 Integrate TimescaleDB properly**
- Update `docker-compose.yml` to use `timescale/timescaledb:latest-pg15` image
- Run the TimescaleDB schema on startup
- Update `marketDataService.ts` to leverage hypertable queries and continuous aggregates
- Implement the retention policies

**4.3 Multi-symbol support**
- The `.cursorrules` mentions MSFT specifically, but the architecture already supports any symbol
- Add a symbol watchlist/selector on the home page
- Allow opening multiple charts simultaneously

**4.4 Implement authentication**
- JWT_SECRET is configured but unused
- Add basic auth middleware to protect API endpoints
- Add login page to frontend

**4.5 Honest FEATURES.md**
- Audit `FEATURES.md` against actual implementation
- Mark unimplemented features as "Planned" or remove them
- This avoids confusion about the actual state of the system

---

## 5. Suggested Development Order for Next Sprint

```
Priority  Task                                              Effort
────────  ─────────────────────────────────────────────────  ──────
  1       Add .gitignore + remove .env from tracking         Small
  2       Fix .env malformed values                          Small
  3       Fix CI branch trigger (main -> master)             Small
  4       Commit package-lock.json files                     Small
  5       Fix X-Data-Query-Enabled header in all components  Small
  6       Fix IndicatorSelector direct call pattern          Small
  7       Implement WebSocket real-time data push            Medium
  8       Decide + implement Redis caching (or remove)       Medium
  9       Add basic test suite                               Medium
 10       Refactor ib_service/main.py into modules           Medium
 11       Integrate TimescaleDB into backend service          Large
 12       Add ESLint/Prettier/Ruff configuration             Small
 13       Update FEATURES.md to reflect reality              Small
 14       Fix deployment documentation references            Small
```

---

## 6. Architecture Notes

### Current Data Flow
```
Browser → Next.js (SSR/CSR) → Express Backend → FastAPI IB Service → IB Gateway
                                    ↓
                              PostgreSQL (storage)
                              Redis (unused)
```

### Target Data Flow (with real-time)
```
Browser ←─ WebSocket ──── Express Backend ←── IB Service ←── IB Gateway
   ↕                          ↕
Next.js (REST)           PostgreSQL + Redis
                         (cache + persistence)
```

### Key Technical Decisions Needed
1. **TimescaleDB vs Plain PostgreSQL**: TimescaleDB schemas are written but not integrated. If data volumes will be small (<1M rows), plain PostgreSQL with proper indexes suffices. For larger volumes or multi-symbol streaming, TimescaleDB is worth the operational complexity.
2. **WebSocket vs Polling for Real-time**: Current code polls via REST. True real-time requires WebSocket push, which Socket.IO already supports. The backend just needs the push loop implemented.
3. **IB API Rate Limits**: IB Gateway has strict rate limits (50 messages/second). Redis caching of recent requests would help avoid hitting these limits during high-traffic usage.
