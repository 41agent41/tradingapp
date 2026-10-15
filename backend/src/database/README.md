# TradingApp Database

This directory contains the baseline database schema for TradingApp, the
numbered migrations applied on top of it, and old scripts retained for
historical reference.

> Baseline schema: [`timescaledb-schema.sql`](timescaledb-schema.sql)
> Migrations: [`migrations/`](migrations/)
>
> Everything else (the old `schema.sql`, `init.sql`,
> `migrate-to-timescaledb.sql`, `README_TIMESCALEDB.md`,
> `TIMESCALEDB_SETUP.md`) has been moved into [`archive/`](archive/) and is
> kept only so historical deployments can still find their migration path.

The backend (`backend/src/services/database.ts`,
`backend/src/services/marketDataService.ts`) is wired to **PostgreSQL with
the TimescaleDB extension**. Plain PostgreSQL will mostly work for
development but you will lose hypertables, continuous aggregates and
retention policies.

---

## Table of Contents

1. [Why TimescaleDB](#why-timescaledb)
2. [Deployment Options](#deployment-options)
3. [Migrations](#migrations)
4. [Backend Configuration](#backend-configuration)
5. [Schema Overview](#schema-overview)
6. [Indicators are not persisted (by design)](#indicators-are-not-persisted-by-design)
7. [Operational SQL Snippets](#operational-sql-snippets)
8. [Backups](#backups)
9. [Security Notes](#security-notes)

---

## Why TimescaleDB

TimescaleDB is PostgreSQL plus first-class support for time-series data,
which fits the trading workload:

- **Hypertables** transparently shard the large `candlestick_data` and
  `tick_data` tables by time so range scans stay fast as the dataset grows.
- **Continuous aggregates** maintain rolled-up daily/hourly views without
  rebuilding them on every query.
- **Retention policies** automatically drop chunks older than a configurable
  cutoff (2 years for OHLCV, 30 days for ticks in the shipped schema).
- It remains 100% PostgreSQL on the wire, so `pg` / `psql` / any Postgres
  client just works.

## Deployment Options

`./tradingapp.sh install` uses the bundled TimescaleDB container by default
(`docker-compose.db.yml`, host `172.20.0.20`, data in the `tradingapp_pgdata`
volume). It generates the database password into `.env`. The bundled
container only creates an empty database; the backend builds the schema
when it starts.

For an external database, run `./tradingapp.sh install --external-db`. It
asks for the host and password (or reads them from `--answers FILE`). Any of
the following will work:

| Option | Notes |
|---|---|
| **Timescale Cloud** | https://cloud.timescale.com/ (managed, extension pre-enabled) |
| **AWS RDS / Azure DB / GCP Cloud SQL for Postgres** | Need to enable the `timescaledb` extension where supported |
| **Self-hosted Docker** | `docker run -d --name timescaledb -e POSTGRES_PASSWORD=... -e POSTGRES_DB=tradingapp -p 5432:5432 timescale/timescaledb:latest-pg15` |
| **Apt install on Ubuntu** | [https://www.tigerdata.com/docs/get-started/choose-your-path/install-timescaledb] |

The database only needs to exist, with the `timescaledb` extension available
and a role that owns it. See
[`DEPLOYMENT.md`](../../../DEPLOYMENT.md#external-database).

`--external-db` on a host that already runs the bundled database refuses,
because that would abandon the data. Move the data first (`pg_dump`, then
restore), then run `./tradingapp.sh --no-db install --external-db`.

## Migrations

Nobody runs `psql` against the schema by hand. The backend applies it
(`backend/src/services/migrations.ts`). On every start it waits for the
database (backoff 1s to 30s, no deadline), applies whatever is pending,
checks the encryption key, and only then starts everything else. Until then
`/api/health/ready` and every other API route answer 503 with the reason:
`waiting_for_database`, `migrating`, `migration_failed` or `key_mismatch`.

There are two kinds of file:

- **The baseline**, [`timescaledb-schema.sql`](timescaledb-schema.sql),
  recorded as version `000_baseline`. Every statement in it is idempotent
  (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, guarded `DO $$` blocks). It
  is applied again whenever its content changes (its SHA-256 checksum
  differs from the recorded one). A fresh database is built from it, and an
  older one is carried forward by it. The first time it runs, the backend
  also fills the `daily_candlestick_data` aggregate once.
- **Numbered migrations**, `migrations/NNN_name.sql` (three digits, then
  lower-case letters, digits and underscores). Each is applied once, in
  order, in its own transaction. Changes that are not naturally idempotent
  go here. Files that do not match the pattern are ignored.

Every applied file is recorded in `schema_migrations` (version, name,
checksum, applied_at). The run holds a Postgres advisory lock, so two
processes starting together cannot apply the same file twice. If a file
fails, it is left unrecorded, the backend reports `migration_failed`, and
the next start tries it again.

Editing a numbered migration after it has been applied does nothing on
databases that already ran it. The backend logs a warning and moves on.

`./tradingapp.sh migrate` shows the current state and applies anything
pending without a restart. It runs the same code
(`node dist/cli/migrate.js` in the backend container). `./tradingapp.sh
doctor` also shows the schema state.

### Adding a migration

1. Create `migrations/NNN_short_name.sql` with the next number (after
   `002_connection_limits.sql` comes `003_...`).
2. Start it with a comment that says what it changes and why.
3. Make it idempotent where practical (`CREATE TABLE IF NOT EXISTS`,
   `ADD COLUMN IF NOT EXISTS`). The runner wraps it in its own
   transaction, so do not add `BEGIN`/`COMMIT`, and do not use statements
   that cannot run in a transaction (for example `CREATE INDEX
   CONCURRENTLY`).
4. Make the same change in `timescaledb-schema.sql`, so the baseline stays
   in step for fresh installs. A fresh database runs the baseline first and
   then the migration, which is why the migration must tolerate the change
   already being there.
5. Never edit a migration once it has shipped. Write a new one.
6. Restart the backend or run `./tradingapp.sh migrate`, and check the
   result with `./tradingapp.sh doctor`.

A change that is naturally idempotent (a new table, a new nullable column)
can go only in the baseline. A numbered file is still the clearer record.

### Migrating an existing plain-Postgres deployment

If you previously initialised the database from the archived
`schema.sql` / `init.sql` (no TimescaleDB extension):

1. Take a backup (`pg_dump`).
2. Enable the extension: `CREATE EXTENSION IF NOT EXISTS timescaledb;`
3. Run the archived migration:
   `psql ... -f backend/src/database/archive/migrate-to-timescaledb.sql`

The migration converts the existing tables into hypertables and adds the
retention and aggregate policies. Read the script before running it. It is
preserved for historical context only and is not part of the supported
path.

## Backend Configuration

The backend reads connection details from the `POSTGRES_*` keys in `.env`.
`./tradingapp.sh install` writes them:

```bash
POSTGRES_HOST=172.20.0.20   # bundled database; your host with --external-db
POSTGRES_PORT=5432
POSTGRES_USER=tradingapp
POSTGRES_PASSWORD=<generated>
POSTGRES_DB=tradingapp
POSTGRES_SSL=false          # set true yourself for a remote database
```

The pool is configured in `backend/src/services/database.ts` with up to 20
connections, a 30-second idle timeout and a 2-second connect timeout.

### Encryption key check

Secrets stored in the database are sealed with `SETTINGS_ENCRYPTION_KEY`
from `.env`. A known value sealed with that key is kept in the `app_meta`
table (migration `001_app_meta.sql`). If the key does not match, the backend
stays in `key_mismatch` instead of starting with secrets it cannot read.
Keep the key off the host (`./tradingapp.sh backup-key` prints it). If the
key is lost, `./tradingapp.sh forget-secrets` clears the sealed secrets;
connections and settings stay, and their secrets are entered again.

### Health checks

```bash
curl -fs http://<server-ip>:4000/api/health/ready
curl -fs http://<server-ip>:4000/api/database/health
# => { "status": "healthy", "database": "connected", "timestamp": "..." }
```

A 503 from `/api/health/ready` gives the reason the backend is not ready
yet. Walk through the [Database section in
`TROUBLESHOOTING.md`](../../../TROUBLESHOOTING.md#database) for next steps.

## Schema Overview

The canonical schema ships the following objects:

### Tables

| Table | Purpose | Time-series? |
|---|---|---|
| `contracts` | One row per `(symbol, sec_type, exchange, currency, expiry, strike, right)` tuple resolved by IB | No |
| `candlestick_data` | OHLCV bars, one row per `(contract, timeframe, timestamp)` | **Hypertable**, 1-day chunks |
| `tick_data` | High-frequency tick rows from IB | **Hypertable**, 1-hour chunks |
| `data_collection_sessions` | Audit trail for each data pull from IB | No |
| `data_quality_metrics` | Per-(contract, timeframe, date) counts of total / missing / duplicate / invalid bars | No |
| `data_collection_config` | Per-(contract, timeframe) collection toggles & retention | No |

### Continuous aggregates

- `daily_candlestick_data`, rolled-up daily OHLCV per `(contract, timeframe)`. Refresh policy: every hour over the last 3 days.

### Views

- `latest_candlestick_data`, raw rows joined to contract metadata, ordered by timestamp DESC. Always paginate with `LIMIT`.
- `daily_trading_summary`, `daily_candlestick_data` joined to contract metadata with a daily-change column.

### Retention policies

- `candlestick_data`, drop chunks older than 2 years.
- `tick_data`, drop chunks older than 30 days.

### Triggers

- `update_updated_at_column()` keeps `updated_at` fresh on `contracts`,
  `data_collection_sessions` and `data_collection_config`.

Other tables (broker connections, settings, orders, strategies and more)
are defined further down the baseline and in `migrations/`. Read the files
for the full list.

### Seed data

The schema inserts a handful of common contracts (`MSFT`, `AAPL`, `GOOGL`,
`SPY`, `QQQ`) so you can sanity-check the install with `SELECT * FROM contracts;`.

Which instruments and timeframes are collected is set on Settings >
Schedulers and data, which writes `data_collection_config`. There is no SQL
to run.

## Indicators are not persisted (by design)

The canonical schema **intentionally omits** a `technical_indicators`
table, indicators are computed on demand in `broker_service/indicators.py`
and rendered client-side by `lightweight-charts` rather than stored.

The backend code matches this: `marketDataService.getHistoricalData()`
returns raw OHLCV only, and there is no `technical_indicators` write
path. Requests for indicators (`/api/market-data/indicators`, or
`/api/market-data/history?include_indicators=true`) are served straight
from the broker service, which calculates them.

> Historical note: earlier revisions issued `INSERT INTO
> technical_indicators` / `LEFT JOIN technical_indicators` queries
> inherited from the old plain-Postgres schema, which errored against the
> canonical schema. That persistence path was removed in the §3.2 cleanup
> (see [`GAP_ANALYSIS.md`](../../../docs/plans/GAP_ANALYSIS.md)). The legacy table
> definition still lives in `archive/init.sql` for reference only.

## Operational SQL Snippets

```sql
-- Latest 100 bars for a symbol/timeframe
SELECT *
FROM latest_candlestick_data
WHERE symbol = 'MSFT' AND timeframe = '1hour'
LIMIT 100;

-- Per-symbol storage stats
SELECT
  c.symbol,
  cd.timeframe,
  COUNT(*)              AS bars,
  MIN(cd.timestamp)     AS earliest,
  MAX(cd.timestamp)     AS latest
FROM candlestick_data cd
JOIN contracts c ON c.id = cd.contract_id
GROUP BY c.symbol, cd.timeframe
ORDER BY c.symbol, cd.timeframe;

-- Recent data-collection sessions
SELECT
  c.symbol,
  s.timeframe,
  s.status,
  s.records_collected,
  s.start_time,
  s.end_time
FROM data_collection_sessions s
JOIN contracts c ON c.id = s.contract_id
WHERE s.start_time >= NOW() - INTERVAL '24 hours'
ORDER BY s.start_time DESC;

-- Data-quality scores in the last week
SELECT
  c.symbol,
  q.timeframe,
  q.date,
  q.total_bars,
  q.missing_bars,
  q.data_quality_score
FROM data_quality_metrics q
JOIN contracts c ON c.id = q.contract_id
WHERE q.date >= CURRENT_DATE - INTERVAL '7 days'
ORDER BY q.date DESC, c.symbol;

-- Verify hypertables and policies
SELECT * FROM timescaledb_information.hypertables;
SELECT * FROM timescaledb_information.continuous_aggregates;
SELECT * FROM timescaledb_information.jobs;
```

### Maintenance

```sql
ANALYZE candlestick_data;
VACUUM ANALYZE candlestick_data;
```

The retention policies registered by the schema run automatically, no
cron is required.

## Backups

Backups are your job, whether you use the bundled database or an external
one. Also keep `SETTINGS_ENCRYPTION_KEY` somewhere safe: a restored database
is no use without it. A straightforward host-side cron job:

```bash
#!/usr/bin/env bash
set -euo pipefail
: "${POSTGRES_HOST:?}"; : "${POSTGRES_USER:?}"
: "${POSTGRES_PASSWORD:?}"; : "${POSTGRES_DB:?}"

OUT_DIR=/var/backups/tradingapp
mkdir -p "$OUT_DIR"

PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
  -h "$POSTGRES_HOST" -U "$POSTGRES_USER" "$POSTGRES_DB" \
  | gzip > "$OUT_DIR/tradingapp_$(date +%Y%m%d_%H%M%S).sql.gz"

find "$OUT_DIR" -name 'tradingapp_*.sql.gz' -mtime +14 -delete
```

Managed services (Timescale Cloud, RDS, etc.) provide point-in-time
recovery and continuous backups out of the box, prefer those when
possible.

## Security Notes

1. **Always enable TLS** for any database that is not on this host
   (`POSTGRES_SSL=true` in `.env`; `install` defaults it to `false` and keeps a value you set).
2. **Strong credentials.** `./tradingapp.sh install` generates a random
   password for the bundled database and never replaces an existing one.
3. **Restrict network access**, only the backend container needs
   `5432/tcp` access; nothing else on the LAN should be able to reach the
   database.
4. **Audit logging.** Enable `log_statement = 'ddl'` (or stricter) on the
   database and ship logs to your central log store.

For the broader security posture (bearer-token auth, strict CORS, the
allow-listed `/api/settings`) see
[`FEATURES.md`](../../../FEATURES.md#authentication--cors). Remaining
hardening items (MFA, RBAC, audit logging) are tracked in
[`GAP_ANALYSIS.md`](../../../docs/plans/GAP_ANALYSIS.md).
