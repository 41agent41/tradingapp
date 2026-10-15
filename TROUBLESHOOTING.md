# TradingApp Troubleshooting Guide

Fixes for common deployment and runtime problems. Every operational command
goes through `./tradingapp.sh`. Setup and day-to-day running are in
[DEPLOYMENT.md](DEPLOYMENT.md).

## Contents

1. [First-response commands](#first-response-commands)
2. [Backend says waiting for the database, migration failed or key mismatch](#backend-says-waiting-for-the-database-migration-failed-or-key-mismatch)
3. [Common issues](#common-issues)
4. [Brokers](#brokers)
5. [Service-specific issues](#service-specific-issues)
6. [Network and CORS](#network-and-cors)
7. [Docker and containers](#docker-and-containers)
8. [Database](#database)
9. [Systematic trading and alerts](#systematic-trading-and-alerts)
10. [Real-time streaming](#real-time-streaming)
11. [Development issues](#development-issues)
12. [Performance](#performance)
13. [Emergency recovery](#emergency-recovery)
14. [Reporting issues](#reporting-issues)

## First-response commands

```bash
./tradingapp.sh status          # containers and ports
./tradingapp.sh test            # do the services answer?
./tradingapp.sh doctor          # Docker, .env, containers, database, schema, key, brokers
./tradingapp.sh logs            # recent lines per service
./tradingapp.sh logs follow     # stream all services
./tradingapp.sh fix             # stop, deploy and check again
```

`./tradingapp.sh install` is safe to re-run and repairs most host problems:
it completes `.env`, removes obsolete lines and waits for the backend.

## Backend says waiting for the database, migration failed or key mismatch

The backend does nothing else until its database is reachable, migrated and
opened by the encryption key. Until then `/api/health/ready` and every other
API route answer 503 with the state, and the page shows it.

```bash
./tradingapp.sh doctor
curl -s http://127.0.0.1:4000/api/health/ready | jq
docker compose logs --tail=100 backend
```

| State | What it means | What to do |
|---|---|---|
| `waiting_for_database` | The backend cannot reach PostgreSQL. It retries forever (every 1 to 30 seconds), so it recovers on its own once the database is up. | Bundled: `./tradingapp.sh status` and `./tradingapp.sh logs`. External: check the host, port, password and `POSTGRES_SSL` in `.env`, and that the app host can reach it (see [Database](#database)). |
| `migrating` | The schema is being created or updated. | Wait. A first install or a large migration can take a few minutes. |
| `migration_failed` | A migration failed. It does not retry by itself. The detail carries the database error. | Fix the cause (often permissions: the database user must own the database). Run `./tradingapp.sh migrate` to apply what is pending and see any error. Once it succeeds, run `./tradingapp.sh restart` so the backend leaves this state. |
| `key_mismatch` | `SETTINGS_ENCRYPTION_KEY` in `.env` does not open the secrets in this database. | Put the saved key back in `.env` (from `./tradingapp.sh backup-key` on the old host) and run `./tradingapp.sh deploy`. If the key is lost, see below. |

The key is lost and cannot be found:

1. Run `./tradingapp.sh forget-secrets`.
2. Type FORGET. It clears every secret sealed with the old key: broker
   credentials, secret settings, the MFA secret and the session key.
   Connections and settings stay.
3. Sign in again and re-enter the secrets on the Settings page (Connections,
   Alerts and safety, Security).

Do not generate a new key on a database that already has secrets. `install`
never replaces an existing key for that reason.

Install waits up to 900 seconds for readiness and stops early on
`migration_failed` or `key_mismatch`. On a slow host, raise the wait with
`INSTALL_TIMEOUT=1800 ./tradingapp.sh install`.

## Common issues

### "Don't run this script as root"

`./tradingapp.sh` refuses to run as root. Create a sudo user and clone again
in its home directory:

```bash
# As root
apt update && apt install -y sudo git curl
adduser tradingapp
usermod -aG sudo tradingapp
su - tradingapp

# As tradingapp
cd ~
git clone https://github.com/41agent41/tradingapp.git
cd tradingapp
./tradingapp.sh install
```

Remove the old `/root/tradingapp` checkout afterwards. Do not work around the
check with `sudo -u` from root: Docker group membership and the ownership of
`.env` assume a normal user. See
[DEPLOYMENT.md](DEPLOYMENT.md#1-prepare-the-host).

### "Docker is not running" or "docker group membership is not active"

Install adds you to the `docker` group. The Docker commands notice that the
current shell does not have the group yet and re-run themselves under
`sg docker`. If you still see the message:

```bash
newgrp docker          # or log out and back in
./tradingapp.sh deploy
```

"Docker is installed but not running" means the daemon is down:
`sudo systemctl start docker`.

### Services won't start

Containers exit at once, or compose reports a port binding error.

```bash
sudo ss -ltnp | grep -E ':(3000|4000|8000)'
```

Stop whatever holds the port, or move the app with `FRONTEND_PORT`,
`BACKEND_PORT` or `BROKER_SERVICE_PORT` in `.env`, then
`./tradingapp.sh deploy`.

### Backend refuses to start

The backend container exits at once and its log has `refusing to start: ...`
lines.

```bash
docker compose logs backend | grep -E 'refusing to start|\[startup\]'
```

Each line names the key:

- **`... is still a template or default value`** or **`is shorter than N
  characters`**: a secret pinned in `.env` is weak. Remove the line to manage
  it in the app, or set a fresh value (`openssl rand -hex 32`).
- **`BROKER_SERVICE_TOKEN ...`**: the internal token is missing or weak. It is
  normally generated into the `internal_secrets` volume. If an old `.env` still
  has a `BROKER_SERVICE_TOKEN` line, run `./tradingapp.sh install` to remove
  it, or `./tradingapp.sh rotate-internal-secrets` to make a new one.
- **`POSTGRES_PASSWORD is empty or a known default`**: change it in the
  database and in `.env` together.
- **`KILL_SWITCH_ACTION=... is not an action`**: use `notify`, `halt` or
  `flatten`.
- **`TRADING_DAY_TIMEZONE=... is not a valid IANA time zone`**: use a name such
  as `Europe/Athens`, not an offset.
- **`PROP_RULES__<CONNECTION> ...`**: the JSON is invalid or a rule is out of
  range. The message names the field.
- **`HEARTBEAT_URL must be an http(s) URL`** (or `HEARTBEAT_FAIL_URL`).

The last four are usually pinned in `.env`. The same settings can be managed
on the Settings page instead, which checks them when you save.

`refusing to start: unsafe schema for multi-connection` does not stop the
process. It means more than one connection exists on an old fills schema, so
the strategy runner and fills poller stay off. Run `./tradingapp.sh migrate`,
then `./tradingapp.sh restart`.

Lines with `[startup]` but no "refusing" are warnings. The backend runs, but
they are worth acting on, for example auto-execution with no heartbeat URL.

### Browser shows a login page, or scripts get 401

The browser signs in with the login password. Scripts send
`Authorization: Bearer <token>` with an API token from Settings > Security.
If `NEXT_PUBLIC_API_TOKEN` is still in `.env`, remove it, and rotate any API
token that ever held that value: it was readable in the web page.

The login page asks for a setup code when no password is set yet. Run
`./tradingapp.sh setup-code` on the server.

Forgot the password, or lost the authenticator: set `APP_PASSWORD` (or
`ORDER_MFA_SECRET`) in `.env` and run `./tradingapp.sh deploy`. The `.env`
value wins. Sign in, set a new one on the Security tab, then remove the line
and deploy again.

### Frontend can't reach the backend

Network errors in the browser console, or blank charts.

```bash
curl -fs http://<server-ip>:3000/api/health      # through the frontend
curl -fs http://<server-ip>:4000/api/health      # the backend directly
docker compose logs frontend | grep -i 'backend unavailable'
```

The browser calls the API on the frontend's own address, and the frontend
forwards it to the backend. If the first command fails and the second works,
check `BACKEND_INTERNAL_URL` in `docker-compose.yml` matches `BACKEND_PORT`.
If the backend answers 503, see
[the readiness states](#backend-says-waiting-for-the-database-migration-failed-or-key-mismatch).

### Charts not loading

```bash
./tradingapp.sh logs
./tradingapp.sh redeploy
```

### Wrong years or shifted hours in bars

Bars are stored in UTC. If times look shifted:

1. Run `./tradingapp.sh doctor` and check the broker state.
2. For IB, run the Gateway host in UTC. The broker service reads IB times as
   `IB_TIMEZONE`, which defaults to UTC.
3. Compare a bar from `/api/market-data/history` with the broker's own chart
   for the same bar.

## Brokers

Brokers are added and tested in the app, under Settings > Connections. Deploy
and `test` never test a broker, so a broker that is down never fails a
deploy. Each connection has a Test button, and the app re-checks every
`BROKER_PROBE_INTERVAL_SECONDS` (Settings > Schedulers and data).

| Symptom | Cause and fix |
|---|---|
| Requests for a broker return 501 | No connection for it. Add one on Settings > Connections. |
| Requests return 503 | The broker is unreachable from the app host. For Alpaca and OANDA, check outbound HTTPS. For MT5, check the sidecar host is up, the terminal is logged in and the app host can reach the sidecar URL. |
| Connection shows "overridden" | A broker line in `.env` (for example `IB_HOST`) wins over the app. Delete it when you are ready and run `./tradingapp.sh deploy`. |
| MT5 sidecar rejects requests | The secret on the connection does not match `MT5_BRIDGE_SECRET` in the sidecar's `sidecar.env`. |

### IB Gateway

Check reachability from the app host:

```bash
nc -zv <gateway-ip> 4002
```

| Symptom | Likely cause | Fix |
|---|---|---|
| `Connection refused` | Gateway not running, or wrong port | Start IB Gateway. Check the port on the connection matches the gateway's socket port. |
| Timeout or host unreachable | Firewall between the hosts | Open the port on both hosts and check routing. |
| Connects, then disconnects | Client id already in use | Give the connection an unused client id. |
| Connects but no market data | Missing subscription, or live data on a paper account | Subscribe in IB Account Management, or test with a symbol you have data for. |

In IB Gateway or TWS, `File > Global Configuration > API > Settings`:

- Enable ActiveX and Socket Clients.
- Set the socket port (4002 paper, 4001 live).
- Add the app host's IP to Trusted IPs.
- Untick "Read-Only API" if you will place orders.
- Apply, then restart IB Gateway.

### Market-data search returns nothing

If the connection tests fine but searches are empty, the likely causes are an
IB Gateway that is not logged in, a missing market-data subscription, or the
app host's IP missing from Trusted IPs.

```bash
docker compose logs --tail=100 broker_service
docker compose restart broker_service
```

## Service-specific issues

### Frontend

```bash
docker compose build --no-cache frontend
./tradingapp.sh restart
```

### Backend

```bash
docker compose logs --tail=200 backend
curl -fs http://<server-ip>:4000/api/health
curl -fs http://<server-ip>:4000/api/health/ready
curl -fs http://<server-ip>:4000/api/database/health
```

### Broker service

```bash
docker compose logs --tail=200 broker_service
curl -fs http://127.0.0.1:8000/health          # loopback only
docker compose exec broker_service python -c "import ibapi, fastapi; print('ok')"
docker compose build --no-cache broker_service
```

## Network and CORS

### Between containers

```bash
docker compose exec backend wget -qO- http://172.20.0.10:8000/health
docker network inspect tradingapp_tradingapp-network
```

### Inbound firewall

```bash
sudo ufw status
sudo ufw allow 3000
```

Behind a reverse proxy, allow only 80 and 443. Never open 8000: the broker
service is published on loopback only. See
[DEPLOYMENT.md](DEPLOYMENT.md#reverse-proxy-tls-and-firewall).

### CORS errors, or the wrong visitor address in logs

`CORS_ORIGINS` and `TRUST_PROXY` are on Settings > Network and apply at once.
A CORS error only affects pages on another site calling the API from a
browser; list their exact origins in `CORS_ORIGINS`. Behind nginx, set
`TRUST_PROXY` to the address nginx reaches the frontend from (usually
`172.20.0.1`) so login lockout and the settings history see the visitor's
address.

## Docker and containers

### Build failures

```bash
docker system prune -f
docker compose build --no-cache
sudo systemctl status docker
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean exit |
| `1` | General error. Check the service's logs. |
| `125` | Docker daemon problem |
| `126` | Container command not executable |
| `127` | Container command not found |

### Permissions

```bash
sudo chown -R "$USER":"$USER" .
chmod 600 .env
```

Do not run `docker compose down -v` to "fix" volumes. It deletes the bundled
database and the internal secrets. Use `./tradingapp.sh clean`, which keeps
them.

## Database

The bundled database (the default) runs in the `postgres` container. An
external one is set with `--external-db`. The backend creates and migrates
the schema itself; there is nothing to apply by hand.

```bash
./tradingapp.sh doctor           # database, schema and key as the backend sees them
./tradingapp.sh migrate          # schema state; applies anything pending
```

Reachability of an external database from inside the backend container:

```bash
docker compose exec backend node -e "
  const net = require('net');
  const s = net.connect(parseInt(process.env.POSTGRES_PORT||'5432'), process.env.POSTGRES_HOST);
  s.on('connect', () => { console.log('reachable'); s.end(); });
  s.on('error', err => { console.error('unreachable:', err.message); process.exit(1); });
"
```

If `/api/database/health` reports unhealthy:

1. Check the credentials in `.env` match the database.
2. Check `POSTGRES_SSL` matches what the server requires.
3. Check the database user owns the database, so migrations can create and
   alter tables.
4. Run `./tradingapp.sh migrate` and read its output.

## Systematic trading and alerts

The [paper runbook](PAPER_DEPLOYMENT_RUNBOOK.md) is the step-by-step check
for all of this. The [Fleet panel](FEATURES.md#systematic-trading-rule-driven-auto-execution)
on `/systematic` shows each connection's limits and halt state.

| Symptom | Cause and fix |
|---|---|
| Entry signals recorded but no orders | `SYSTEMATIC_EXECUTION_ENABLED` is off (signal-only), or a limit is refusing entries. The signal's reason says which: "Daily loss limit reached", "prop daily loss buffer reached", "news blackout", the weekend cutoff, or the connection is halted. |
| Run won't start or deploy: promotion gate | `GET /api/strategies/definitions/:id/promotion` lists what is missing (a backtest from the holdout date, enough trades, a paper record for live). `PROMOTION_PAPER_GATE=off` skips the paper check, for smoke tests only. |
| Entries refused with "news rule cannot be checked" | The backend could not fetch the news calendar for `NEWS_CALENDAR_MAX_AGE_HOURS`. Check outbound HTTPS from the app host. |
| Connection shows halted | A critical kill-switch trigger with `KILL_SWITCH_ACTION` set to `halt` or `flatten`, or an operator flatten. Fix the cause (the alert names it), then **Resume entries** on its Fleet card. A halt survives restarts. |
| "FLATTEN INCOMPLETE" alert | A close at market failed. Close the rest of the position in the terminal by hand, then resume. |
| Daily figures roll over at the wrong time | Set `TRADING_DAY_TIMEZONE` (Settings > Risk) to the broker's or prop firm's server zone. |
| Drawdown stays high after a withdrawal | Reset the high-water mark from the connection's Fleet card. |
| No Telegram messages | Check the bot token and chat id on Settings > Alerts and safety (message the bot first, then read `getUpdates`). Repeats of the same alert are suppressed for `ALERT_DEDUPE_SECONDS`. |
| Heartbeat monitor never turns green | `/api/health` shows `heartbeat.last_result`. Check the heartbeat URL and outbound HTTPS from the app host. |
| Log line `connection breaker open` | That connection's sidecar or terminal is not answering. Other connections keep running; it is retried after the cooldown. |

## Real-time streaming

The chart price stops updating but historical bars still load.

```bash
curl -fs http://<server-ip>:4000/api/health | jq .services.streaming
curl -fs http://127.0.0.1:8000/market-data/stream/status | jq
```

| Symptom | Likely cause | Fix |
|---|---|---|
| `services.streaming.connected: false` | Backend can't reach Redis | `docker compose logs backend redis`, then `docker compose restart redis`. |
| Stream status `connected: true` but `subscriptions: []` | No browser has subscribed | Reload the chart page and check the browser console for Socket.IO errors. |
| Ticks published, browser sees nothing | Session expired at the Socket.IO handshake | Sign in again. |
| Want to skip streaming | | Turn off Live streaming on Settings > Schedulers and data. Charts fall back to one-off REST calls. |

## Development issues

Local development runs outside Docker:

```bash
cd frontend && npm run dev
cd backend  && npm run dev
cd broker_service && uvicorn main:app --reload --host 0.0.0.0
```

Type check the frontend with `cd frontend && npx tsc --noEmit`. The Docker
images do not hot-reload: change the code and run `./tradingapp.sh redeploy`.

## Performance

```bash
docker stats
docker compose top
```

- Slow charts: shorten the period (for example `3M` instead of `1Y`) and
  check the size of `/api/market-data/history` responses in the browser's
  developer tools.
- High CPU: look for tight error loops with
  `docker compose logs | grep -i error`, then restart that service.

## Emergency recovery

```bash
./tradingapp.sh fix              # stop, deploy, check
./tradingapp.sh clean            # remove containers and images; keeps the database
./tradingapp.sh install          # rebuild and wait for ready
```

`clean --include-database` also deletes the bundled database and the
internal secrets, after you type DELETE. Take a backup first (see
[DEPLOYMENT.md](DEPLOYMENT.md#database-backups)).

If `.env` is lost or damaged, do not copy `.env.example`. Restore it from a
backup, or recreate it:

1. Run `./tradingapp.sh install --env-only`.
2. Put back the original `POSTGRES_PASSWORD` and `SETTINGS_ENCRYPTION_KEY`.
   Install generates new ones only when they are missing, and the existing
   database needs the old values.
3. Run `./tradingapp.sh install`.

## Reporting issues

Collect:

```bash
./tradingapp.sh doctor    > diagnostics.txt 2>&1
docker compose version   >> diagnostics.txt
uname -a                 >> diagnostics.txt
df -h                    >> diagnostics.txt
free -h                  >> diagnostics.txt
```

Include the OS version, `diagnostics.txt`, the exact steps, and the
`.env` key names only. Never paste its values.

### Error messages

| Message | Most likely cause |
|---|---|
| 503 with `waiting_for_database`, `migration_failed` or `key_mismatch` | See [the readiness states](#backend-says-waiting-for-the-database-migration-failed-or-key-mismatch). |
| `Connection refused` | Service not running, port closed, or firewall |
| `Permission denied` | Host file owned by root, or user not in the `docker` group |
| `Port already in use` | Another process holds 3000, 4000 or 8000 |
| `Module not found` | `npm install` or `pip install` failed during the build |
| `CORS error` | `CORS_ORIGINS` on Settings > Network does not include the calling page's origin |
| `[startup] refusing to start: ...` | See [Backend refuses to start](#backend-refuses-to-start). |
| `401` from the API | Not signed in, or the script's API token is wrong |
| Login page asks for a setup code | No password yet. Run `./tradingapp.sh setup-code`. |

Known limitations and planned work are in
[GAP_ANALYSIS.md](docs/plans/GAP_ANALYSIS.md).
