# Developing TradingApp

How the code is laid out, how to run it locally, how to test it, how the
database schema evolves, and how to add a broker. Installing and running the
app for real are in [INSTALL.md](INSTALL.md) and
[OPERATIONS.md](OPERATIONS.md).

Procedures here have the same six parts as an install step: **Where**,
**Before**, **Do**, **Expected**, **If it fails** and **Done when**
([INSTALL.md § How each step is written](INSTALL.md#how-each-step-is-written)).
**Where** is a directory of your clone of the repository, on your own
machine. Passwords and keys in this guide are fixed development values for a
database on your own machine; never use them on a server.

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
  OANDA ─ IG ─ cTrader ─ IBKR Web API ─ Alpaca ─ MT5 (sidecar) ─ IB Gateway
```

- **frontend** (`frontend/`): Next.js pages under `app/`, served by
  `server.js`, which also proxies `/api` and `/socket.io` to the backend
  (`backendProxy.js`), so the browser only ever talks to one address.
- **backend** (`backend/`): Express + TypeScript. Owns the database: it waits
  for it, migrates it and checks the encryption key before serving
  (`services/startupGate.ts`). Holds auth, settings, the order path and
  audit, strategy runner, backfill, fills sync, kill switch and alerts. It
  is the only caller of the broker service.
- **broker_service** (`broker_service/`): FastAPI + Python. Has no database.
  One adapter per platform (`ib_adapter.py`, `mt5_adapter.py`,
  `oanda_adapter.py`, `ig_adapter.py`, `ctrader_adapter.py`,
  `ibweb_adapter.py`, `alpaca_adapter.py`) behind the protocols in
  `adapters.py`. Also the indicator maths, the backtester, the rule engine
  and the embedded Jesse port. Every call except `/`, `/health` and
  `/metrics` needs the `X-Broker-Service-Token`.
- **mt5_sidecar** (`mt5_sidecar/`): runs next to an MT5 terminal on Windows
  or Wine and speaks HTTP to `mt5_adapter.py`.
- **Redis**: a read-through cache, the live-tick bus
  (`broker_service/streaming.py` publishes, `backend/src/services/streamingBridge.ts`
  fans out to Socket.IO rooms) and the quote stream the live recorder reads
  (`marketdata:quotes`, written by `add_quote` in `streaming.py`, read by
  `backend/src/services/liveRecorder.ts`). Everything but live charts and
  live recording works without it.

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
| `frontend/app/` | Pages (`settings`, `systematic`, `backtest`, `trade`, `historical`, `download`, `watchlist`, `account`, `live`; `msft` redirects to `live`), `components/`, `lib/` |
| `broker_service/` | `main.py`, `routes/`, adapters, `connections.py` (manifest and priority), `managed.py`, `rule_strategy.py`, `backtesting.py`, `jesse/`, `jesse_strategies/`, `templates/`, `tests/` |
| `mt5_sidecar/` | `server.py`, `terminal.py`, `deploy/` (Task Scheduler and systemd launchers), `tests/` |
| `e2e/` | End-to-end paper run against simulated MT5 terminals |
| `ops/` | Prometheus alert rules, Grafana dashboard |
| `scripts/` | `check_docs.py`: the check of the guides' links and commands, and its tests |
| `docs/` | These guides; `docs/plans/` holds design records |

---

## Run it locally

Four processes, started in this order: a database, the broker service, the
backend, the frontend. Each has its own terminal.

### 1. A database

**Where:** any directory.

**Before:** Docker runs (`docker info` prints no error), and nothing listens
on port 5432 (`ss -ltn | grep -c ':5432 '` prints `0`).

**Do:**

```bash
docker run -d --name tsdb -p 5432:5432 \
  -e POSTGRES_USER=tradingapp -e POSTGRES_PASSWORD=devpassword -e POSTGRES_DB=tradingapp \
  timescale/timescaledb:2.17.2-pg15
```

**Expected:** a container id.

**If it fails:**
- *`port is already allocated`:* another PostgreSQL uses 5432. Stop it, or
  publish another port (`-p 5433:5432`) and use that as `POSTGRES_PORT`
  below.
- *`The container name "/tsdb" is already in use`:* it exists from an
  earlier run. `docker start tsdb`.

**Done when:** `docker exec tsdb pg_isready -U tradingapp` prints
`accepting connections`.

### 2. The broker service (port 8000)

**Where:** `broker_service/`.

**Before:** Python 3.11 (`python --version`), in a virtual environment of
its own.

**Do:**

```bash
pip install -r requirements.txt -r requirements-dev.txt
BROKER_SERVICE_TOKEN=dev-broker-token-0123456789abcdef python main.py
```

**Expected:** the server's log says it is listening on port 8000.

**If it fails:** *`address already in use`:* something else is on port 8000.

**Done when:** `curl -s http://127.0.0.1:8000/health` answers with JSON.

With no `BROKER_SERVICE_TOKEN` it warns and accepts unauthenticated calls.
Brokers come from the backend's push, or for a quick test from a
`BROKER_CONNECTIONS` manifest in its environment (format at the top of
`connections.py`; `e2e/stack.sh` has a working example).

### 3. The backend (port 4000)

**Where:** `backend/`.

**Before:** Node.js 24 LTS (22.12 or later also works; `node --version`),
and steps 1 and 2 are done.

**Do:** it loads `backend/.env` if present:

```bash
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
npm ci
npm run dev
```

**Expected:** the backend creates the schema on first start, then serves.
Outside `NODE_ENV=production`, with no login password and no API token set,
it accepts unauthenticated requests and says so loudly at startup.

**If it fails:**
- *It stays at `waiting_for_database`:* step 1's container is not running,
  or the `POSTGRES_*` lines do not match it.
- *`key_mismatch`:* the database was created with another
  `SETTINGS_ENCRYPTION_KEY`. Use that key, or start again with an empty
  development database: remove the `tsdb` container and do step 1 again.
- *Calls to brokers fail with a name that does not resolve:*
  `BROKER_SERVICE_URL` is missing. Its default is the compose service name,
  which does not resolve outside Docker.

**Done when:** `curl -s http://127.0.0.1:4000/api/health/ready` includes
`"state":"ready"`.

With Redis running locally, drop `REDIS_ENABLED=false` and set `REDIS_HOST`.
Set `API_TOKEN` in `.env` (or choose a password on the first visit) to
exercise auth.

### 4. The frontend (port 3000)

**Where:** `frontend/`.

**Before:** step 3 is done.

**Do:**

```bash
npm ci
npm run dev
```

**Expected:** Next.js reports that it is ready on port 3000.
`BACKEND_INTERNAL_URL` defaults to `http://localhost:4000`.

**If it fails:** *the pages load but every request fails:* the backend is
not on port 4000. Set `BACKEND_INTERNAL_URL` to where it is.

**Done when:** `http://localhost:3000` shows the app.

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
| the guides | | | `python3 scripts/check_docs.py` (from the repository root) |

The last one checks that every link between the guides points at a file and
a heading that exist, and that every `./tradingapp.sh` subcommand a guide
names is one the script takes. Run it after renaming a heading or a
command. `docs/plans/GAP_ANALYSIS.md` is kept for the record and may name
files that have moved.

### Database tests

Backend tests named `*.db.test.ts` need a real database. CI builds the schema
the way the backend does, then runs them.

**Where:** `backend/`.

**Before:** the database from [Run it locally](#1-a-database) is running.
The tests write to it, so use a development database only.

**Do:**

```bash
export DB_TESTS=1 POSTGRES_HOST=localhost POSTGRES_PORT=5432 POSTGRES_USER=tradingapp \
  POSTGRES_PASSWORD=devpassword POSTGRES_DB=tradingapp \
  SETTINGS_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000001
npm run build
node dist/cli/migrate.js
npx jest --runInBand '\.db\.test\.ts$'
```

**Expected:** `migrate` lists the migrations as applied or current, and Jest
ends with every suite passed.

**If it fails:** *the suites are all skipped:* `DB_TESTS=1` is not set in
that shell.

**Done when:** Jest reports no failed and no skipped suite.

### End-to-end paper run

`e2e/run.sh` starts two simulated MT5 terminals behind the real sidecar code
(`e2e/sim_sidecar.py`), the broker service, and the backend with the
strategy runner executing on paper, then runs `e2e/test_paper_flow.py`:
deploying a strategy, orders with stops attached, trailing, fills, limits,
prop rules, the kill switch and restarts. Then `e2e/test_recorder_flow.py`
marks an instrument Record live, adds known quotes to the quote stream, and
reads the bar and the quotes back from the database, across a backend
restart.

**Where:** the repository root.

**Before:**
- `POSTGRES_*` are exported and point at a **development** TimescaleDB (as
  above). The run writes to it.
- Redis answers on `REDIS_HOST`:`REDIS_PORT` (default `127.0.0.1:6379`). To
  start one: `docker run -d --name redis -p 6379:6379 redis:7-alpine`.
- `psql` is installed, the backend is built (`npm run build` in `backend/`),
  and both services' Python requirements are installed in the active Python
  environment (`broker_service/requirements.txt`,
  `broker_service/requirements-dev.txt` and `mt5_sidecar/requirements.txt`).

**Do:**

```bash
e2e/run.sh
```

**Expected:** it takes ten to fifteen minutes and ends with both test files
passed.

**If it fails:**
- *`ModuleNotFoundError: No module named 'fastapi'`, or it times out waiting
  for a sidecar's `/health`:* the Python requirements are not installed in
  the Python that runs it.
- *A test fails:* the output names it, and each component's log is in
  `/tmp/tradingapp-e2e/`. To poke at the stack on its own, `e2e/stack.sh
  start` and `e2e/stack.sh stop` run all of it, and `e2e/stack.sh restart`
  followed by `backend`, `broker`, `calendar`, `sidecar-a` or `sidecar-b`
  restarts one component.

**Done when:** `e2e/run.sh` exits 0.

**CI** (`.github/workflows/ci.yml`) runs on every push and pull request to
`master` (and `main`): a job per component with lint, format, types, tests
and build (the backend job adds the database tests against TimescaleDB), the
end-to-end paper run, a build of the backend and frontend images that checks
they run as a non-root user, the check of the guides, and a dependency audit (`npm audit` on both lockfiles'
production dependencies, `pip-audit` on both Python locks) that fails on a
known high-severity vulnerability.

### Dependencies

Every build installs exactly the versions in a lock file, so what was tested
is what runs.

| Component | You edit | Lock file (generated, committed) | Install |
|---|---|---|---|
| backend, frontend | `package.json` | `package-lock.json` | `npm ci` |
| broker_service | `requirements.in`, `requirements-dev.in` | `requirements.txt`, `requirements-dev.txt` | `pip install -r requirements.txt -r requirements-dev.txt` |
| mt5_sidecar | `requirements.in`, `requirements-dev.in` | `requirements.txt`, `requirements-dev.txt` | the same |

### Change a Node dependency

**Where:** `backend/` or `frontend/`.

**Before:** you know the package and the exact version.

**Do:** with the package and version in place of the example:

```bash
npm install express@5.1.0
npm audit --omit=dev
```

**Expected:** `package.json` and `package-lock.json` both change, and the
audit reports 0 vulnerabilities.

**If it fails:** *the audit reports a high-severity vulnerability:* choose a
version that fixes it. CI fails on one.

**Done when:** that component's lint, type-check and tests pass
([the table above](#tests-lint-and-ci)), and both files are committed
together.

### Change a Python dependency

**Where:** the repository root.

**Before:** [uv](https://docs.astral.sh/uv/) is installed (`uv --version`),
and you have edited the `.in` file.

**Do:** regenerate the locks, broker service first, because the sidecar's
lock is held to the same shared versions (CI's end-to-end job installs both
into one environment):

```bash
cd broker_service
uv pip compile requirements.in --python-version 3.11 --universal -o requirements.txt
uv pip compile requirements-dev.in --python-version 3.11 --universal -o requirements-dev.txt
cd ../mt5_sidecar
uv pip compile requirements.in -c ../broker_service/requirements.txt --python-version 3.11 --universal -o requirements.txt
uv pip compile requirements-dev.in -c ../broker_service/requirements.txt --python-version 3.11 --universal -o requirements-dev.txt
```

**Expected:** the four `.txt` files change only where the edit requires.
With no edit to an `.in` file, they do not change at all.

**If it fails:** *uv cannot resolve the sidecar's lock:* the new version
clashes with one the two services share. Change it in both `.in` files.

**Done when:** `pytest -q` passes in both `broker_service/` and
`mt5_sidecar/`, and the `.in` and `.txt` files are committed together.

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

### Add a migration

**Where:** `backend/src/database/`, then `backend/`.

**Before:** you know the next free number: `ls migrations` shows the last
one used.

**Do:**

1. Create `migrations/NNN_short_name.sql` with the next number (after
   `010_auth_sessions.sql` comes `011_...`).
2. Open with a comment saying what it changes and why.
3. Make it idempotent where you can. Do not add `BEGIN`/`COMMIT`, and do not
   use statements that cannot run in a transaction (`CREATE INDEX
   CONCURRENTLY`).
4. Make the same change in `timescaledb-schema.sql`, so fresh installs get
   it. A fresh database runs the baseline and then the migration, which is
   why the migration must tolerate the change already being there.
5. Apply it locally, in `backend/`, with the `POSTGRES_*` variables of
   [Database tests](#database-tests) exported:

   ```bash
   npm run build && node dist/cli/migrate.js
   ```

   On an installed app, `./tradingapp.sh migrate` (or a restart) applies it,
   and `doctor` shows the state.

**Expected:** `migrate` reports the new file as applied. Run it a second
time: it reports nothing pending.

**If it fails:**
- *The file is ignored:* its name does not match three digits, an
  underscore, then lower-case letters, digits and underscores.
- *It fails on a fresh database but not on yours:* the baseline already made
  the change (item 4) and the migration does not tolerate that. Add
  `IF NOT EXISTS` or a guard.

**Done when:** the database tests pass on a fresh database and on one that
had the previous schema. Never edit a shipped migration; write a new one.

What the schema holds, in short (read the files for the full list):

| Object | Notes |
|---|---|
| `contracts` | One row per resolved instrument |
| `candlestick_data` | OHLCV bars; hypertable, 1-day chunks; no retention policy, only `cleanOldData` deletes, and never from an entry's `history_start` on |
| `candlestick_data.spread` | Ask minus bid at the bar's close, where the broker reports it (OANDA); null otherwise. Prices on the row stay mid prices |
| `candlestick_data.source` | `broker` (the broker's history) or `stream` (built by the live recorder); a broker bar replaces a stream bar, never the reverse |
| `quote_ticks` | Quotes stored by the live recorder (bid, ask, last); hypertable, 1-day chunks, compressed after a day, whole days dropped by `cleanOldData` after `TICK_RETENTION_DAYS` |
| `recorder_cursor` | One row: the last quote-stream entry stored, written in the same transaction as its bars and quotes |
| `tick_data` | Unused. An earlier design's table, left in place; `quote_ticks` replaced it |
| `daily_candlestick_data` | Continuous aggregate, refreshed hourly over the last 3 days |
| `bars_5min`, `bars_15min`, `bars_30min`, `bars_1hour`, `bars_4hour`, `bars_1day` | Bars built from the 1-minute bars: real-time continuous aggregates on UTC boundaries, refreshed for changes of any age. Backtests read them (`backtestData.ts`) |
| `data_collection_config` | The Settings page's collection table, with `history_start` and progress, and `record_live` / `record_ticks` (kept the same on every row of a contract) |
| `data_quality_metrics` | Per-day bar counts and a quality score, written on every store path |
| `broker_connections`, `app_settings`, `settings_audit`, `auth_credentials`, `auth_sessions`, `app_meta` | Connections, settings and their history, login and tokens, the login sessions in force; `app_meta` holds the value that proves the encryption key |
| `order_audit`, `order_executions` | Every order attempt; venue fills, unique on `(broker, broker_account, exec_id)` |
| `strategy_definitions`, `strategy_run_groups`, `strategy_runs`, `strategy_signals` | Strategies, deployments and their decisions |
| `connection_equity`, `connection_halts` | Day-start equity and high-water marks; kill-switch halts |
| `backtest_runs`, `watchlist_items`, `price_alerts` | Persisted backtests (`data` holds the bars a run used: source, count, range, hash, and `built_from` when they were built from 1-minute bars), the watchlist and its alerts |

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
| `stream_fills` or `stream_trade_events` (optional) | Fills as they happen (`fill_streaming.py`): the first reports each fill, the second only that something traded, and the backend then polls that connection at once |
| `bar_basis` (attribute) | `mid`, `bid` or `last`: the price the broker builds its own bars from, so the live recorder builds its bars the same way |
| `timeframes`, `order_tifs`, `spread_bars`, `attaches_stops` (attributes) | What the connection reports it supports (`capabilities.py`), so the app offers only that: the bar timeframes its history serves, each order type with the times in force it accepts, whether its bars carry the spread, and whether a stop rides on the entry. Build the first two from the adapter's own mapping tables so they cannot drift. Without them the standard set is reported |
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
- `src/services/firms.ts`: an entry in `FIRMS` for each firm the broker
  serves (`id`, `name`, `platform`). Every platform needs at least one firm;
  a platform with exactly one gets it filled in automatically. A firm has
  one platform only: its web API if it has one, else MT5.

### 4. Frontend

In `app/lib/brokerConnections.ts`: `BROKERS_BY_PRIORITY` (same order),
`PLATFORM_FORM` (mirrors `PLATFORM_FIELDS`, with `secret: true` on encrypted
fields), `FIRM_PRESETS` (the same ids, names, platforms and order as `FIRMS`,
plus a `note` on how to connect; `backend/tests/firms.test.ts` fails if they
differ), `PLATFORM_NAME` and, for a long name, `PLATFORM_SHORT_NAME`.

### 5. Check

**Where:** the repository root.

**Before:** steps 1 to 4 are done.

**Do:**

```bash
(cd broker_service && ruff check . && black --check . && pytest -q)
(cd backend && npm run lint && npm run format:check && npx tsc --noEmit && npx jest)
(cd frontend && npm run lint && npm run format:check && npm run type-check && npx vitest run)
```

Then, with the app [running locally](#run-it-locally), add a **paper**
connection for the new broker on Settings > Connections and press Test.

**Expected:** all three lines pass, and the Test button reports the
connection as connected.

**If it fails:** *`tests/test_broker_lists.py` fails:* it names the file
whose list does not yet include the new broker.

**Done when:** the three lines pass and a paper connection tests as
connected.

---

## The MT5 sidecar

The HTTP contract is documented at the top of
`broker_service/mt5_adapter.py`, and
`broker_service/tests/test_mt5_sidecar_contract.py` runs the adapter against
the sidecar on every CI run. Installing it is
[INSTALL.md § 4.2](INSTALL.md#42-metatrader-5-vm-120).

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

### Test the sidecar

Tests use `mt5_sidecar/tests/fake_mt5.py`, an in-memory `MetaTrader5`, so
they run on any OS.

**Where:** `mt5_sidecar/`.

**Before:** Python 3.11, in a virtual environment.

**Do:**

```bash
pip install -r requirements.txt -r requirements-dev.txt
ruff check . && black --check . && pytest -q
```

**Expected:** every test passes. Off Windows, `pip` skips the `MetaTrader5`
package; the tests do not need it.

**If it fails:** *`black --check` lists files:* run `black .` and commit the
result.

**Done when:** all three commands exit 0.

---

## Documentation

| File | For |
|---|---|
| [README.md](../README.md) | What the app is, and where to start |
| [INSTALL.md](INSTALL.md) | Installing on Proxmox VE with community scripts, in order: database, app, brokers, proxy, monitoring |
| [OPERATIONS.md](OPERATIONS.md) | Running, upgrading, going live, troubleshooting |
| [PAPER_TRADING.md](PAPER_TRADING.md) | Taking strategies through paper on two MT5 demo accounts |
| [FEATURES.md](FEATURES.md) | What the app does, and what is planned |
| DEVELOPMENT.md | This file |
| [plans/](plans/) | Design records; dated, not kept current |

When a change alters how something is installed, configured or run, update
the guide that covers it in the same pull request. Where a guide and the
code disagree, the code is right and the guide is the bug.
