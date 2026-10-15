# TradingApp

A self-hosted trading platform: charts, a market-data store, backtesting and
systematic strategies, with paper and live trading through OANDA, MetaTrader
5, Interactive Brokers and Alpaca. It runs as a Docker stack on one host.

```
                      ┌──────────────────────────┐
  browser ──────────► │ frontend (Next.js)       │
                      └────────────┬─────────────┘
                                   │ /api
                      ┌────────────▼─────────────┐      ┌───────────────────────┐
                      │ backend (Express)        │◄────►│ PostgreSQL+TimescaleDB│
                      │ waits for its database,  │      │ settings, connections,│
                      │ migrates it, checks key  │      │ bars, orders, audit   │
                      └──────┬──────────────┬────┘      └───────────────────────┘
                             │              │
                   ┌─────────▼──────┐  ┌────▼────┐
                   │ broker_service │  │  Redis  │  live ticks
                   │ (FastAPI)      │──►         │
                   └─────────┬──────┘  └─────────┘
                             │  in priority order
              OANDA ─ MT5 (sidecar) ─ IB Gateway ─ Alpaca
```

The database is the first dependency. Settings, logins, broker connections
and market data all live there, so the backend does not start serving until
the database is reachable, its schema is up to date and the encryption key
opens what it holds. Until then the page says what it is waiting for.

## Requirements

- Ubuntu 22.04+ or Debian 12+ (a VM, a Proxmox LXC or bare metal), 4 GB of
  memory and 15 GB of free disk.
- A user with sudo rights. The script refuses to run as root.
- A database. By default `install` runs TimescaleDB as a container on the
  same host. To use one you already have (PostgreSQL with the timescaledb
  extension), see [DEPLOYMENT.md](DEPLOYMENT.md).

Docker is installed for you if it is missing.

## Commission a new install

1. **Prepare the host** (as root, once). Skip this if you already have a sudo
   user.
   ```bash
   apt update && apt install -y sudo git curl
   adduser tradingapp && usermod -aG sudo tradingapp
   su - tradingapp
   ```
2. **Install** (as that user):
   ```bash
   git clone https://github.com/41agent41/tradingapp.git ~/tradingapp
   cd ~/tradingapp
   ./tradingapp.sh install
   ```
   It installs Docker if needed and writes `.env`, which holds the database
   details and an encryption key. It then builds and starts the stack, waits
   until the backend has migrated the database, and prints the address and a
   setup code. To use an existing database, run
   `./tradingapp.sh install --external-db`, which asks for its host and
   password.
3. **Save the encryption key** somewhere off this host:
   `./tradingapp.sh backup-key`. You need it to rebuild against the same
   database.
4. **Sign in.** Open `http://<host>:3000`. The first visit asks for the setup
   code (`./tradingapp.sh setup-code` shows it again), then for the login
   password you want.
5. **Work through Getting started** at the top of the Settings page. It
   ticks each step off as it is done:
   - order MFA and a trading token (Security);
   - a broker connection (Connections): OANDA, MT5, IB or Alpaca, tested when
     you save it;
   - the instruments and timeframes to collect, with the backfill scheduler
     on (Schedulers and data);
   - Telegram alerts and the heartbeat URL (Alerts and safety).

The app starts in paper mode. Turning live trading on is a deliberate step,
described in [DEPLOYMENT.md](DEPLOYMENT.md).

## Rebuild or upgrade

- **Upgrade in place:** `git pull && ./tradingapp.sh install`. Re-running
  `install` is always safe. It adds only what is missing and never replaces
  the database password or the encryption key. The backend applies any new
  migrations when it starts.
- **Rebuild on a new host, keeping the database:** clone, then run
  `./tradingapp.sh install --external-db`. It asks for the database's host
  and password and for the encryption key you saved (unattended: put them in
  an answers file). The app comes up already configured, with no setup
  screen and the brokers already there. With the wrong key it stops and says
  so, instead of starting with secrets it cannot read.
