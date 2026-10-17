# Running TradingApp

How to run an installed TradingApp: the management commands, where settings
live, upgrades and rebuilds, going live, data collection, monitoring,
backups and troubleshooting. Installing is in [INSTALL.md](INSTALL.md).

Every command here runs on the app server, as the deploy user, in the
checkout: `./tradingapp.sh COMMAND`. On a server built with
[INSTALL.md](INSTALL.md), that is the `tradingapp` user in `/opt/tradingapp`:
in CT 110's Console, `su - tradingapp`, then `cd /opt/tradingapp`.

## Contents

1. [Commands](#commands)
2. [Where things live](#where-things-live)
3. [Sign-in and API tokens](#sign-in-and-api-tokens)
4. [Upgrade, rebuild and move](#upgrade-rebuild-and-move)
5. [Going live](#going-live)
6. [Data collection and retention](#data-collection-and-retention)
7. [Executions (fills) sync](#executions-fills-sync)
8. [Monitoring](#monitoring)
9. [Backups and restore](#backups-and-restore)
10. [Troubleshooting](#troubleshooting)

---

## Commands

| Command | What it does |
|---|---|
| `install` | Docker, `.env`, database and stack in one step. Safe to re-run: it is also how you upgrade and repair. |
| `deploy` | Build and start, then wait until ready. |
| `redeploy` | Rebuild the images from scratch, then deploy. The database is kept. |
| `start`, `stop`, `status` | Start, stop, list the containers. |
| `restart` | Recreate the containers, so a change to `.env` takes effect. |
| `logs [follow]` | Recent logs of every service, or follow them. |
| `setup-code` | The code the first-run screen asks for. |
| `doctor` | Docker, `.env`, containers, the database, schema and key as the backend sees them, and broker state. |
| `test` | Check the frontend, backend, broker service and readiness answer. |
| `migrate` | Show the schema state and apply anything pending, without a restart. |
| `settings-import` | Move Settings-page keys from `.env` into the app. |
| `backup-key` | Print `SETTINGS_ENCRYPTION_KEY`, to store off the host. |
| `rotate-internal-secrets` | Replace the broker service token and the Redis password. |
| `forget-secrets` | Clear the secrets sealed with a lost encryption key (type FORGET). |
| `fix` | Stop, deploy and check again. |
| `clean [--include-database]` | Remove containers, images and build cache. Volumes are kept unless `--include-database` is given and you type DELETE. |

Old names still work: `setup` runs `install`, `config` and `env` run
`install --env-only`, `diagnose` runs `doctor`.

Always go through the script rather than a bare `docker compose`: the script
adds `docker-compose.db.yml` when the host runs the bundled database
(`.tradingapp.with-db` marks it), and a bare `docker compose up` would start
the stack without its database. Per-service commands such as
`docker compose logs backend` are fine.

---

## Where things live

| Where | What |
|---|---|
| `.env` (7 keys, mode 600) | `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_SSL`, `SETTINGS_ENCRYPTION_KEY`. Written by `install`. |
| `.env` (optional) | `FRONTEND_PORT`, `BACKEND_PORT`, `BROKER_SERVICE_PORT`; `APP_PASSWORD` or `ORDER_MFA_SECRET` as the way back in; any Settings-page key pinned. |
| `internal_secrets` volume | The broker service token and Redis password, generated on first start, mounted read-only at `/run/tradingapp`. |
| `tradingapp_pgdata` volume | The bundled database's data (Docker names it `tradingapp_tradingapp_pgdata`). |
| Settings > Connections | Broker accounts, their priority, credentials (encrypted), per-account limits and prop-firm rules. |
| Settings > other tabs | Trading, Risk, Alerts and safety, Strategies, Schedulers and data (with the data collection table), Security, Network, History. Stored in the database. |

How settings behave:

- **`.env` wins.** A key set in `.env` overrides the page, which shows it as
  locked. `./tradingapp.sh settings-import` moves such lines into the app
  (after a backup) and restarts the backend. `install` removes lines nothing
  reads any more, and reports broker lines it keeps.
- **`.env` is a ceiling for live trading:** `LIVE_TRADING_ENABLED=false`
  there keeps live off whatever the page says.
- **Each setting says when a change applies:** at once, on the next cycle of
  the loop it drives, or after a restart.
- **The safer direction is easy.** Turning a switch off or tightening a
  limit needs only the login. Turning one on or raising a cap also needs the
  trading token and an MFA code.
- **Every change is audited** on the History tab.
- **Broker lines in `.env`** (`BROKER_CONNECTIONS`, `IB_HOST`,
  `MT5_BRIDGE_URL`, `OANDA_API_TOKEN`, `ALPACA_API_KEY` and the rest) still
  define connections, and for that broker replace the ones added in the app,
  which then show as overridden. Use them only as a break-glass, or for the
  symbol map gap in [INSTALL.md § 4.6](INSTALL.md#46-not-yet-on-the-form-symbol-maps-and-account-info-from).

Settings you are most likely to look for (the page lists every key with its
help text):

| Tab | Keys |
|---|---|
| Trading | `LIVE_TRADING_ENABLED`, `SYSTEMATIC_ENABLED`, `SYSTEMATIC_EXECUTION_ENABLED`, `DEFAULT_BROKER` |
| Risk | `ORDER_MAX_QUANTITY`, `ORDER_MAX_PRICE`, `ORDER_MAX_POSITION`, `CONNECTION_MAX_*`, `PORTFOLIO_MAX_DAILY_LOSS`, `PORTFOLIO_BASE_CURRENCY`, `TRADING_DAY_TIMEZONE` |
| Alerts and safety | `KILL_SWITCH_ACTION` (`notify`, `halt`, `flatten`), `KILL_SWITCH_EQUITY_FLOOR`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `HEARTBEAT_URL`, `HEARTBEAT_FAIL_URL` |
| Strategies | `PROMOTION_*` gate thresholds, `PROMOTION_PAPER_GATE` |
| Schedulers and data | Strategy runner timing, `BROKER_PROBE_INTERVAL_SECONDS`, `BACKFILL_*`, `EXECUTIONS_SYNC_*`, `REDIS_ENABLED`, `STREAMING_ENABLED`, `NEWS_CALENDAR_*`, the data collection table |
| Security | Login password, API tokens, trading tokens, order MFA, `SESSION_TTL_HOURS`, `COOKIE_SECURE` |
| Network | `CORS_ORIGINS`, `TRUST_PROXY` |
| Connections | Broker priority, `IB_TIMEZONE` |

Per-connection limits: a `CONNECTION_MAX_*__<CONNECTION>` or
`PROP_RULES__<CONNECTION>` line in `.env` wins, then the connection's own
value, then the fleet-wide cap on Settings > Risk.

---

## Sign-in and API tokens

- The browser signs in with the login password and holds an HttpOnly session
  cookie for `SESSION_TTL_HOURS` (default 12). Five wrong passwords from one
  address lock it out for 15 minutes.
- Scripts send `Authorization: Bearer <token>` with an API token from
  Settings > Security. Health checks, `/metrics` and `/api/auth/*` need none.
- Only the backend may call the broker service, with the internal token.
- The page and API share one address, so the app works on any name or IP that
  reaches port 3000.

**Locked out?** Set `APP_PASSWORD` (or `ORDER_MFA_SECRET`, if the
authenticator is lost) in `.env` and run `./tradingapp.sh restart`. The
`.env` value wins, so you can sign in, set a new one on the Security tab, then
remove the line and restart again.

---

## Upgrade, rebuild and move

### Upgrade in place

Snapshot the app and database containers first
([INSTALL.md § 10.3](INSTALL.md#103-before-an-upgrade)). Then, as root in
CT 110:

```bash
bash /root/install.sh repo env deploy verify
```

On a host installed by hand instead: `git pull`, then `./tradingapp.sh install`.

Migrations apply themselves when the backend starts. On a host set up by an
older version, `install` also removes `.env` lines nothing reads any more
(after a backup to `.env.bak.<timestamp>`).

### Rebuild on a new host, keeping an external database

Build the new app server as in [INSTALL.md step 2](INSTALL.md#2-app-server-ct-110),
with the saved key added to the answers as `SETTINGS_ENCRYPTION_KEY`
([INSTALL.md § A.4](INSTALL.md#a4-rebuilding-the-app-server)). On a host
installed by hand: `./tradingapp.sh install --external-db`, with the same
values in `--answers FILE` or typed when asked.

The backend adopts the existing schema, applies only pending migrations and
checks the key. It comes up configured: no setup screen, and the brokers are
already there. With the wrong key it stops in `key_mismatch` instead of
starting with secrets it cannot read.

### The bundled database

Its data is in a Docker volume on the app host. `clean` and `redeploy` keep
it. Only `./tradingapp.sh clean --include-database`, after you type DELETE,
removes it. To move to a new host, take a dump first and restore it there.

### Move from the bundled to an external database

`install --external-db` refuses on a host that runs the bundled database,
because it would leave the data behind. Move the data first:

1. Build the database server ([INSTALL.md step 1](INSTALL.md#1-database-server-ct-100)).
2. On the app host, stop the backend and dump the bundled database:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.db.yml stop backend
   docker compose -f docker-compose.yml -f docker-compose.db.yml exec -T postgres \
     pg_dump -U tradingapp -Fc tradingapp > /tmp/tradingapp.dump
   ```

3. Copy the dump to the database server and restore it:

   ```bash
   runuser -u postgres -- psql -d tradingapp -c 'SELECT timescaledb_pre_restore();'
   runuser -u postgres -- pg_restore -d tradingapp --no-owner --role=tradingapp /tmp/tradingapp.dump
   runuser -u postgres -- psql -d tradingapp -c 'SELECT timescaledb_post_restore();'
   ```

   An error that the `timescaledb` extension already exists is expected.
4. Switch over. `--no-db` stops using the bundled database; the key in
   `.env` stays, so the restored secrets still open:

   ```bash
   ./tradingapp.sh --no-db install --external-db
   ```

5. Once the app is healthy, remove the old volume
   (`docker volume ls | grep pgdata`, then `docker volume rm <name>`).

### Lost encryption key

If the saved key cannot be found, run `./tradingapp.sh forget-secrets` and
type FORGET. It clears every secret sealed with the old key: broker
credentials, secret settings, the MFA secret and the session key. Connections
and settings stay. Sign in and enter their secrets again (Connections, Alerts
and safety, Security). Never generate a new key on a database that already
holds secrets; `install` never replaces an existing key for that reason.

### Internal secrets

`./tradingapp.sh rotate-internal-secrets` replaces the broker service token
and Redis password and recreates the services that use them. A
`BROKER_SERVICE_TOKEN` or `REDIS_PASSWORD` line left in `.env` by an old
install wins over the volume until `install` removes it.

---

## Going live

Live orders are off by default. The backend and the broker service both
refuse any `account_mode=live` order with 403 until you turn it on; paper
orders always work. Take a strategy through
[PAPER_TRADING.md](PAPER_TRADING.md) first.

1. On Settings > Security, make sure order MFA is enrolled and a trading
   token exists.
2. Add the account as a **live** connection on Settings > Connections. A
   live order to a paper connection is refused. For IB that is the live port
   (4001); for MT5 the sidecar also needs `MT5_ALLOW_REAL=true`.
3. On Settings > Trading, enter the trading token and a current MFA code,
   set Live trading on, and type LIVE when asked. The change goes to the
   settings history and to Telegram.
4. Check the gate:

   ```bash
   curl -s -H "Authorization: Bearer $API_TOKEN" http://<host>:3000/api/orders/config | jq
   ```

   `live_trading_enabled` must be `true`. If `backend_live_enabled` and
   `ib_live_enabled` disagree, the broker service has not picked the change
   up yet (it does within 15 seconds). Do not send a live order until they
   match.

A strategy runs live only after the promotion gate has seen a paper run of
the same definition (`GET /api/strategies/definitions/:id/promotion` says
what is missing).

Safety rails:

- `LIVE_TRADING_ENABLED=false` in `.env` keeps live off whatever the page
  says. Removing the trading token or the MFA secret also closes the gate.
- `ORDER_MAX_QUANTITY` (default 100,000) and `ORDER_MAX_PRICE` (default
  1,000,000) on Settings > Risk apply to every order.
- Every order attempt is stored in `order_audit`, shown in the `/trade`
  blotter and at `GET /api/orders/audit`.
- With `SYSTEMATIC_EXECUTION_ENABLED` on and no heartbeat URL, the backend
  logs a startup warning: nothing would page you if the host went down.

---

## Data collection and retention

Which instruments and timeframes are stored, how often and for how long is
the data collection table on Settings > Schedulers and data
(`data_collection_config`; API `/api/market-data/collection`). Setting it up
is [INSTALL.md step 5](INSTALL.md#5-market-data).

- Each backfill pass (`BACKFILL_INTERVAL_MINUTES`) fetches every enabled
  entry whose newest bar is older than its interval, over the recent
  `BACKFILL_PERIOD`, and upserts the bars, so gaps inside the window fill
  themselves. Removing an entry stops collection; stored bars stay.
- With **History from** set, each pass also walks back towards that date in
  chunks of about 20,000 bars, up to five per entry per pass. OANDA and Alpaca
  requests are paged past their per-request limits; MT5 answers a date range
  in one request. The History column shows progress.
- TimescaleDB drops `candlestick_data` chunks older than 2 years and
  `tick_data` older than 30 days. `POST /api/market-data/database/clean`
  deletes bars older than each entry's retention (run it from cron with an
  API token for tighter limits); bars from an entry's history start on are
  kept.

Check it:

```bash
curl -fs http://<host>:4000/api/health | jq .services.backfill
curl -fs -H "Authorization: Bearer $API_TOKEN" http://<host>:4000/api/market-data/database/stats | jq
```

---

## Executions (fills) sync

Without the sync, positions and P&L are estimated from submitted orders,
which is wrong on partial fills, late rejections and trades placed outside
the app. With Fills sync (`EXECUTIONS_SYNC_ENABLED`, Settings > Schedulers and
data) on, the backend records each venue's own fills. Turn it on if a
strategy uses `risk.max_daily_loss` (with the sync off that cap fails closed
and the run places nothing), or if you want `/api/account/executions` and
`/api/account/pnl`.

- It polls only venues the app has traded at recently or has a running
  strategy on. The window overlaps on purpose so late fills are picked up;
  rows upsert on `(broker, broker_account, exec_id)`.
- A position is the recorded fills plus the unfilled part of working orders.
  `ORDER_MAX_POSITION` caps the whole account, so manual trades count.
- IB reports times in the Gateway's zone (`IB_TIMEZONE`, default UTC). Run
  the Gateway in UTC.

Check it:

```bash
curl -fs http://<host>:4000/api/health | jq .services.executions
curl -fs -H "Authorization: Bearer $API_TOKEN" \
  "http://<host>:4000/api/account/reconciliation?broker=ib" | jq
```

The reconciliation lists every symbol either side knows with a `matched`
flag. On an account you also trade by hand, alert on `.mismatches > 0`.

---

## Monitoring

### Health

```bash
./tradingapp.sh status
./tradingapp.sh test
./tradingapp.sh doctor
curl -fs http://<host>:4000/api/health/ready
curl -fs http://<host>:4000/api/health | jq
```

`/api/health/ready` answers 200 when the database is reachable, migrated and
opened by the key, and 503 with the reason otherwise. The backend's Docker
health check uses it. Brokers and Redis do not count, so an outage there
never marks the backend down. `/api/health` also reports the cache,
streaming, backfill, fills sync and heartbeat.

Redis is a cache and the live-tick bus. If it is down, endpoints still work
and charts fall back to one-off REST calls. Both can be switched off on
Settings > Schedulers and data (`REDIS_ENABLED`, `STREAMING_ENABLED`).

### Prometheus and Grafana

The backend serves Prometheus metrics at `GET /metrics` on port 4000, with
no token. The broker service has its own `/metrics`, but it is published on
the app host's loopback only, so an outside Prometheus cannot reach it
without a proxy of your own.

```yaml
# prometheus.yml
rule_files:
  - /etc/prometheus/alerts.yml
scrape_configs:
  - job_name: tradingapp-backend
    metrics_path: /metrics
    static_configs: [{ targets: ['<app-host>:4000'] }]
```

- **Alert rules:** copy [`ops/prometheus/alerts.yml`](../ops/prometheus/alerts.yml)
  to `/etc/prometheus/alerts.yml` and check it with
  `promtool check rules /etc/prometheus/alerts.yml`. It covers targets down,
  error rate, latency and event-loop lag, and per connection (the
  `tradingapp-fleet` group) an open circuit breaker, unprotected positions,
  position divergence, stop gaps, orders blocked by caps and connections with
  no active runs.
- **Dashboard:** in Grafana, **Dashboards → New → Import**
  [`ops/grafana/tradingapp-dashboard.json`](../ops/grafana/tradingapp-dashboard.json)
  and pick your Prometheus data source for `DS_PROMETHEUS`. It shows request
  rate, p95 latency and error rate per service, backtest runs persisted, and
  process memory, CPU and event-loop lag.

| Metric | From |
|---|---|
| `http_request_duration_seconds` (histogram, and its `_count`) | backend (`backend/src/services/metrics.ts`) and broker service |
| `backtest_runs_persisted_total` | backend (`backend/src/routes/backtesting.ts`) |
| `process_*`, `nodejs_*` | backend (`prom-client` defaults) |
| `http_requests_total` | broker service (`prometheus_fastapi_instrumentator`) |

Prometheus runs on your own infrastructure, so it does not replace Telegram
alerts and the heartbeat: something off the host must notice when everything
stops.

---

## Backups and restore

Keep the encryption key with the backups, but not on the same host:
`./tradingapp.sh backup-key`. A dump restores everything; without its key,
everything except the stored secrets.

Taking dumps on the database server is
[INSTALL.md § 1.5](INSTALL.md#15-nightly-dumps). For the bundled database,
the same `pg_dump -Fc` runs through `docker compose -f docker-compose.yml -f
docker-compose.db.yml exec -T postgres pg_dump -U tradingapp -Fc tradingapp`
on the app server. Managed databases have their own point-in-time recovery;
prefer it.

Restore a `-Fc` dump into a database where the `timescaledb` extension exists,
with the backend stopped:

```bash
runuser -u postgres -- psql -d tradingapp -c 'SELECT timescaledb_pre_restore();'
runuser -u postgres -- pg_restore -d tradingapp -c --no-owner --role=tradingapp <file>.dump
runuser -u postgres -- psql -d tradingapp -c 'SELECT timescaledb_post_restore();'
```

For the bundled database, run the same through
`docker compose -f docker-compose.yml -f docker-compose.db.yml exec -T postgres`
as user `tradingapp`. Then start the app with the key that database was
sealed with. Test a restore at least once.

---

## Troubleshooting

### First response

```bash
./tradingapp.sh status          # containers and ports
./tradingapp.sh test            # do the services answer?
./tradingapp.sh doctor          # Docker, .env, database, schema, key, brokers
./tradingapp.sh logs            # recent lines per service
./tradingapp.sh fix             # stop, deploy and check again
```

`./tradingapp.sh install` is safe to re-run and repairs most host problems.

### The page says it is waiting for the database, or a key mismatch

The backend does nothing else until its database is reachable, migrated and
opened by the encryption key. Until then `/api/health/ready` and every other
API route answer 503 with the state, and the page shows it.

| State | Meaning | What to do |
|---|---|---|
| `waiting_for_database` | The backend cannot reach PostgreSQL. It retries every 1 to 30 seconds with no deadline, so it recovers once the database is up. | Bundled: `./tradingapp.sh status` and `logs`. External: check `POSTGRES_*` in `.env` (host, port, password, `POSTGRES_SSL`), and from the app host `nc -vz <db-host> 5432`; then `listen_addresses`, `pg_hba.conf` and the firewall. |
| `migrating` | The schema is being created or updated. | Wait. A first install or a large migration can take minutes. |
| `migration_failed` | A migration failed; the detail carries the database error. It does not retry by itself. | Usually permissions: the role must own the database, and the `timescaledb` extension must exist. Fix it, then `./tradingapp.sh migrate`, which applies what is pending and restarts the backend if it had stopped on the failure. |
| `key_mismatch` | `SETTINGS_ENCRYPTION_KEY` in `.env` does not open this database's secrets. | Put the saved key back in `.env` and `./tradingapp.sh restart`. If it is lost: [Lost encryption key](#lost-encryption-key). |

`install` waits up to 900 seconds; on a slow host,
`INSTALL_TIMEOUT=1800 ./tradingapp.sh install`.

### Backend refuses to start

The backend log has `refusing to start: ...` lines
(`docker compose logs backend | grep -E 'refusing to start|\[startup\]'`).
Each names the key:

- **`... is still a template or default value`** or **`is shorter than N
  characters`**: a secret pinned in `.env` is weak. Remove the line to manage
  it in the app, or set a fresh value (`openssl rand -hex 32`).
- **`BROKER_SERVICE_TOKEN ...`**: an old `.env` line; `./tradingapp.sh
  install` removes it, or `rotate-internal-secrets` makes a new one.
- **`POSTGRES_PASSWORD is empty or a known default`**: change it in the
  database and in `.env` together.
- **`KILL_SWITCH_ACTION`**, **`TRADING_DAY_TIMEZONE`**, **`PROP_RULES__<CONNECTION>`**,
  **`HEARTBEAT_URL`**: an invalid value, usually pinned in `.env`. Fix or
  remove it; the Settings page checks these when you save.

`refusing to start: unsafe schema for multi-connection` does not stop the
process: the strategy runner and fills poller stay off. Run
`./tradingapp.sh migrate`, then `restart`. `[startup]` lines without
"refusing" are warnings worth acting on, such as auto-execution with no
heartbeat URL.

### Install and host

| Symptom | Fix |
|---|---|
| "Don't run this script as root" | `tradingapp.sh` runs as the deploy user: `su - tradingapp`, or `runuser -u tradingapp -- ./tradingapp.sh ...`. As root, use `install/install.sh` ([INSTALL.md step 2](INSTALL.md#23-run-the-installer)). |
| "docker group membership is not active" | The script re-runs itself under `sg docker`. If it still says so: `newgrp docker` (or log out and in), then re-run. |
| "Docker is installed but not running" | `sudo systemctl start docker` |
| Port already in use | `sudo ss -ltnp \| grep -E ':(3000\|4000\|8000)'`; free it, or set `FRONTEND_PORT` / `BACKEND_PORT` / `BROKER_SERVICE_PORT` in `.env` and `./tradingapp.sh deploy`. |
| Build fails | `docker system prune -f`, then `./tradingapp.sh redeploy`. Under 4 GB of memory the frontend build fails. |
| Permission denied on files | `sudo chown -R "$USER":"$USER" .` and `chmod 600 .env` |
| `.env` lost or damaged | Restore it from a backup, or run `./tradingapp.sh install --env-only`, put the original `POSTGRES_PASSWORD` and `SETTINGS_ENCRYPTION_KEY` back, then `install`. |

Never run `docker compose down -v` to "fix" volumes: it deletes the bundled
database and the internal secrets. `./tradingapp.sh clean` keeps them.

### Proxmox containers

| Symptom | Cause and fix |
|---|---|
| Docker fails to start, or containerd exits at once | Keyctl is off. CT > **Options** > **Features**: tick **keyctl** and **nesting**, then restart the container. |
| Docker starts but every `run` fails with an overlay or mount error, or `docker info` shows storage driver `vfs` | Nesting is off, or the storage cannot carry `overlay2`. Tick **nesting** (and **FUSE**) under **Options** > **Features**, `apt install fuse-overlayfs`, put `{ "storage-driver": "fuse-overlayfs" }` in `/etc/docker/daemon.json`, then `rm -rf /var/lib/docker` and `systemctl restart docker`. That discards the images; `bash /root/install.sh deploy` rebuilds them. |
| Docker warns about `/dev/kmsg` | Harmless in a container. |
| Docker works only in a privileged container | Don't keep that. Go back to unprivileged and turn on the feature that was missing (nesting, keyctl or FUSE). |
| `free -h` in a container shows the host's total memory | Restart the container. |
| A process is killed well below the host's free memory | Container memory is a hard limit. Raise it under **Resources** > **Memory**. |
| Time is wrong in a container | Fix the host's clock; containers cannot set their own. |
| The installer warns the clock is not NTP-synchronised | In a container that is the host's job; check the host's time synchronisation. |
| Firewall rules have no effect on a guest | Its network device lacks the **Firewall** tick ([INSTALL.md § 8.2](INSTALL.md#82-turn-the-firewall-on-for-each-guests-network)). |
| Everything unreachable after turning on the datacenter firewall | From the physical console: `pve-firewall stop`, fix the rules at **Datacenter** > **Firewall**, then start it again. |
| Snapshots fail | The storage cannot snapshot (plain directory storage). Move the disk to LVM-thin or ZFS, or rely on the backup job. |
| Host storage full, containers stuck | Usually old snapshots or backups on local storage. Delete them, then restart the containers. |
| Routes to part of the LAN vanish on CT 110 only | That part of the LAN overlaps the app's Docker network, `172.20.0.0/16` ([INSTALL.md § Plan the addresses](INSTALL.md#plan-the-addresses)). |
| `waiting_for_database` on CT 110 | From CT 110: `nc -vz <db-address> 5432`; then the database's `pg_hba.conf` line, the password in `.env`, and CT 100's firewall rule ([INSTALL.md step 1](INSTALL.md#1-database-server-ct-100)). |
| IB Gateway connection down | In CT 130: `docker compose logs` in `/opt/ib-gateway`. A login IB refuses, or a second factor it asks for, shows there. |

### Sign-in

| Symptom | Fix |
|---|---|
| The login page asks for a setup code | No password is set yet. `./tradingapp.sh setup-code`. |
| Forgot the password or lost the authenticator | [Sign-in and API tokens](#sign-in-and-api-tokens). |
| Scripts get 401 | Missing or wrong API token. If `NEXT_PUBLIC_API_TOKEN` is still in `.env`, remove it and rotate any token that held that value: it was readable in the page. |
| CORS error | Only pages on another site calling the API need this: list their exact origins in `CORS_ORIGINS` (Settings > Network). |
| Logs show the proxy's address, not the visitor's | Set `TRUST_PROXY` (Settings > Network) to the proxy's address ([INSTALL.md § 7.3](INSTALL.md#73-tell-the-app-about-the-proxy)); for a proxy on the app server itself, `172.20.0.1`. |

### Brokers

Brokers are tested in the app, never by `install` or `test`, so a broker
that is down never fails a deploy. Each connection has a Test button and the
app re-checks every `BROKER_PROBE_INTERVAL_SECONDS`.

| Symptom | Cause and fix |
|---|---|
| Requests for a broker return 501 | No connection for it. Add one on Settings > Connections. |
| Requests return 503 | The broker is unreachable from the app host. Cloud brokers: outbound HTTPS. MT5: the sidecar host, the terminal's login, the URL. IB: below. |
| Connection shows "overridden" | A broker line in `.env` wins over the app. Delete it when ready and `./tradingapp.sh restart`. |
| A connection shows a secret error | The secrets were sealed with another key. Re-enter them, or see [Lost encryption key](#lost-encryption-key). |
| MT5 sidecar rejects requests | The connection's Bridge secret is not the sidecar's `MT5_BRIDGE_SECRET`. |
| MT5 `/health` reports `trading_disabled` | Turn Algo Trading on in the terminal. |
| MT5 quote times off by whole hours | `MT5_SERVER_TZ` on the sidecar is wrong. |
| Symbol resolution says "ambiguous" | The broker lists several tiers of the pair; the connection needs a symbol map ([INSTALL.md § 4.6](INSTALL.md#46-not-yet-on-the-form-symbol-maps-and-account-info-from)). |
| Log line `connection breaker open` | That connection is not answering. Others keep running; it is retried after the cooldown. |

IB Gateway, checked from the app host with `nc -vz <gateway> 4002`:

| Symptom | Likely cause | Fix |
|---|---|---|
| Connection refused | Gateway not running, or wrong port | Start it; match the port on the connection to its socket port. |
| Timeout or host unreachable | A firewall between the hosts | Open the port to the app host and check routing. |
| Connects, then disconnects | Client id already in use | Give the connection an unused client id. |
| Connects but no data, or empty searches | Not logged in, no market-data subscription, or the app host missing from Trusted IPs | Log in; subscribe in IB Account Management; fix Trusted IPs and restart the Gateway. |
| Bars shifted by hours | The Gateway is not in UTC | Run it in UTC, or set `IB_TIMEZONE`. |

### Charts and streaming

| Symptom | Fix |
|---|---|
| Network errors in the browser, blank charts | `curl -fs http://<host>:3000/api/health` (through the frontend) and `:4000/api/health` (direct). If only the first fails, check `BACKEND_INTERNAL_URL` in `docker-compose.yml` matches `BACKEND_PORT`. A 503: the readiness states above. |
| Bars in the wrong year or shifted hours | Bars are stored in UTC. Compare one from `/api/market-data/history` with the broker's own chart; for IB, run the Gateway in UTC. |
| Slow charts | Shorter periods (`3M` rather than `1Y`); collect the instrument so reads come from the database. |
| Price stops updating, history still loads | `curl -fs http://<host>:4000/api/health \| jq .services.streaming`. `connected: false`: the backend cannot reach Redis (`docker compose logs backend redis`, then `docker compose restart redis`). No subscriptions: reload the chart. Ticks published but none in the browser: the session expired, sign in again. |

### Systematic trading and alerts

[PAPER_TRADING.md](PAPER_TRADING.md) is the step-by-step check for all of
this. The Fleet panel on `/systematic` shows each connection's limits and
halt state.

| Symptom | Cause and fix |
|---|---|
| Signals recorded but no orders | `SYSTEMATIC_EXECUTION_ENABLED` is off (signal-only), or a limit refuses entries. The signal's reason says which: daily loss, prop buffer, news blackout, weekend cutoff, or the connection is halted. |
| A run won't start: promotion gate | `GET /api/strategies/definitions/:id/promotion` lists what is missing. `PROMOTION_PAPER_GATE=off` skips the paper check, for smoke tests only. |
| Entries refused with "news rule cannot be checked" | The calendar could not be fetched for `NEWS_CALENDAR_MAX_AGE_HOURS`. Check outbound HTTPS. |
| A connection shows halted | A critical kill-switch trigger under `halt` or `flatten`, or an operator flatten. Fix the cause (the alert names it), then **Resume entries** on its Fleet card. A halt survives restarts. |
| "FLATTEN INCOMPLETE" alert | A close at market failed. Close the rest in the terminal, then resume. |
| Daily figures roll over at the wrong time | `TRADING_DAY_TIMEZONE` (Settings > Risk) to the broker's or prop firm's server zone. |
| Drawdown stays high after a withdrawal | Reset the high-water mark from the connection's Fleet card. |
| No Telegram messages | Check the bot token and chat id (message the bot first, then read `getUpdates`). Repeats are suppressed for `ALERT_DEDUPE_SECONDS`. |
| Heartbeat monitor never turns green | `/api/health` shows `heartbeat.last_result`. Check the URL and outbound HTTPS. |

### Emergency recovery

```bash
./tradingapp.sh fix              # stop, deploy, check
./tradingapp.sh clean            # remove containers and images; keeps the database
./tradingapp.sh install          # rebuild and wait for ready
```

`clean --include-database` also deletes the bundled database and the
internal secrets. Take a dump first.

### Reporting a problem

```bash
./tradingapp.sh doctor  > diagnostics.txt 2>&1
docker compose version >> diagnostics.txt
uname -a               >> diagnostics.txt
df -h                  >> diagnostics.txt
free -h                >> diagnostics.txt
```

Include the OS version, `diagnostics.txt`, the exact steps, and the `.env`
key names only, never their values.
