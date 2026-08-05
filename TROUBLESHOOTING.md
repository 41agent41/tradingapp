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
8. [Development Issues](#development-issues)
9. [Performance](#performance)
10. [Emergency Recovery](#emergency-recovery)
11. [Reporting Issues](#reporting-issues)

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
```

If you need an IB Gateway configuration walk-through with values from your
current `.env`:

```bash
./tradingapp.sh ib-help
```

## Common Issues

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
| Bridge connected, IB shows tick counts > 0, browser sees nothing | Auth header dropped at the Socket.IO handshake | Verify `NEXT_PUBLIC_API_TOKEN` matches `API_TOKEN`; rebuild frontend |
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

---

If the issue persists after `./tradingapp.sh fix`, see
[`GAP_ANALYSIS.md`](GAP_ANALYSIS.md) for known limitations and planned
improvements.
