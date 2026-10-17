# TradingApp

A self-hosted trading platform: charts, a market-data store, backtesting and
systematic strategies, with paper and live trading through OANDA, MetaTrader
5, Interactive Brokers and Alpaca. It runs as a Docker stack on one Linux
host.

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
and market data all live there, so the backend does not serve until the
database is reachable, its schema is up to date and the encryption key opens
what it holds. `.env` holds only the database details and that key; brokers,
risk limits, alerts and what data to collect are all set in the app.

## Quick start

On Ubuntu 22.04+ or Debian 12+, as a user with sudo (not root):

```bash
git clone https://github.com/41agent41/tradingapp.git ~/tradingapp
cd ~/tradingapp
./tradingapp.sh install        # Docker, .env, bundled database, the stack
./tradingapp.sh backup-key     # store this key off the host
```

Open `http://<host>:3000`, enter the setup code install printed, choose a
password, and work through **Getting started** on the Settings page. The full
sequence, with an external database and each broker, is in
[docs/INSTALL.md](docs/INSTALL.md).

## Documentation

| Guide | For |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Installing, step by step: host, database, app, sign-in, brokers (OANDA, MT5, IB, Alpaca), market data, alerts, TLS, backups. Also the unattended installer. |
| [docs/PROXMOX.md](docs/PROXMOX.md) | Building the hosts on Proxmox VE: database, app, IB Gateway and MT5 guests, firewall, backups, boot order. |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Running it: commands, settings, upgrades and rebuilds, going live, monitoring, backups, troubleshooting. |
| [docs/PAPER_TRADING.md](docs/PAPER_TRADING.md) | Taking strategies through paper trading on two MT5 demo accounts, step by step. |
| [docs/FEATURES.md](docs/FEATURES.md) | What the app does, and what is planned. |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Working on the code: architecture, local setup, tests, migrations, adding a broker. |
| [docs/plans/](docs/plans/) | Design records for the larger features. |

## Everyday commands

| Command | Does |
|---|---|
| `./tradingapp.sh install` | Commission, upgrade or repair (safe to re-run) |
| `start` / `stop` / `restart` / `status` | Run the stack |
| `logs [follow]` | Recent logs, or follow them |
| `doctor` | Database, schema, key and broker state, and what `.env` holds |
| `backup-key` | Print the encryption key, to store off the host |

`./tradingapp.sh help` lists the rest; [docs/OPERATIONS.md](docs/OPERATIONS.md#commands)
describes each.
