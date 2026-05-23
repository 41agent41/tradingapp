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
   - [Technical indicators](#technical-indicators)
   - [Backtesting (API only)](#backtesting-api-only)
   - [Historical data download](#historical-data-download)
   - [Account read endpoints](#account-read-endpoints)
   - [REST & WebSocket API](#rest--websocket-api)
   - [Interactive Brokers integration](#interactive-brokers-integration)
   - [Deployment & operations](#deployment--operations)
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

> ⚠️ The "real-time" updates are currently driven by REST polling against
> `/api/market-data/realtime` and `/api/market-data/history`. True
> streaming via IB market-data subscriptions and Socket.IO fan-out is on
> the roadmap (Phase 4 in `GAP_ANALYSIS.md`).

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

### Backtesting (API only)

`ib_service/backtesting.py` ships an event-driven backtest engine and two
sample strategies:

- `ma_crossover` (simple moving-average crossover)
- `rsi_mean_reversion`

Exposed via `GET /backtesting/strategies` and `POST /backtesting/run` on the
IB service. There is **no frontend UI** for backtesting yet — the feature
is reachable only via the API.

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

### Account read endpoints

The backend proxies the following read-only IB account endpoints to the
frontend:

- `GET /api/account/summary` — account balances and key metrics.
- `GET /api/account/positions` — current positions.
- `GET /api/account/orders` — open orders.
- `GET /api/account/all` — all of the above in one call.
- `GET /api/account/connection` — IB connection state.

> The order endpoint is read-only. Order placement is not implemented.

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
| `/api/settings` | GET | Echo back the loaded `.env` (see security note in `GAP_ANALYSIS.md`) |

Socket.IO is mounted on the backend at the default path. Clients can call
`subscribe-market-data` / `unsubscribe-market-data` for a given symbol +
timeframe; the backend forwards these to the IB service's subscription
endpoints. (Streaming tick fan-out back to the client is on the roadmap.)

All endpoints return JSON. Errors carry an `error`, `message` and
`timestamp` payload. Common HTTP statuses are `400` for validation, `503`
when the IB service is unreachable, `504` on IB timeouts.

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
  (`setup`, `deploy`, `redeploy`, `config`, `start`, `stop`, `restart`,
  `status`, `logs`, `test`, `diagnose`, `fix`, `ib-help`, `clean`).
- See [`DEPLOYMENT.md`](DEPLOYMENT.md) for the full reference.

---

## Planned / Roadmap

The items below are described in the existing documentation set or
implied by the codebase but are **not yet implemented**. They are the
forward-looking work tracked in [`GAP_ANALYSIS.md`](GAP_ANALYSIS.md).

### Real-time pipeline

- IB `reqMktData` / `reqRealTimeBars` worker in the IB service.
- Redis pub/sub fan-out from `ib_service` to `backend`.
- Socket.IO push of ticks/bars to subscribed clients (replacing the
  current polling model).

### Backtesting UI

- Frontend `/backtest` page with strategy picker, parameter form, equity
  curve and trade-list table.
- Persistence of backtest runs into Postgres for comparison.

### Order management

- `POST /api/orders` to place / cancel / modify orders through IB.
- Frontend order ticket and blotter.

### Authentication, authorisation & secrets

- Token-based auth middleware on the backend (currently every route is
  open).
- Tightened CORS (currently `*`).
- Authenticated Socket.IO handshake.
- Whitelisted `GET /api/settings` response so secrets cannot leak.
- Optional MFA, RBAC, audit logging.

### Database & data lifecycle

- A `docker-compose.db.yml` override that brings up TimescaleDB locally
  and applies the canonical schema automatically.
- Scheduled backfill of missing bars driven by `data_collection_config`.
- Population of `data_quality_metrics` from the upload path.
- Real row counts returned from `clean_old_data()` rather than the current
  hard-coded `0`.

### Caching

- Wire the existing Redis container into the backend (quote cache,
  per-symbol rate-limit windows, real-time pub/sub).
- Or drop Redis from the stack if we keep deferring this work.

### Observability

- Structured logging (`pino` / `pino-http` for Node, `structlog` for
  Python).
- `/metrics` Prometheus endpoint on backend and IB service.
- End-to-end `x-request-id` propagation.
- Live IB connection badge on the home page (currently the status text is
  static).

### Frontend UX

- Persist last-used symbol and timeframe in `localStorage`.
- Global Next.js `error.tsx` boundary.
- Loading skeletons on the chart pages.
- Resize observers so charts re-fit on viewport changes.
- CSV / Parquet export from the DataFrame viewer.
- Watchlists and alerts.
- Sector / scanner browsing.

### Testing, linting, CI

- Jest + Supertest on the backend.
- Vitest + React Testing Library on the frontend.
- `pytest` on the IB service (the indicator math in `indicators.py` is the
  easiest first target).
- ESLint + Prettier, Ruff + Black, plus a real CI workflow gated on
  `master`.

### Refactors

- Split the 2,587-line `ib_service/main.py` into `routes/`, `ib_client/`,
  `cache/` and `models/`.
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

### Workflow: run a backtest (API)

```bash
curl -s http://<server-ip>:8000/backtesting/strategies | jq

curl -s -X POST 'http://<server-ip>:8000/backtesting/run' \
  --data-urlencode 'symbol=MSFT' \
  --data-urlencode 'strategy=ma_crossover' \
  --data-urlencode 'timeframe=1day'
```

(The UI for this lives on the roadmap — see [Planned / Roadmap](#planned--roadmap).)

---

If you spot a feature here that should be in *Available* but isn't, or
vice-versa, please open an issue. Keeping this document honest is part of
the Phase 1 hygiene work tracked in [`GAP_ANALYSIS.md`](GAP_ANALYSIS.md).