- **Bundled database:** its data is in a Docker volume on that host.
  `./tradingapp.sh clean` keeps it; only `clean --include-database` (after
  you type DELETE) removes it.

## What lives where

| Where | What |
|---|---|
| `.env` | `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_SSL`, `SETTINGS_ENCRYPTION_KEY`. Nothing else is needed. |
| Docker volume `internal_secrets` | The broker service token and the Redis password, generated on first start (`rotate-internal-secrets` replaces them). |
| Settings > Connections | Brokers and accounts, their credentials (encrypted), per-account risk limits and prop-firm rules. |
| Settings > other tabs | Trading, Risk, Alerts and safety, Strategies, Schedulers and data (including what data to collect), Security, Network (browser origins, trusted proxies). Every change is audited (History). |

Any setting can still be pinned in `.env` by its key. The Settings page then
shows it as locked, and `./tradingapp.sh settings-import` moves such lines
into the app. Setting `APP_PASSWORD` in `.env` is the way back in if the
login password is lost.

## Everyday commands

| Command | Does |
|---|---|
| `./tradingapp.sh install` | Commission, upgrade or repair (safe to re-run) |
| `start` / `stop` / `restart` / `status` | Run the stack |
| `logs [follow]` | Recent logs, or follow them |
| `doctor` | Database, schema, key and broker state, and what `.env` holds |
| `migrate` | Bring the database schema up to date now |
| `backup-key` | Print the encryption key, to store off the host |
| `setup-code` | The code the first-run screen asks for |
| `redeploy` | Rebuild the images from scratch (the database is kept) |

`./tradingapp.sh help` lists the rest.

## Troubleshooting

- **The page says it is waiting for the database.** Check the database is
  running and that `POSTGRES_*` in `.env` point at it. `./tradingapp.sh doctor`
  shows what the backend sees.
- **"Encryption key does not match".** `.env` has a different
  `SETTINGS_ENCRYPTION_KEY` from the one the database was set up with. Put
  the saved key back. If it is lost, `./tradingapp.sh forget-secrets` clears
  the stored secrets so they can be entered again.
- **A broker shows as down.** Settings > Connections shows the last check and
  its error. Fix it there; a broker that is down never stops the app.
- Everything else: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Documentation

- [DEPLOYMENT.md](DEPLOYMENT.md): external database, nginx and TLS, live
  trading, backups, reference.
- [PROXMOX_DEPLOYMENT.md](PROXMOX_DEPLOYMENT.md): building the host, database,
  IB Gateway and MT5 containers on Proxmox.
- [AGENT_INSTALL_RUNBOOK.md](AGENT_INSTALL_RUNBOOK.md): unattended install
  with `install/install.sh` and an answers file.
- [PAPER_DEPLOYMENT_RUNBOOK.md](PAPER_DEPLOYMENT_RUNBOOK.md): taking a
  strategy through paper trading.
- [FEATURES.md](FEATURES.md): what the app does, in detail.
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
- [broker_service/ADDING_A_BROKER.md](broker_service/ADDING_A_BROKER.md) and
  [mt5_sidecar/README.md](mt5_sidecar/README.md).
- [backend/src/database/README.md](backend/src/database/README.md): the
  schema and how migrations work.
- [docs/plans/](docs/plans/): design and planning documents.

## Development

```bash
cd backend && npm install && npm run dev         # API on :4000
cd frontend && npm install && npm run dev        # UI on :3000
cd broker_service && pip install -r requirements.txt && python main.py
```

The backend needs a database: `POSTGRES_*` and `SETTINGS_ENCRYPTION_KEY` in
its environment, pointing at any PostgreSQL with TimescaleDB. It migrates the
database on start.

Tests: `npm test` in `backend` (set `DB_TESTS=1` with a database for the
database-backed ones), `npx vitest run` in `frontend`, `pytest` in
`broker_service`. [DEVELOPMENT_ITERATION_GUIDANCE.md](DEVELOPMENT_ITERATION_GUIDANCE.md)
covers the workflow.
