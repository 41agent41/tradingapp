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

The app is built for Proxmox VE, one server per job, each created with a
[community script](https://community-scripts.org):

| ID | Server | Community script |
|---|---|---|
| CT 100 | Database: PostgreSQL + TimescaleDB | PostgreSQL |
| CT 110 | The app | Docker |
| VM 120 | MetaTrader 5 terminals and sidecars (optional) | Ubuntu VM |
| CT 130 | IB Gateway (optional) | Docker |
| CT 140 | Reverse proxy and TLS | Nginx Proxy Manager |
| CT 150, CT 160 | Prometheus and Grafana (optional) | Prometheus, Grafana |

The database is built first, then the app on top of it:
[docs/INSTALL.md](docs/INSTALL.md) walks through every step. To try the app
on one container with its own database, see its
[Appendix B](docs/INSTALL.md#appendix-b-one-container-for-evaluation).

## Documentation

| Guide | For |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Installing on Proxmox VE, step by step: the database server, the app server, sign-in, brokers (OANDA, MT5, IB, Alpaca), market data, alerts, reverse proxy, firewall, monitoring, backups. Also the installer in detail, and installing without Proxmox. |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Running it: commands, settings, upgrades and rebuilds, going live, monitoring, backups, troubleshooting. |
| [docs/PAPER_TRADING.md](docs/PAPER_TRADING.md) | Taking strategies through paper trading on two MT5 demo accounts, step by step. |
| [docs/FEATURES.md](docs/FEATURES.md) | What the app does, and what is planned. |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Working on the code: architecture, local setup, tests, migrations, adding a broker. |
| [docs/plans/](docs/plans/) | Design records for the larger features. |

## Everyday commands

On the app server, as the `tradingapp` user in `/opt/tradingapp`:

| Command | Does |
|---|---|
| `./tradingapp.sh install` | Commission, upgrade or repair (safe to re-run) |
| `start` / `stop` / `restart` / `status` | Run the stack |
| `logs [follow]` | Recent logs, or follow them |
| `doctor` | Database, schema, key and broker state, and what `.env` holds |
| `backup-key` | Print the encryption key, to store off the host |

`./tradingapp.sh help` lists the rest; [docs/OPERATIONS.md](docs/OPERATIONS.md#commands)
describes each.
