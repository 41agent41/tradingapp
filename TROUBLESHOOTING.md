# TradingApp Troubleshooting Guide

Practical fixes for the most common deployment and runtime problems. All
operational commands route through `./tradingapp.sh` — this repo does **not**
ship `deploy-tradingapp.sh`, `fix-ib-connection.sh`, `fix-ib-config.sh` or
`diagnose-connection.sh`; if you see those names in older notes, ignore
them.

## Table of Contents

1. [First-Response Commands](#first-response-commands)
2. [Common Issues](#common-issues)
3. [Service-Specific Issues](#service-specific-issues)
4. [Network & CORS](#network--cors)
5. [IB Gateway Connection](#ib-gateway-connection)
6. [Docker & Containers](#docker--containers)
7. [Database](#database)
8. [Systematic trading & alerts](#systematic-trading--alerts)
9. [Development Issues](#development-issues)
10. [Performance](#performance)
11. [Emergency Recovery](#emergency-recovery)
12. [Reporting Issues](#reporting-issues)

## First-Response Commands

```bash
# Quick status (containers + ports)
./tradingapp.sh status

# Comprehensive health check (frontend / backend / IB service / IB Gateway)
./tradingapp.sh test

# Deep diagnostics (Docker info, env, network, services)
./tradingapp.sh diagnose

# Auto-repair (regenerates .env if missing, rebuilds, retests)
./tradingapp.sh fix

# Logs
./tradingapp.sh logs            # last 20 lines per service
./tradingapp.sh logs follow     # stream all services

# Timestamp/timezone check (wrong-year bars, shifted hours)
./tradingapp.sh verify-timestamps
```

If you need an IB Gateway configuration walk-through with values from your
current `.env`:

```bash
./tradingapp.sh ib-help
```

## Common Issues

### "Don't run this script as root"

**Symptoms:** `./tradingapp.sh setup` prints
`Don't run this script as root. Use a user with sudo privileges.` and exits.
Typical on a fresh LXC container or VPS where you are logged in as `root` and
cloned into `/root/tradingapp`.

**Fix:** create a sudo user, switch to it, and clone again in its home
directory:

```bash
# As root
apt update && apt install -y sudo git
adduser tradingapp                  # set a password when prompted
usermod -aG sudo tradingapp
getent group docker && usermod -aG docker tradingapp   # if Docker is already installed
su - tradingapp

# As tradingapp
cd ~
git clone https://github.com/41agent41/tradingapp.git
cd tradingapp && chmod +x tradingapp.sh
./tradingapp.sh setup
```

The old `/root/tradingapp` checkout can be removed (`exit` back to root, then
`rm -rf /root/tradingapp`). Don't work around the check with `sudo -u` from
root or by editing the script: Docker group membership, file ownership of
`.env` and the checkout all assume a normal user. See
[DEPLOYMENT.md → User account](DEPLOYMENT.md#user-account-do-not-install-as-root).

### "Docker is not running" or "docker group membership is not active" right after setup

`setup` adds you to the `docker` group, but a shell keeps the groups it
logged in with. `deploy` (and `start`, `stop`, `status`, `logs` and the
other Docker commands) notice this and re-run themselves under
`sg docker`, so no logout is needed. If you still see the message:

```bash
newgrp docker          # or log out and back in
./tradingapp.sh deploy
```

"Docker is installed but not running" means the daemon itself is down:
`sudo systemctl start docker`.

### Deploy no longer tests the IB Gateway

Brokers are optional and are checked inside the app once it is running, so
`deploy` and `test` never ping or port-test a broker, and a broker that is
down does not fail a deploy. To check IB reachability by hand, see
[IB Gateway Connection](#ib-gateway-connection).

### Services won't start

**Symptoms:** Containers exit immediately or `docker compose up` reports
port binding errors.

```bash
# Inspect port usage
sudo ss -ltnp | grep -E ':(3000|4000|8000)'

# Stop anything competing for the port (examples)
sudo systemctl stop nginx
sudo systemctl stop apache2

# Clean restart
./tradingapp.sh stop
./tradingapp.sh clean
./tradingapp.sh deploy
```

### Backend refuses to start

**Symptoms:** the backend container exits at once; its log has one or more
`refusing to start: …` lines.

```bash
docker compose logs backend | grep -E 'refusing to start|\[startup\]'
```

Each line names the key to fix:

- **`Set APP_PASSWORD (browser login) and/or API_TOKEN`**, or a secret that
  "is not set", "is still a template or default value" or "is shorter than N
  characters" (production only). Run `./tradingapp.sh config` to generate
  missing secrets, or set fresh values by hand (`openssl rand -hex 32`).
- **`BROKER_SERVICE_TOKEN …`**: it must be set, and the same value on the
  backend and the broker service (both read `.env`).
- **`POSTGRES_PASSWORD is empty or a known default`**: change it in the
  database and in `.env` together.
- **`LIVE_TRADING_ENABLED=true requires TRADING_TOKENS` / `ORDER_MFA_SECRET`**:
  live trading needs the trader role and order MFA. Set both, or set
  `LIVE_TRADING_ENABLED=false`.
- **`KILL_SWITCH_ACTION=… is not an action`**: use `notify`, `halt` or
  `flatten`.
- **`TRADING_DAY_TIMEZONE=… is not a valid IANA time zone`**: use a name such
  as `Europe/Athens`, not an offset.
- **`PROP_RULES__<CONNECTION> …`**: the JSON is invalid or a rule is out of
  range; the message says which field. The examples in `.env.example` parse.
- **`HEARTBEAT_URL must be an http(s) URL`** (or `HEARTBEAT_FAIL_URL`).
One look-alike does not stop the process: **`refusing to start: unsafe
schema for multi-connection`** means more than one connection is configured
on the old fills schema, so the backend runs with the strategy runner and
fills poller switched off. Apply `backend/src/database/timescaledb-schema.sql`
(see [Database](#database)) and restart.

Warnings (`[startup] …` without "refusing") do not stop the backend but are
worth acting on, for example auto-execution with no `HEARTBEAT_URL`.

### Browser shows a login page, or scripts get 401

The browser now signs in with `APP_PASSWORD` and holds a session cookie;
nothing secret is built into the frontend. Scripts and `curl` send
`Authorization: Bearer $API_TOKEN`. If `NEXT_PUBLIC_API_TOKEN` is still in
`.env`, remove it, and rotate `API_TOKEN` if it ever held that value: it was
readable in the web page.

### Frontend can't reach the backend

**Symptoms:** Network errors in the browser console, blank charts, CORS
warnings.

```bash
grep -E 'API_URL|CORS_ORIGINS' .env
curl -fs http://<server-ip>:4000/api/health
```

The two values must agree. For example, if `NEXT_PUBLIC_API_URL` is
`http://10.7.3.20:4000` then `CORS_ORIGINS` must contain
`http://10.7.3.20:3000`. Update `.env` and `./tradingapp.sh restart`.

### Market-data search returns nothing

**Symptoms:** Empty results, "Failed to search for contracts" toasts.

```bash
curl -s -X POST http://<server-ip>:8000/contract/search \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"AAPL","secType":"STK","exchange":"SMART"}'

curl -fs http://<server-ip>:8000/health
docker compose restart broker_service
```

If the IB service answers but the search is empty, the most likely causes
are: IB Gateway not logged in, market-data subscription missing for the
requested asset, or the server IP not in IB Gateway's trusted list.

### Charts not loading

```bash
./tradingapp.sh logs               # look for frontend errors
docker compose build --no-cache frontend
./tradingapp.sh restart
```

### Wrong years / timezone in historical bars

If chart timestamps land on the wrong year (e.g. `57554`) or bars look
shifted by several hours, run the dedicated timestamp/timezone check —
it exercises the full chain (frontend → backend → IB service → IB
Gateway) and the IB service's `/timezone-info` endpoint directly:

```bash
./tradingapp.sh verify-timestamps
```

This wraps `verify_timestamp_config.sh` (repo root); see its output for
whether `IB_FORMAT_DATE` and `TZ=UTC` are set correctly on each hop.

## Service-Specific Issues

### Frontend

```bash
# Rebuild without cache
docker compose build --no-cache frontend

# Inspect Next.js build inside the container
docker compose exec frontend npm run build
```

Environment variables that affect the build must start with `NEXT_PUBLIC_`
and must be present **at build time** — change `.env`, then redeploy with
`./tradingapp.sh redeploy`.

### Backend

```bash
# Logs
docker compose logs --tail=200 backend

# Health
curl -fs http://<server-ip>:4000/api/health

# Database health (probes the external Postgres connection)
curl -fs http://<server-ip>:4000/api/database/health
```

### IB Service

```bash
docker compose logs --tail=200 broker_service

# Verify the IB Python client is installed
docker compose exec broker_service python -c "import ibapi, fastapi; print('ok')"

# Force a rebuild (clears cached wheels)
docker compose build --no-cache broker_service
```

## Network & CORS

### Inter-container connectivity

```bash
docker compose exec backend curl -fs http://broker_service:8000/health
docker compose exec backend ping -c1 broker_service
docker network ls
docker network inspect tradingapp_tradingapp-network
```

### Inbound firewall

```bash
sudo ufw status
sudo ufw allow 3000
sudo ufw allow 4000
sudo ufw allow 8000
```

When using a reverse proxy (see `DEPLOYMENT.md`) keep these ports closed
externally and only allow `80/443`.

## IB Gateway Connection

### Reachability

```bash
ping -c1 $IB_HOST
nc -zv $IB_HOST $IB_PORT
./tradingapp.sh test
```

### Common causes

| Symptom | Likely cause | Fix |
|---|---|---|
| `Connection refused` | IB Gateway not running, wrong port | Launch IB Gateway; confirm `IB_PORT` matches the gateway's socket port |
| `Timeout` / `Host unreachable` | Firewall between server and gateway | Open the IB port on both hosts; verify routing |
| Connects then disconnects | `IB_CLIENT_ID` already in use | Pick an unused client id (1, 2, 3, …) and update `.env` |
| Connects but no market data | Missing market-data subscription, or live data on a paper account | Subscribe in IB Account Management, or test with a symbol you do have data for |

After any change in `.env`, redeploy:

```bash
./tradingapp.sh redeploy
```

### IB Gateway API settings

In IB Gateway / TWS: `File → Global Configuration → API → Settings`

- ✅ Enable ActiveX and Socket Clients
- ✅ Socket port matches `IB_PORT` in `.env`
- ✅ Master API client ID matches `IB_CLIENT_ID`
- ✅ Add the trading server's IP to **Trusted IPs**
- ✅ Uncheck "Read-Only API" if you ever intend to place orders
- 💾 Apply, OK, restart IB Gateway

## Docker & Containers

### Build failures

```bash
docker system prune -a -f
docker compose build --no-cache
sudo systemctl status docker
```

### Unexpected exit codes

| Code | Meaning |
|---|---|
| `0` | Clean exit |
| `1` | General error — check the service's logs |
| `125` | Docker daemon problem |
| `126` | Container command not executable |
| `127` | Container command not found |

```bash
docker compose ps
docker compose logs <service>
docker compose exec <service> ps aux
```

### Volume / permissions

```bash
docker compose config           # confirm mounts
sudo chown -R "$USER":"$USER" . # fix host permissions
docker compose down -v          # rebuild volumes
docker compose up -d
```

## Database

The Docker compose file does **not** provision Postgres — the backend
connects to an external instance configured via `POSTGRES_*` env vars.

```bash
# Reachability from inside the backend container
docker compose exec backend node -e "
  const net = require('net');
  const s = net.connect(parseInt(process.env.POSTGRES_PORT||'5432'), process.env.POSTGRES_HOST);
  s.on('connect', () => { console.log('reachable'); s.end(); });
  s.on('error', err => { console.error('unreachable:', err.message); process.exit(1); });
"

# Apply / re-apply the canonical TimescaleDB schema
psql "host=$POSTGRES_HOST user=$POSTGRES_USER dbname=$POSTGRES_DB sslmode=require" \
  -f backend/src/database/timescaledb-schema.sql
```

If `/api/database/health` returns `unhealthy`:

1. Confirm credentials in `.env` match the actual database.
2. Confirm `POSTGRES_SSL` matches what the server requires.
3. Confirm the user owns the `contracts`, `candlestick_data`,
   `tick_data`, `data_collection_sessions`, `data_collection_config`
   and `data_quality_metrics` tables.
4. Apply the schema as shown above.

## Systematic trading & alerts

The [paper runbook](PAPER_DEPLOYMENT_RUNBOOK.md) is the step-by-step check
for all of this; the [Fleet panel](FEATURES.md#systematic-trading-rule-driven-auto-execution)
on `/systematic` shows each connection's limits and halt state.

| Symptom | Cause / fix |
|---|---|
| Entry signals recorded but no orders | `SYSTEMATIC_EXECUTION_ENABLED` is off (signal-only), or a limit is refusing entries. The signal's reason says which: "Daily loss limit reached", "prop daily loss buffer reached", "news blackout", the weekend cutoff, or the connection is halted. |
| Run won't start or deploy: promotion gate | `GET /api/strategies/definitions/:id/promotion` lists what is missing (a backtest from the holdout date, enough trades, a paper record for live). `PROMOTION_PAPER_GATE=off` skips the paper check for smoke tests only. |
| Entries refused with "news rule cannot be checked" | The backend could not fetch `NEWS_CALENDAR_URL` for `NEWS_CALENDAR_MAX_AGE_HOURS`. Check outbound HTTPS from the app host. |
| Connection shows halted | A critical kill-switch trigger with `KILL_SWITCH_ACTION=halt` or `flatten`, or an operator flatten. Fix the cause (the alert names it), then **Resume entries** on its Fleet card. A halt survives restarts. |
| "FLATTEN INCOMPLETE" alert | A close at market failed. Close the remaining position in the terminal by hand, then resume. |
| Daily figures roll over at the wrong time | Set `TRADING_DAY_TIMEZONE` to the broker's (or prop firm's) server zone. |
| Drawdown stays high after a withdrawal | Reset the high-water mark from the connection's Fleet card. |
| No Telegram messages | Check `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (message the bot first, then read `getUpdates`). Repeats of the same alert are suppressed for `ALERT_DEDUPE_SECONDS`. |
| Heartbeat monitor never turns green | `/api/health` shows `heartbeat.last_result`. Check `HEARTBEAT_URL` and outbound HTTPS from the app host. |
| `connection breaker open — skipping its runs` | That connection's sidecar or terminal is not answering. Other connections keep running; it is retried after the cooldown. |

## Development Issues

### TypeScript errors

```bash
cat frontend/tsconfig.json
cd frontend && npm install --save-dev @types/node @types/react
cd frontend && npx tsc --noEmit
```

### Hot reload not working

Local Next.js dev runs outside Docker:

```bash
cd frontend && npm run dev
cd backend  && npm run dev
cd broker_service && uvicorn main:app --reload --host 0.0.0.0
```

Inside Docker the production images do not enable hot reload — make code
changes and `./tradingapp.sh redeploy`.

## Real-time streaming

The chart price stops updating but historical bars still load. Walk
through these in order:

```bash
# Is the bridge connected to Redis?
curl -fs http://<server-ip>:4000/api/health | jq .services.streaming

# Per-symbol refcounts and tick counters from the publisher side
curl -fs http://<server-ip>:8000/market-data/stream/status | jq

# Inspect what the publisher is actually sending (tail the channel)
docker compose exec redis redis-cli psubscribe 'marketdata:tick:*'
```

Likely causes:

| Symptom | Likely cause | Fix |
|---|---|---|
| `services.streaming.connected: false` | Backend can't reach Redis | `docker compose logs backend` for the error; confirm `REDIS_HOST` / `REDIS_PORT`; restart Redis |
| Stream status `connected: true` but `subscriptions: []` | No client has called `subscribe-market-data` | Reload the chart page; check the browser console for Socket.IO errors |
| Bridge connected, IB shows tick counts > 0, browser sees nothing | Auth header dropped at the Socket.IO handshake | Log in again (the session may have expired); check `CORS_ORIGINS` lists the exact browser origin |
| Browser sees ticks but the chart's "current price" is zero | Symbol mismatch (frontend asks for `MSFT`, IB service is publishing `aapl`) | The hook upper-cases symbols automatically; check that the page passes the symbol you expect |
| Want to skip the streaming pipeline | Set `STREAMING_ENABLED=false` on the backend and redeploy. The chart will fall back to REST seeding (no live updates). |

## Performance

```bash
# Live resource usage
docker stats

# Per-container snapshot
docker compose top
```

### Slow chart loading

- Reduce the period (e.g. `3M` instead of `1Y`) while debugging.
- Check the response size from `/api/market-data/history` and confirm IB
  isn't returning back-fill rate-limited data.
- Inspect browser devtools for slow XHRs.

### High CPU

```bash
docker compose logs | grep -i error    # tight error loops?
docker compose restart <service>
```

## Emergency Recovery

```bash
# Full reset and rebuild
./tradingapp.sh stop
./tradingapp.sh clean
./tradingapp.sh deploy

# Even more aggressive
docker system prune -a -f
docker volume prune -f
./tradingapp.sh deploy
```

### Configuration recovery

```bash
cp .env.example .env
$EDITOR .env
./tradingapp.sh redeploy
```

## Reporting Issues

Before opening an issue, please collect:

```bash
./tradingapp.sh diagnose > diagnostics.txt 2>&1
docker --version          >> diagnostics.txt
docker compose version    >> diagnostics.txt
uname -a                  >> diagnostics.txt
df -h                     >> diagnostics.txt
free -h                   >> diagnostics.txt
```

And include:

- OS and kernel version
- Output of `diagnostics.txt`
- Exact reproduction steps
- Anonymised `.env` (strip secrets!)

### Quick reference: error messages

| Message | Most likely cause |
|---|---|
| `Connection refused` | Service not running, port closed, firewall |
| `No such file or directory` | Mount path wrong, file missing in image |
| `Permission denied` | Host file owned by root, or user not in `docker` group |
| `Port already in use` | Another process bound to 3000 / 4000 / 8000 |
| `Module not found` | `npm install` / `pip install` failed during build |
| `CORS error` | `CORS_ORIGINS` does not include the frontend's origin |
| `[startup] refusing to start: …` | Unsafe or unreadable setting; see [Backend refuses to start](#backend-refuses-to-start) |
| `401` from the API | Not logged in, or the script's `API_TOKEN` is wrong |

---

If the issue persists after `./tradingapp.sh fix`, see
[`GAP_ANALYSIS.md`](GAP_ANALYSIS.md) for known limitations and planned
improvements.
