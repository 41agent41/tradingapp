# Database — Archived Files

The files in this directory are **not** part of the supported deployment
path. They are kept only so historical deployments can still find the
migration steps they need.

The canonical schema lives one directory up:

- [`../timescaledb-schema.sql`](../timescaledb-schema.sql)
- [`../README.md`](../README.md)

## What is here

| File | Why it was archived |
|---|---|
| `schema.sql` | Original plain-PostgreSQL schema (no hypertables). Superseded by `timescaledb-schema.sql`. |
| `init.sql` | An expanded variant of `schema.sql` that also created the `technical_indicators` table and seed data. Superseded for the same reason. |
| `migrate-to-timescaledb.sql` | One-shot migration from `schema.sql` / `init.sql` into the TimescaleDB layout. Useful only if you have an old plain-Postgres deployment to upgrade. |
| `README_TIMESCALEDB.md` | Old design notes that were folded into the new top-level `README.md`. |
| `TIMESCALEDB_SETUP.md` | Old verbose setup guide that was folded into the new top-level `README.md`. |

## When you might still need these

- **Upgrading from a plain-Postgres deployment** to TimescaleDB:
  1. Back up your existing database.
  2. Enable the TimescaleDB extension:
     `CREATE EXTENSION IF NOT EXISTS timescaledb;`
  3. Run `migrate-to-timescaledb.sql`.
  4. Re-run the canonical `../timescaledb-schema.sql` to ensure any newer
     objects (continuous aggregates, retention policies) are present.

- **Working around the known `technical_indicators` schema/code mismatch**
  described in `../README.md` — applying `init.sql` after the canonical
  schema will create the legacy `technical_indicators` table so the
  backend's `MarketDataService` insert/join queries don't fail. This is a
  temporary workaround pending the code refactor tracked in
  [`GAP_ANALYSIS.md`](../../../../GAP_ANALYSIS.md).

Otherwise, ignore these files. New deployments should only apply
`../timescaledb-schema.sql`.
