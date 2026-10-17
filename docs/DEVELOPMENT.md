# Developing TradingApp

How the code is laid out, how to run it locally, how to test it, how the
database schema evolves, and how to add a broker. Installing and running the
app for real are in [INSTALL.md](INSTALL.md) and
[OPERATIONS.md](OPERATIONS.md).

## Contents

1. [Architecture](#architecture)
2. [Repository layout](#repository-layout)
3. [Run it locally](#run-it-locally)
4. [Tests, lint and CI](#tests-lint-and-ci)
5. [Database and migrations](#database-and-migrations)
6. [Settings and secrets](#settings-and-secrets)
7. [Adding a broker](#adding-a-broker)
8. [The MT5 sidecar](#the-mt5-sidecar)
9. [Documentation](#documentation)

---

## Architecture

```
                      ┌──────────────────────────┐
  browser ──────────► │ frontend (Next.js)       │  forwards /api and /socket.io
                      └────────────┬─────────────┘
                                   │
                      ┌────────────▼─────────────┐      ┌───────────────────────┐
                      │ backend (Express, TS)    │◄────►│ PostgreSQL+TimescaleDB│
                      │ auth, settings, orders,  │      │ settings, connections,│
                      │ strategies, schedulers   │      │ bars, orders, audit   │
                      └──────┬──────────────┬────┘      └───────────────────────┘
                             │ token        │
                   ┌─────────▼──────┐  ┌────▼────┐
                   │ broker_service │  │  Redis  │  cache, live ticks
                   │ (FastAPI, Py)  │──►         │
                   └─────────┬──────┘  └─────────┘
                             │  adapters, in priority order
              OANDA ─ MT5 (sidecar) ─ IB Gateway ─ Alpaca
```

- **frontend** (`frontend/`): Next.js 14 pages under `app/`, served by
  `server.js`, which also proxies `/api` and `/socket.io` to the backend
  (`proxy.js`), so the browser only ever talks to one address.
- **backend** (`backend/`): Express + TypeScript. Owns the database: it waits
  for it, migrates it and checks the encryption key before serving
  (`services/startupGate.ts`). Holds auth, settings, the order path and
  audit, strategy runner, backfill, fills sync, kill switch and alerts. It
  is the only caller of the broker service.
- **broker_service** (`broker_service/`): FastAPI + Python. Has no database.
  One adapter per platform (`ib_adapter.py`, `mt5_adapter.py`,
  `oanda_adapter.py`, `alpaca_adapter.py`) behind the protocols in
  `adapters.py`. Also the indicator maths, the backtester, the rule engine
  and the embedded Jesse port. Every call except `/`, `/health` and
  `/metrics` needs the `X-Broker-Service-Token`.
- **mt5_sidecar** (`mt5_sidecar/`): runs next to an MT5 terminal on Windows
  or Wine and speaks HTTP to `mt5_adapter.py`.
- **Redis**: a read-through cache and the live-tick bus
  (`broker_service/streaming.py` publishes, `backend/src/services/streamingBridge.ts`
  fans out to Socket.IO rooms). Everything works without it.

Broker connections are stored by the backend (`broker_connections`, secrets
encrypted) and pushed to the broker service with `PUT /connections/managed`
after every change and whenever the broker service restarts
(`backend/src/services/brokerSync.ts`). Design records for the larger
features are in [`docs/plans/`](plans/).

---

## Repository layout

| Path | What |
|---|---|
| `tradingapp.sh` | The management script (install, deploy, doctor, ...) |
| `docker-compose.yml`, `docker-compose.db.yml` | The stack, and the bundled database layered on top |
| `install/` | Unattended installer, Proxmox container script, MT5-under-Wine script |
| `backend/src/index.ts` | App entry; `routes/`, `services/`, `middleware/`, `config/` (settings registry), `cli/` (migrate, importSettings, forgetSecrets) |
| `backend/src/database/` | `timescaledb-schema.sql` (baseline), `migrations/`, `archive/` (old SQL, not used) |
| `backend/tests/` | Jest; `*.db.test.ts` need a real database |
| `frontend/app/` | Pages (`settings`, `systematic`, `backtest`, `trade`, `historical`, `download`, `watchlist`, `account`, `msft`), `components/`, `lib/` |
| `broker_service/` | `main.py`, `routes/`, adapters, `connections.py` (manifest and priority), `managed.py`, `rule_strategy.py`, `backtesting.py`, `jesse/`, `jesse_strategies/`, `templates/`, `tests/` |
| `mt5_sidecar/` | `server.py`, `terminal.py`, `deploy/` (Task Scheduler and systemd launchers), `tests/` |
| `e2e/` | End-to-end paper run against simulated MT5 terminals |
| `ops/` | Prometheus alert rules, Grafana dashboard |
| `docs/` | These guides; `docs/plans/` holds design records |

---

## Run it locally

You need Node 20, Python 3.11 and a PostgreSQL with TimescaleDB. The quickest
database:

```bash
docker run -d --name tsdb -p 5432:5432 \
  -e POSTGRES_USER=tradingapp -e POSTGRES_PASSWORD=devpassword -e POSTGRES_DB=tradingapp \
  timescale/timescaledb:2.17.2-pg15
```

**Broker service** (port 8000):

```bash
cd broker_service
pip install -r requirements.txt -r requirements-dev.txt
BROKER_SERVICE_TOKEN=dev-broker-token-0123456789abcdef python main.py
```

With no `BROKER_SERVICE_TOKEN` it warns and accepts unauthenticated calls.
Brokers come from the backend's push, or for a quick test from a
`BROKER_CONNECTIONS` manifest in its environment (format at the top of
`connections.py`; `e2e/stack.sh` has a working example).

**Backend** (port 4000). It loads `backend/.env` if present:

```bash
cd backend
cat > .env <<'EOF'
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=tradingapp
POSTGRES_PASSWORD=devpassword
POSTGRES_DB=tradingapp
SETTINGS_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000001
BROKER_SERVICE_URL=http://127.0.0.1:8000
BROKER_SERVICE_TOKEN=dev-broker-token-0123456789abcdef
REDIS_ENABLED=false
EOF
npm install
npm run dev
```

`BROKER_SERVICE_URL` must be set: its default is the compose service name,
which does not resolve outside Docker. With Redis running locally, drop
`REDIS_ENABLED=false` and set `REDIS_HOST`. The backend creates the schema on
first start.

Outside `NODE_ENV=production`, with no login password and no API token set,
the backend accepts unauthenticated requests and says so loudly at startup.
Set `API_TOKEN` (or choose a password on first visit) to exercise auth.

**Frontend** (port 3000):

```bash
cd frontend
npm install
npm run dev        # BACKEND_INTERNAL_URL defaults to http://localhost:4000
```

The Docker images do not hot-reload. To try a change in the full stack, run
`./tradingapp.sh redeploy`.

---

## Tests, lint and CI

| Component | Lint and format | Types | Tests |
|---|---|---|---|
| backend | `npm run lint`, `npm run format:check` | `npm run type-check` | `npm test` (Jest + Supertest) |
| frontend | `npm run lint`, `npm run format:check` | `npm run type-check` | `npx vitest run` |
| broker_service | `ruff check .`, `black --check .` | | `pytest -q` |
| mt5_sidecar | `ruff check .`, `black --check .` | | `pytest -q` |

Backend tests named `*.db.test.ts` need a real database. CI builds the schema
the way the backend does, then runs them:

```bash
cd backend && npm run build
DB_TESTS=1 POSTGRES_HOST=localhost POSTGRES_USER=tradingapp POSTGRES_PASSWORD=devpassword \
  POSTGRES_DB=tradingapp SETTINGS_ENCRYPTION_KEY=<64 hex> node dist/cli/migrate.js
DB_TESTS=1 ... npx jest --runInBand '\.db\.test\.ts$'
```

**End-to-end paper run.** `e2e/run.sh` starts two simulated MT5 terminals
behind the real sidecar code (`e2e/sim_sidecar.py`), the broker service, and
the backend with the strategy runner executing on paper, then runs
`e2e/test_paper_flow.py`: deploying a strategy, orders with stops attached,
trailing, fills, limits, prop rules, the kill switch and restarts. It needs
`POSTGRES_*` pointing at a TimescaleDB, the backend built, and both services'
Python requirements. `e2e/stack.sh start|stop|restart <component>` runs the
stack on its own for poking at.

**CI** (`.github/workflows/ci.yml`) runs on every push and pull request to
`master` (and `main`): a job per component with lint, format, types, tests
and build (the backend job adds the database tests against TimescaleDB), and
the end-to-end paper run.

---

## Database and migrations

The schema lives in `backend/src/database/` and the backend applies it itself
(`backend/src/services/migrations.ts`). Nobody runs SQL against it by hand.

On every start the backend waits for the database (backoff 1 to 30 seconds,
no deadline), takes a Postgres advisory lock, applies whatever is pending,
checks the encryption key, and only then serves. Until then every API route
answers 503 with the state: `waiting_for_database`, `migrating`,
`migration_failed` or `key_mismatch`.

Two kinds of file:

- **The baseline**, `timescaledb-schema.sql`, recorded as `000_baseline`.
  Every statement in it is idempotent (`IF NOT EXISTS`,
  `ADD COLUMN IF NOT EXISTS`, guarded `DO $$` blocks). It is applied again
  whenever its SHA-256 changes, so a fresh database is built from it and an
  older one is carried forward by it.
- **Numbered migrations**, `migrations/NNN_name.sql` (three digits, then
  lower-case letters, digits and underscores). Each runs once, in order, in
  its own transaction. Files that do not match the pattern are ignored.

Every applied file is recorded in `schema_migrations`. A failed file is left
unrecorded and retried on the next start. Editing a numbered migration after
it shipped does nothing on databases that already ran it (the backend logs a
warning).

To add a migration:

1. Create `migrations/NNN_short_name.sql` with the next number (`004_...`
   follows `003_collection_history.sql`).
2. Open with a comment saying what it changes and why.
3. Make it idempotent where you can. Do not add `BEGIN`/`COMMIT`, and do not
   use statements that cannot run in a transaction (`CREATE INDEX
   CONCURRENTLY`).
4. Make the same change in `timescaledb-schema.sql`, so fresh installs get
   it. A fresh database runs the baseline and then the migration, which is
   why the migration must tolerate the change already being there.
5. Never edit a shipped migration; write a new one.
6. `./tradingapp.sh migrate` (or a restart) applies it; `doctor` shows the
   state. Locally, `node dist/cli/migrate.js` in `backend/`.

What the schema holds, in short (read the files for the full list):

| Object | Notes |
|---|---|
| `contracts` | One row per resolved instrument |
| `candlestick_data` | OHLCV bars; hypertable, 1-day chunks, dropped after 2 years |
| `tick_data` | Ticks; hypertable, 1-hour chunks, dropped after 30 days |
| `daily_candlestick_data` | Continuous aggregate, refreshed hourly over the last 3 days |
| `data_collection_config` | The Settings page's collection table, with `history_start` and progress |
| `data_quality_metrics` | Per-day bar counts and a quality score, written on every store path |
| `broker_connections`, `app_settings`, `settings_audit`, `auth_credentials`, `app_meta` | Connections, settings and their history, login and tokens; `app_meta` holds the value that proves the encryption key |
| `order_audit`, `order_executions` | Every order attempt; venue fills, unique on `(broker, broker_account, exec_id)` |
| `strategy_definitions`, `strategy_run_groups`, `strategy_runs`, `strategy_signals` | Strategies, deployments and their decisions |
| `connection_equity`, `connection_halts` | Day-start equity and high-water marks; kill-switch halts |
| `backtest_runs`, `watchlist_items`, `price_alerts` | Persisted backtests, the watchlist and its alerts |

Indicators are deliberately not stored: they are computed on demand in
`broker_service/indicators.py`. `backend/src/database/archive/` holds the old
plain-Postgres schemas and a one-off TimescaleDB conversion script, kept for
history only.

---

## Settings and secrets

- **Bootstrap** values come from the environment only: `POSTGRES_*`,
  `SETTINGS_ENCRYPTION_KEY`, ports, and the internal secrets that compose
  reads from the `internal_secrets` volume.
- **Everything else** is registered in `backend/src/config/registry.ts`, with
  its tab, type, default, how a change applies (`immediate`, `reload`,
  `restart`), whether it is secret, and whether loosening it needs step-up
  (trading token and MFA). `configService` reads a key from the environment
  first, then the database, then the default. A new setting goes in the
  registry and is read through `configService`; the Settings page lists it
  automatically.
- Secrets are sealed with AES-256-GCM under `SETTINGS_ENCRYPTION_KEY`
  (`config/secretBox.ts`) and never returned by the API.
- Settings the broker service enforces itself (the live gate, default broker,
  base currency, probe and poll intervals) travel with the connection push.
- `backend/src/services/commissioning.ts` computes the Getting started
  checklist from state; there is no table for it.

---

## Adding a broker

How to add a broker with a direct API so it gets what the others have: a
connection on Settings > Connections, connectivity checks, search, charts,
live prices, orders and a place in the priority.
`broker_service/tests/test_broker_lists.py` fails, naming the file, until
every list below includes the new broker. Run it as you go.

### 1. The adapter (broker service)

Copy `broker_service/templates/api_broker_adapter.py` to
`broker_service/<name>_adapter.py` and fill in each method.
`oanda_adapter.py` is the worked example; every return shape in the template
is the one it returns.

| Method | Used by |
|---|---|
| `probe()` | Background connectivity checks, the Test button, the heartbeat |
| `search_contracts`, `historical_bars`, `realtime_quote`, `tick` | Search, charts, quotes, backtests |
| `stream_prices` (optional) | Live prices; without it `tick` is polled every `STREAM_POLL_SECONDS` |
| `place_order`, `cancel_order`, `modify_order` | Orders and the strategy runner |
| `positions`, `account_summary`, `open_orders`, `executions` | Account pages, reconciliation, `pct_equity` sizing |
| `instrument_spec` | Converting a size into the venue's units |

Rules every adapter keeps:

- **Errors:** `HTTPException` 503 when the venue can't be reached, 502 when
  it answers with an error, 400 for a request it can never serve. Market data
  that names no broker falls back to the next broker on 5xx only
  (`adapters.falls_back`).
- **Symbols:** take and return the app's form (`EUR.USD`, `AAPL`);
  translate inside the adapter.
- **Orders:** call `orders._validate_common` first (the live gate) and send
  `client_ids.client_order_id(...)` so a retry can't double-place. An order
  never moves to another broker.

Tests: copy `tests/test_oanda_adapter.py`, which serves the venue with
`httpx.MockTransport`.

### 2. Register the platform (broker service)

- `connections.py`: add it to `SUPPORTED_PLATFORMS` and `BROKER_PRIORITY`
  (API brokers rank with OANDA, ahead of MT5); require its fields in
  `_validate_platform_fields`, reusing `token`, `account_id`, `api_key`,
  `api_secret`, `url`, `secret`, `environment` where they fit. Do not add a
  single-account `.env` shorthand to `_legacy_connections`.
- `adapters.py`: a branch in `_build_adapters` and a hint in
  `_UNAVAILABLE_HINTS`.
- `tests/test_broker_lists.py`: the class in `ADAPTER_CLASSES`.

`managed.py`, `probes.py` and `venue_streaming.py` need no change.

### 3. Backend

- `src/services/brokers.ts`: the name in `BROKERS`.
- `src/services/orderTypes.ts`: `BROKER_PRIORITY`, same position as in
  `connections.py`.
- `src/services/brokerConnections.ts`: a `PLATFORM_FIELDS` entry.
  `settings` are stored in plain text, `secrets` encrypted, `required`
  checked on save. Names must match the broker service's `Connection` fields;
  derive anything else in `managedEntries` (as OANDA's `environment` is
  derived from the paper/live mode).

### 4. Frontend

In `app/lib/brokerConnections.ts`: `BROKERS_BY_PRIORITY` (same order),
`PLATFORM_FORM` (mirrors `PLATFORM_FIELDS`, with `secret: true` on encrypted
fields), `PLATFORM_NAME` and, for a long name, `PLATFORM_SHORT_NAME`.

### 5. Check

```bash
cd broker_service && ruff check . && black --check . && pytest -q
cd backend && npm run lint && npm run format:check && npx tsc --noEmit && npx jest
cd frontend && npm run lint && npm run format:check && npm run type-check && npx vitest run
```

Then add a paper connection on Settings > Connections and press Test.

---

## The MT5 sidecar

The HTTP contract is documented at the top of
`broker_service/mt5_adapter.py`, and
`broker_service/tests/test_mt5_sidecar_contract.py` runs the adapter against
the sidecar on every CI run. Installing it is
[INSTALL.md § 5.2](INSTALL.md#52-metatrader-5).

What the sidecar guarantees:

- **Shared secret** on every request, `/health` included
  (`X-MT5-Bridge-Secret`). It will not listen on a non-loopback address
  without a secret of at least 24 characters.
- **Stop attached at entry:** one `order_send` with `sl`/`tp`, never an
  entry and then a modify. The response echoes the stop the terminal
  recorded, read back after the fill, so a dropped stop shows as `null` and
  the app treats the entry as unprotected.
- **Stops are never cleared:** `POST /positions/{symbol}/stop` keeps the
  take-profit when `tp` is absent or null, and keeps the stop when `sl` is
  null.
- **Symbols match case-insensitively;** an exact match wins.
- **Volumes are not rounded:** a quantity off the lot step is refused.
- **Paper and live cannot cross:** a paper order to a real-money account, or
  a live order to a demo, is refused; real-money orders also need
  `MT5_ALLOW_REAL=true`.
- **Hedging accounts close, not hedge:** an order against an open position
  closes tickets oldest first; reversing through flat is refused.
  `/positions` reports one net row per symbol, with a stop of 0 if any ticket
  on that side has none.
- **Times are UTC,** converted from the trade server's clock with
  `MT5_SERVER_TZ`.
- **The terminal comes back:** with `MT5_TERMINAL_PATH` set, every request
  checks the terminal and relaunches it; `/health` answers 503 while it is
  offline. Requotes are retried twice at a fresh price.

Tests use `mt5_sidecar/tests/fake_mt5.py`, an in-memory `MetaTrader5`, so they
run on any OS:

```bash
cd mt5_sidecar
pip install -r requirements.txt -r requirements-dev.txt   # MetaTrader5 is skipped off Windows
ruff check . && black --check . && pytest -q
```

---

## Documentation

| File | For |
|---|---|
| [README.md](../README.md) | What the app is, and where to start |
| [INSTALL.md](INSTALL.md) | Installing, in order: database, app, brokers |
| [PROXMOX.md](PROXMOX.md) | The Proxmox guests for the same install |
| [OPERATIONS.md](OPERATIONS.md) | Running, upgrading, going live, troubleshooting |
| [PAPER_TRADING.md](PAPER_TRADING.md) | Taking strategies through paper on two MT5 demo accounts |
| [FEATURES.md](FEATURES.md) | What the app does, and what is planned |
| DEVELOPMENT.md | This file |
| [plans/](plans/) | Design records; dated, not kept current |

When a change alters how something is installed, configured or run, update
the guide that covers it in the same pull request. Where a guide and the
code disagree, the code is right and the guide is the bug.
