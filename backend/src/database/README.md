# TradingApp Database

This directory contains the **single canonical database schema** for
TradingApp and the migration scripts retained for historical reference.

> Canonical schema: [`timescaledb-schema.sql`](timescaledb-schema.sql)
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
3. [Applying the Schema](#applying-the-schema)
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

Any of the following will work. The Docker compose file in this repo does
**not** provision Postgres for you — you must point `POSTGRES_HOST` at an
external instance.

| Option | Notes |
|---|---|
| **Timescale Cloud** | https://cloud.timescale.com/ — managed, extension pre-enabled |
| **AWS RDS / Azure DB / GCP Cloud SQL for Postgres** | Need to enable the `timescaledb` extension where supported |
| **Self-hosted Docker** | `docker run -d --name timescaledb -e POSTGRES_PASSWORD=... -e POSTGRES_DB=tradingapp -p 5432:5432 timescale/timescaledb:latest-pg15` |
| **Apt install on Ubuntu** | https://docs.timescale.com/install/latest/self-hosted/installation-debian/ |

For local / self-hosted dev you can skip the external instance entirely:
`./tradingapp.sh deploy --with-db` layers the `docker-compose.db.yml`
override (shipped at the repo root) that brings up TimescaleDB locally and
applies this schema automatically on first run. See
[`DEPLOYMENT.md`](../../../DEPLOYMENT.md#external-database-recommended-for-production).

## Applying the Schema

```bash
# Create the database (skip if already created)
createdb -h "$POSTGRES_HOST" -U "$POSTGRES_USER" "$POSTGRES_DB"

# Apply the canonical schema
psql "host=$POSTGRES_HOST port=$POSTGRES_PORT user=$POSTGRES_USER \
      dbname=$POSTGRES_DB sslmode=require" \
  -f backend/src/database/timescaledb-schema.sql
```

The script is idempotent — every `CREATE TABLE`, `CREATE INDEX`, hypertable
conversion and policy registration is guarded with `IF NOT EXISTS` /
`DO $$ ... $$` blocks, so you can re-run it safely.

### Migrating an existing plain-Postgres deployment

If you previously initialised the database from the archived
`schema.sql` / `init.sql` (no TimescaleDB extension):

1. Take a backup (`pg_dump`).
2. Enable the extension: `CREATE EXTENSION IF NOT EXISTS timescaledb;`
3. Run the archived migration:
   `psql ... -f backend/src/database/archive/migrate-to-timescaledb.sql`

The migration converts the existing tables into hypertables and adds the
retention/aggregate policies. Read the script before running it — it is
preserved for historical context only and is not part of the supported
path.

## Backend Configuration

The backend reads connection details from the standard `POSTGRES_*`
environment variables (see [`.env.example`](../../../.env.example)):

```bash
POSTGRES_HOST=db.example.com
POSTGRES_PORT=5432
POSTGRES_USER=tradingapp
POSTGRES_PASSWORD=<rotate-me>
POSTGRES_DB=tradingapp
POSTGRES_SSL=true        # set to "false" for unencrypted local dev
```

The pool is configured in `backend/src/services/database.ts` with up to 20
connections, a 30-second idle timeout and a 2-second connect timeout.

### Health checks

```bash
curl -fs http://<server-ip>:4000/api/database/health
# => { "status": "healthy", "database": "connected", "timestamp": "..." }
```

A non-200 response from this endpoint means the backend cannot talk to
Postgres. Walk through the [Database section in
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

- `daily_candlestick_data` — rolled-up daily OHLCV per `(contract, timeframe)`. Refresh policy: every hour over the last 3 days.

### Views

- `latest_candlestick_data` — raw rows joined to contract metadata, ordered by timestamp DESC. Always paginate with `LIMIT`.
- `daily_trading_summary` — `daily_candlestick_data` joined to contract metadata with a daily-change column.

### Retention policies

- `candlestick_data` — drop chunks older than 2 years.
- `tick_data` — drop chunks older than 30 days.

### Triggers

- `update_updated_at_column()` keeps `updated_at` fresh on `contracts`,
  `data_collection_sessions` and `data_collection_config`.

### Seed data

The schema inserts a handful of common contracts (`MSFT`, `AAPL`, `GOOGL`,
`SPY`, `QQQ`) so you can sanity-check the install with `SELECT * FROM contracts;`.

## Indicators are not persisted (by design)

The canonical schema **intentionally omits** a `technical_indicators`
table — indicators are computed on demand in `broker_service/indicators.py`
and rendered client-side by `lightweight-charts` rather than stored.

The backend code matches this: `marketDataService.getHistoricalData()`
returns raw OHLCV only, and there is no `technical_indicators` write
path. Requests for indicators (`/api/market-data/indicators`, or
`/api/market-data/history?include_indicators=true`) are served straight
from the IB service, which calculates them.

> Historical note: earlier revisions issued `INSERT INTO
> technical_indicators` / `LEFT JOIN technical_indicators` queries
> inherited from the old plain-Postgres schema, which errored against the
> canonical schema. That persistence path was removed in the §3.2 cleanup
> (see [`GAP_ANALYSIS.md`](../../../GAP_ANALYSIS.md)). The legacy table
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

The retention policies registered by the schema run automatically — no
cron is required.

## Backups

The backend treats Postgres as an externally-managed dependency, so
backups are the responsibility of whatever Postgres you point at. A
straightforward host-side cron job:

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
recovery and continuous backups out of the box — prefer those when
possible.

## Security Notes

1. **Always enable TLS** for any database that is not on `localhost`. Set
   `POSTGRES_SSL=true` in `.env`.
2. **Strong, rotated credentials.** Do not reuse the `tradingapp123`
   password from `tradingapp.sh setup` — that value exists purely for
   bootstrapping a local Docker dev DB.
3. **Restrict network access** — only the backend container needs
   `5432/tcp` access; nothing else on the LAN should be able to reach the
   database.
4. **Audit logging.** Enable `log_statement = 'ddl'` (or stricter) on the
   database and ship logs to your central log store.

For the broader security posture (bearer-token auth, strict CORS, the
allow-listed `/api/settings`) see
[`FEATURES.md`](../../../FEATURES.md#authentication--cors). Remaining
hardening items (MFA, RBAC, audit logging) are tracked in
[`GAP_ANALYSIS.md`](../../../GAP_ANALYSIS.md).
