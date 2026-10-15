# TradingApp Deployment Guide

How to put TradingApp on a server, keep it up to date and run it. One
command commissions a host: `./tradingapp.sh install`. Everything after that
is done in the app, on the Settings page.

Other guides:

- Building the hosts on Proxmox (LXC containers, a database container, the IB
  Gateway and MT5 hosts): [PROXMOX_DEPLOYMENT.md](PROXMOX_DEPLOYMENT.md).
- Installing unattended as root from an answers file:
  [AGENT_INSTALL_RUNBOOK.md](AGENT_INSTALL_RUNBOOK.md) and
  [`install/install.sh`](install/install.sh).
- When something goes wrong: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Install

What the host needs:

- Ubuntu 22.04+ or Debian 12+ (the script uses `apt`).
- 4 GB of memory (the frontend build needs it) and 15 GB of free disk.
- Ports 3000 (frontend) and 4000 (backend). The broker service (8000) is
  published on loopback only.

The script installs Docker and the compose plugin if they are missing.

<a id="user-account-do-not-install-as-root"></a>

### 1. Prepare the host

`./tradingapp.sh` refuses to run as root and calls `sudo` itself when it needs
to. Fresh containers and VPS images often log you in as root, so create a
normal user first.

1. As root, create the user:

   ```bash
   apt update && apt install -y sudo git curl
   adduser tradingapp
   usermod -aG sudo tradingapp
   su - tradingapp
   ```

2. As that user, clone into its home directory (not `/root`, which no other
   user can read):

   ```bash
   cd ~
   git clone https://github.com/41agent41/tradingapp.git
   cd tradingapp
   ```

   To use `/opt/tradingapp` instead, run
   `sudo mkdir -p /opt/tradingapp && sudo chown tradingapp: /opt/tradingapp`
   first. `tradingapp.sh` is already executable.

### 2. Run install

```bash
./tradingapp.sh install
```

It does the following:

1. Checks for curl and openssl, and installs Docker and the compose plugin if
   needed. If it just added you to the `docker` group, it re-runs itself
   under `sg docker`, so you do not need to log out.
2. Writes `.env` with seven keys: the database connection and
   `SETTINGS_ENCRYPTION_KEY`. With the bundled database (the default) it
   generates the database password and points at `172.20.0.20`. It never
   replaces an existing password or key.
3. Builds and starts the stack, then waits until the backend reports ready
   (up to 900 seconds; set `INSTALL_TIMEOUT` to change it). It stops early if
   the backend reports `migration_failed` or `key_mismatch`, and prints why.
4. Checks the frontend, backend, broker service and readiness. It does not
   test brokers. The app does that, and a broker that is down never fails a
   deploy.
5. Prints the URL and, if no login password is set yet, the setup code.

The backend creates and updates the database schema itself. There is no SQL
to run.

Flags:

| Flag | Effect |
|---|---|
| `--external-db` | Use your own PostgreSQL + TimescaleDB. Asks for the host and password. See [External database](#external-database). |
| `--answers FILE` | Take answers from `KEY=VALUE` lines. Database keys and `SETTINGS_ENCRYPTION_KEY` go to `.env`; other keys are stored as app settings. Broker keys are refused (exit 2). |
| `--non-interactive` | Never prompt. |
| `--env-only` | Write `.env` and stop. |

Save the encryption key off the host now:

```bash
./tradingapp.sh backup-key
```

Any rebuild that keeps the database needs this key.

### 3. Sign in with the setup code

1. Open the URL that install printed (`http://<server-ip>:3000`).
2. The first visit asks for the setup code. If you lost it, run
   `./tradingapp.sh setup-code`.
3. Choose the login password.

If the page instead says the backend is waiting for the database, migrating,
or reports a key mismatch, see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md#backend-says-waiting-for-the-database-migration-failed-or-key-mismatch).

### 4. Work through the Settings checklist

The Settings page has a "Getting started" checklist. It is worked out from
the app's state and shows what is left:

1. **Login password.** Done at first sign-in.
2. **Order MFA and a trading token.** On Settings > Security. Placing orders
   and changing protected settings need them.
3. **A broker connection.** Add one under Settings > Connections. See
   [Adding brokers](#adding-brokers).
4. **Instruments to collect.** Choose them on Settings > Schedulers and data,
   and turn the backfill scheduler on there. See
   [Data collection](#data-collection).
5. **Alerts.** Telegram bot token and chat id, and a heartbeat URL, on
   Settings > Alerts and safety.

Before the systematic engine places orders, also set the account limits and
`TRADING_DAY_TIMEZONE` (Settings > Risk) and leave the kill switch on
`notify`. [PAPER_DEPLOYMENT_RUNBOOK.md](PAPER_DEPLOYMENT_RUNBOOK.md) walks
through this on paper.

<a id="alpaca-and-oanda--optional-cloud-brokers"></a>

## Adding brokers

Brokers are added in the app, under Settings > Connections. Do not put them
in `.env` or in an answers file. Each connection is tested when you save it,
and the app keeps checking it every `BROKER_PROBE_INTERVAL_SECONDS` (on
Settings > Schedulers and data; 0 pauses it). Secrets are stored encrypted under
`SETTINGS_ENCRYPTION_KEY`. Add several accounts per broker if you need them,
each marked paper or live.

A request that names no broker goes to the highest-priority one: OANDA, then
MT5, then IB, then Alpaca. Change the order on the Connections tab, or pin one
with `DEFAULT_BROKER` (Settings > Trading). A broker with no connection
answers `501`.

Per-connection risk limits and prop-firm rules are on each connection's own
form. Precedence, highest first: a `.env` per-connection line
(`CONNECTION_MAX_*__<CONN>`, `PROP_RULES__<CONN>`), then the connection's own
values, then the fleet-wide cap on Settings > Risk.

What each broker needs before you add it:

- **OANDA** (FX and CFDs): an API token and account id. Paper connections use
  OANDA's practice environment.
- **Alpaca** (US equities and options): an API key and secret. Paper
  connections use Alpaca's paper endpoint.
- **Interactive Brokers**: IB Gateway or TWS running and logged in. In
  `File > Global Configuration > API > Settings`, enable "ActiveX and Socket
  Clients", set the socket port (4002 paper, 4001 live), add the app host's IP
  to Trusted IPs, and untick "Read-Only API" if you will place orders. Then
  add the connection with the gateway's address and port.
- **MetaTrader 5**: a sidecar host running the MT5 terminal and the sidecar in
  [`mt5_sidecar/`](mt5_sidecar/README.md) (Windows, or Linux under Wine). One
  sidecar serves one terminal. When you add the connection, enter the sidecar
  URL (for example `http://10.7.3.22:9100`) and a random secret of at least 24
  characters. Put the same secret in `MT5_BRIDGE_SECRET` in the sidecar's
  `sidecar.env`. The sidecar refuses requests without it and will not listen
  on a non-loopback address without one.

Alpaca and OANDA are cloud APIs that the broker service calls over HTTPS. IB
and MT5 hold a logged-in session on a separate host.

To add a new broker type, see
[`broker_service/ADDING_A_BROKER.md`](broker_service/ADDING_A_BROKER.md).

<a id="multi-broker-host-topology-ib--mt5"></a>

### Host layout with IB and MT5

IB and MT5 each need a host of their own (or one shared Windows host under
separate OS users) holding a logged-in session, one account per IB Gateway or
MT5 sidecar. The broker service reaches IB over its socket API and MT5 over
HTTP with the shared secret.

- Only the app host should accept connections from users. The IB Gateway and
  MT5 hosts should accept connections only from the app host, on a private
  network or VPN.
- Each broker is one session on one host with no standby. If it logs out,
  that venue stops until someone logs it back in. The connection checks show
  this; set up alerts so you hear about it.

Open items are tracked in
[GAP_ANALYSIS.md](docs/plans/GAP_ANALYSIS.md#8-operational--deployment-gaps).

Break-glass: the broker service still reads broker lines in `.env`
(`IB_HOST`, `MT5_BRIDGE_URL`, `ALPACA_API_KEY`, `OANDA_API_TOKEN`,
`BROKER_CONNECTIONS`; see `broker_service/connections.py`). A broker defined
there replaces the app's connections for that broker, and the page shows it as
overridden. Use this only when the app cannot be reached.

## Rebuild or upgrade

### Upgrade in place

```bash
cd ~/tradingapp
git pull
./tradingapp.sh install
```

Migrations apply themselves. Re-running install is also how you repair a host.
On a host set up by an older version, install removes `.env` lines nothing
reads any more (after a backup to `.env.bak.<timestamp>`) and reports any
broker lines it kept.

### Rebuild on a new host, keeping an external database

1. Prepare the host and clone, as in [Install](#install).
2. Create `.env` with the external database details and the saved
   `SETTINGS_ENCRYPTION_KEY`. Or put the same keys in an answers file and pass
   `--answers FILE`.
3. Run `./tradingapp.sh install --external-db`.

The backend adopts the existing schema, applies only pending migrations and
checks the key. It comes up already configured: no setup screen, and the
brokers are already there. With the wrong key it stops in `key_mismatch`
instead of starting with secrets it cannot read.

### Rebuild with the bundled database

The bundled database lives in a Docker volume on that host
(`tradingapp_pgdata`, which Docker names `tradingapp_tradingapp_pgdata`).
`./tradingapp.sh clean` and `redeploy` keep it. Only
`./tradingapp.sh clean --include-database`, after you type DELETE, removes it.
To move to a new host, take a `pg_dump` first (see
[Database backups](#database-backups)).

### Lost encryption key

Run `./tradingapp.sh forget-secrets` and type FORGET. It clears the secrets
sealed with the lost key. Connections and settings stay; enter their secrets
again on the Settings page.

## What lives where

| Where | What |
|---|---|
| `.env` (7 keys) | `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_SSL`, `SETTINGS_ENCRYPTION_KEY`. Written by install. Mode 600. |
| `.env` (optional) | `FRONTEND_PORT`, `BACKEND_PORT`, `BROKER_SERVICE_PORT`, and `APP_PASSWORD` as the way back in when the password is forgotten. Any Settings-page key can also be pinned here. |
| Settings tabs | Trading, Risk, Alerts and safety, Strategies, Schedulers and data, Security, Network, History. Stored in the database. |
| Settings > Connections | Broker connections, their priority, per-connection limits and prop-firm rules. |
| `internal_secrets` volume | The broker service token and Redis password. Generated on first start by the one-shot `secrets` service, mounted read-only at `/run/tradingapp`. Replace with `./tradingapp.sh rotate-internal-secrets`. |

How settings work:

- A key set in `.env` wins. The page shows it as locked. To manage it from the
  page, run `./tradingapp.sh settings-import`, which moves such lines into the
  app (after a backup), or delete the line and run `./tradingapp.sh deploy`.
- `.env` is also a ceiling for live trading: `LIVE_TRADING_ENABLED=false`
  there keeps live off whatever the page says.
- Each setting shows when a change applies. Most apply immediately or on the
  next cycle of the loop they drive, without a restart.
- Protected settings need the trading token and MFA code, when those are
  configured.
- Every change is recorded on the History tab (`settings_audit`).
- A `BROKER_SERVICE_TOKEN` or `REDIS_PASSWORD` still in `.env` wins over the
  volume, so an old install keeps working until install tidies it.

Settings you are most likely to look for:

| Tab | Keys |
|---|---|
| Trading | `LIVE_TRADING_ENABLED`, `SYSTEMATIC_ENABLED`, `SYSTEMATIC_EXECUTION_ENABLED`, `DEFAULT_BROKER` |
| Risk | `ORDER_MAX_QUANTITY`, `ORDER_MAX_PRICE`, `ORDER_MAX_POSITION`, `CONNECTION_MAX_DAILY_EQUITY_LOSS`, `CONNECTION_MAX_DRAWDOWN`, `PORTFOLIO_MAX_DAILY_LOSS`, `TRADING_DAY_TIMEZONE` |
| Alerts and safety | `KILL_SWITCH_ACTION` (`notify`, `halt` or `flatten`), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `HEARTBEAT_URL`, `HEARTBEAT_FAIL_URL` |
| Strategies | `PROMOTION_*` gate thresholds |
| Schedulers and data | Strategy runner timing, `BROKER_PROBE_INTERVAL_SECONDS`, `BACKFILL_*`, `EXECUTIONS_SYNC_*`, `REDIS_ENABLED`, `STREAMING_ENABLED`, `NEWS_CALENDAR_*`, and the data collection table |
| Security | Login password, API tokens, trading tokens, order MFA, `SESSION_TTL_HOURS`, `COOKIE_SECURE` |
| Network | `CORS_ORIGINS`, `TRUST_PROXY` |

The page lists every key it reads, with its help text.

## Command reference

Run from the checkout as the deploy user: `./tradingapp.sh COMMAND`.

| Command | What it does |
|---|---|
| `install` | Docker, `.env`, database and stack in one step. Safe to re-run. |
| `deploy` | Build and start, then wait until ready. |
| `redeploy` | Rebuild images from scratch, then deploy. The database is kept. |
| `start`, `stop`, `restart`, `status` | Compose lifecycle. |
| `logs [follow]` | Recent logs, or follow them. |
| `setup-code` | The code the first-run screen asks for. |
| `doctor` | Database, schema, key and broker state, and what `.env` holds. |
| `test` | Check the services answer. |
| `migrate` | Show the schema state and apply anything pending, without a restart. |
| `settings-import` | Move Settings-page keys from `.env` into the app. |
| `backup-key` | Print `SETTINGS_ENCRYPTION_KEY`, to store off the host. |
| `rotate-internal-secrets` | Replace the broker service token and Redis password. |
| `forget-secrets` | Clear secrets sealed with a lost encryption key (type FORGET). |
| `fix` | Stop, then deploy and check again. |
| `clean [--include-database]` | Remove containers and images. Volumes are kept unless `--include-database` is given and you type DELETE. |

Old names still work: `setup` runs `install`, `config` and `env` run
`install --env-only`, and `diagnose` runs `doctor`.

<a id="external-database-recommended-for-production"></a>

## External database

The default is the bundled TimescaleDB container on the app host. To use your
own PostgreSQL 14+ with TimescaleDB instead (managed, or on another host):

1. Create a database and a user that owns it.
2. Run `./tradingapp.sh install --external-db`. It asks for the host and
   password, or reads them from `.env` or `--answers`. Set `POSTGRES_SSL=true`
   if the server requires TLS.

The backend applies the schema on first start and migrates it on later ones.
It waits for the database however long it takes, so the database can come up
after the app.

On a host that already runs the bundled database, `--external-db` refuses,
because that would abandon the data. To switch:

1. Copy the data across (`pg_dump`, then restore on the new server).
2. Run `./tradingapp.sh --no-db install --external-db`.

## Reverse proxy, TLS and firewall

### nginx and certbot

1. Install them:

   ```bash
   sudo apt install -y nginx certbot python3-certbot-nginx
   ```

2. Create `/etc/nginx/sites-available/tradingapp`. Everything goes to the
   frontend on port 3000, which forwards `/api` and `/socket.io` to the
   backend:

   ```nginx
   map $http_upgrade $connection_upgrade {
       default upgrade;
       ''      close;
   }

   server {
       listen 80;
       server_name your-domain.com;

       location / {
           proxy_pass http://localhost:3000;
           proxy_http_version 1.1;
           proxy_set_header Host              $host;
           proxy_set_header X-Real-IP         $remote_addr;
           proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_set_header Upgrade           $http_upgrade;
           proxy_set_header Connection        $connection_upgrade;
           proxy_read_timeout 3600s;
       }
   }
   ```

3. Enable it, then let certbot add TLS and the HTTP-to-HTTPS redirect:

   ```bash
   sudo ln -s /etc/nginx/sites-available/tradingapp /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d your-domain.com --redirect
   ```

4. On Settings > Network:
   - Set `CORS_ORIGINS` to the public origin, for example
     `https://your-domain.com`. Empty or `*` accepts any origin. The app's own
     pages go through the frontend and do not need this.
   - Set `TRUST_PROXY` to the address nginx reaches the frontend from (the
     Docker network gateway, usually `172.20.0.1`). Login lockout and the
     settings history then record the visitor's address instead of nginx's.
     The frontend container is always trusted.

Both apply immediately.

### Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

Without a reverse proxy, allow 3000 instead (and 4000 only if scripts call the
backend directly). Never expose the broker service (8000). It can place
orders, so the stack publishes it on loopback only.

The containers use `restart: unless-stopped`, so they come back after a
reboot. After `./tradingapp.sh stop`, start them with `./tradingapp.sh start`,
not a bare `docker compose up`, which leaves out the bundled database.

<a id="authentication--cors"></a>

## Sign-in and API tokens

- The browser signs in with the login password and holds an HttpOnly session
  cookie. Sessions last `SESSION_TTL_HOURS` (default 12). Five wrong
  passwords from one address lock it out for 15 minutes.
- Scripts send `Authorization: Bearer <token>` with an API token from
  Settings > Security. Health checks, `/metrics` and `/api/auth/*` need none.
- Only the backend may call the broker service, with the internal token.
- The page and API share one address, so the app works on any name or IP that
  reaches port 3000.

Locked out? Set `APP_PASSWORD` (or `ORDER_MFA_SECRET`, if the authenticator is
lost) in `.env` and run `./tradingapp.sh deploy`, which recreates the backend
with it (`restart` does not re-read `.env`). The `.env` value wins, so you can
sign in, set a new one on the Security tab, then remove the line.

## Enabling live trading

Live orders are off by default. The backend and the broker service both
reject any `account_mode=live` order with 403 until you turn it on. Paper
orders always work.

1. In Settings > Security, create a trading token (copy it, it is shown
   once), and set up MFA by scanning the QR code and entering a code.
2. Add the account as a live connection under Settings > Connections. A live
   order to a paper connection is refused.
3. In Settings > Trading, enter the trading token and a current MFA code, set
   Live trading to true, and type LIVE when asked. The page refuses without
   both safeguards. The change goes to the settings history and to Telegram.
4. Check the gate is open:

   ```bash
   curl -s -H "Authorization: Bearer $API_TOKEN" http://<host>:3000/api/orders/config | jq
   ```

   `live_trading_enabled` must be `true`. If `backend_live_enabled` and
   `ib_live_enabled` disagree, the broker service has not picked up the change
   yet (it does within 15 seconds). Do not send a live order until they match.

A strategy goes live only after the promotion gate sees a paper run of the
same definition (`GET /api/strategies/definitions/:id/promotion`).

Safety rails:

- Turning live off, or tightening a limit, needs only the login. Turning a
  switch on or raising a limit also needs the trading token and MFA code.
- `LIVE_TRADING_ENABLED=false` in `.env` keeps live off whatever the page
  says. Removing the trading token or MFA secret also closes the gate.
- `ORDER_MAX_QUANTITY` (default 100k) and `ORDER_MAX_PRICE` (default 1M) on
  Settings > Risk apply to every order.
- Every order attempt is stored in `order_audit`, visible in the `/trade`
  blotter and at `GET /api/orders/audit`.
- With `SYSTEMATIC_EXECUTION_ENABLED` on and no heartbeat URL, the backend
  logs a startup warning: nothing would page you if the host went down.

<a id="data-collection--retention-phase-5"></a>

## Data collection

Which instruments and timeframes are fetched and stored, how often, and how
long they are kept, is a table on Settings > Schedulers and data. It writes
`data_collection_config`. There is no SQL to run.

1. Add an entry per instrument and timeframe: choose the broker, enter the
   symbol, then the timeframe, the collection interval and the retention in
   days. Removing an entry stops collection; stored bars stay.
2. Turn on the backfill scheduler (`BACKFILL_ENABLED`, same tab). It is off by
   default because it makes broker requests on a timer. It starts without a
   restart.

Each pass fetches every enabled row whose newest bar is older than its
interval, and upserts the bars, so gaps inside the window fill themselves.
`BACKFILL_INTERVAL_MINUTES` sets how often it runs and `BACKFILL_PERIOD` how
far back each fetch reaches.

Retention:

- TimescaleDB policies in the schema drop `candlestick_data` chunks older
  than 2 years and `tick_data` older than 30 days.
- `POST /api/market-data/database/clean` deletes bars older than each row's
  retention. Run it from cron with an API token for tighter limits.

Check it:

```bash
curl -fs http://<server-ip>:4000/api/health | jq .services.backfill
curl -fs -H "Authorization: Bearer $API_TOKEN" \
  http://<server-ip>:4000/api/market-data/database/stats | jq
```

## Executions (fills) sync

Without the sync, positions and P&L are estimated from submitted orders. That
is wrong on partial fills, late rejections and trades placed outside the app.
The sync records the venue's own fills instead.

Turn on Fills sync (`EXECUTIONS_SYNC_ENABLED`) on Settings > Schedulers and
data if a strategy uses `risk.max_daily_loss` (with the sync off, that cap
fails closed and the run places nothing), or if you want
`/api/account/executions` and `/api/account/pnl` to report anything. It starts
without a restart.

- It polls only venues the app has traded at recently or has a running
  strategy on. The window overlaps on purpose, so late fills are picked up;
  rows upsert on `(broker, exec_id)`, so nothing is duplicated.
- A position is the recorded fills plus the unfilled part of working orders.
  A strategy run sees only the exposure it created. `ORDER_MAX_POSITION` caps
  the whole account, so manual trades count toward it.
- IB reports times in the Gateway's timezone, which the broker service reads
  as `IB_TIMEZONE` (default UTC). Run the Gateway in UTC.

Check it:

```bash
curl -fs http://<server-ip>:4000/api/health | jq .services.executions
curl -fs -H "Authorization: Bearer $API_TOKEN" \
  "http://<server-ip>:4000/api/account/reconciliation?broker=ib" | jq
```

The reconciliation lists every symbol either side knows about with a
`matched` flag. On an account you also trade by hand, alert on
`.mismatches > 0`.

## Monitoring and maintenance

### Health and logs

```bash
./tradingapp.sh status
./tradingapp.sh test
./tradingapp.sh doctor
./tradingapp.sh logs follow
curl -fs http://<server-ip>:4000/api/health/ready
```

`/api/health/ready` answers 200 when the database is reachable, migrated and
opened by the key, and 503 with the reason otherwise. The backend's Docker
health check uses it. Brokers and Redis do not count, so an outage there never
marks the backend down.

`/api/health` also reports the cache, streaming, backfill, fills sync and
heartbeat. Redis is a cache and the live-tick bus: if it is down, endpoints
still work and charts fall back to one-off REST calls. Both can be turned off
on Settings > Schedulers and data (`REDIS_ENABLED`, `STREAMING_ENABLED`).

### Prometheus and Grafana

The backend and the broker service expose `GET /metrics` in Prometheus
format; the backend's needs no token. [`ops/grafana/README.md`](ops/grafana/README.md)
has the scrape config and the metrics list. Load the rules in
[`ops/prometheus/alerts.yml`](ops/prometheus/alerts.yml) (targets down, error
rate, latency, event-loop lag, and per-connection rules such as breaker open,
unprotected position and position divergence) and import
[`ops/grafana/tradingapp-dashboard.json`](ops/grafana/tradingapp-dashboard.json).
Check rule edits with `promtool check rules ops/prometheus/alerts.yml`.

Prometheus runs on your own infrastructure, so it does not replace Telegram
alerts and the heartbeat: something off the host must notice when everything
stops.

<a id="database-backups"></a>

### Database backups

Keep the encryption key with the backups, but not on the same host:
`./tradingapp.sh backup-key`. A dump without its key restores everything
except the stored secrets.

For the bundled database:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd ~/tradingapp
BACKUP_DIR=/var/backups/tradingapp
mkdir -p "$BACKUP_DIR"
docker compose -f docker-compose.yml -f docker-compose.db.yml exec -T postgres \
  pg_dump -U tradingapp tradingapp > "$BACKUP_DIR/tradingapp_$(date +%Y%m%d_%H%M%S).sql"
find "$BACKUP_DIR" -name 'tradingapp_*.sql' -mtime +7 -delete
```

For an external database, use its own backups or run `pg_dump` against
`POSTGRES_HOST` from another machine.

<a id="common-issues"></a>

## Common issues

| Symptom | First step |
|---|---|
| Page says waiting for the database, migration failed or key mismatch | `./tradingapp.sh doctor`. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md#backend-says-waiting-for-the-database-migration-failed-or-key-mismatch). |
| Install stops with "Don't run this script as root" | Create a sudo user and clone as that user. See [Prepare the host](#1-prepare-the-host). |
| Port clash on start | `sudo ss -ltnp \| grep -E ':(3000\|4000\|8000)'` and free the port, or set `FRONTEND_PORT` / `BACKEND_PORT` in `.env`. |
| A broker shows down | Use its Test button on Settings > Connections. The error says whether the address, credentials or session is wrong. |
| Broker requests return 501 | No connection for that broker yet. Add one on Settings > Connections. |
| Backend logs `refusing to start: ...` | See [TROUBLESHOOTING.md](TROUBLESHOOTING.md#backend-refuses-to-start). |
| Forgot the password | Set `APP_PASSWORD` in `.env` and `./tradingapp.sh deploy`. See [Sign-in and API tokens](#sign-in-and-api-tokens). |

More in [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
