# TradingApp Deployment Guide

Complete guide for deploying TradingApp on a remote server. All operations
flow through the single management script `./tradingapp.sh` — there are no
other deployment scripts in this repository.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [One-Command Deployment](#one-command-deployment)
3. [Manual Deployment](#manual-deployment)
4. [Environment Configuration](#environment-configuration)
5. [Service Verification](#service-verification)
6. [Common Issues](#common-issues)
7. [Production Setup](#production-setup)
8. [Monitoring & Maintenance](#monitoring--maintenance)
9. [Deployment Checklist](#deployment-checklist)

## Prerequisites

### System

- **OS**: Ubuntu 20.04+ (the `tradingapp.sh` installer uses `apt`)
- **RAM**: 2 GB minimum, 4 GB+ recommended
- **Storage**: 10 GB free
- **Ports**: 3000, 4000, 8000 (and 6379 if you expose Redis)

### Software

- **Docker** 20.10+
- **Docker Compose** 2.0+
- **Git**

`./tradingapp.sh setup` will install Docker and Docker Compose for you on a
fresh Ubuntu host.

### Interactive Brokers

- **IB Gateway** or **TWS** running and logged in.
- **API access enabled** (`File → Global Configuration → API → Settings`,
  enable "ActiveX and Socket Clients", set the socket port — `4002` is the
  default for paper trading).
- The trading server's IP added to the **trusted IPs** list in IB Gateway.
- Market-data subscriptions for the assets you intend to query (paper
  accounts are recommended for testing).

### External database (recommended for production)

By default the base `docker-compose.yml` does **not** provision a
PostgreSQL container — the backend is wired to an external Postgres
(TimescaleDB recommended). Make sure you have:

- A reachable Postgres 14+ instance.
- Connection credentials (host, port, user, password, database).
- The schema initialised — see
  [`backend/src/database/README.md`](backend/src/database/README.md).

#### Local / self-hosted alternative

For development or self-hosted deployments without an external Postgres,
opt into the bundled TimescaleDB by passing `--with-db` to any
`tradingapp.sh` command:

```bash
./tradingapp.sh deploy --with-db    # bring up the stack including local TimescaleDB
./tradingapp.sh status              # subsequent commands remember the choice
./tradingapp.sh --no-db redeploy    # drop the override again
```

Under the hood `--with-db` layers `docker-compose.db.yml` onto the base
file. The schema in `backend/src/database/timescaledb-schema.sql` is
applied automatically on first run.

## One-Command Deployment

```bash
# 1. Clone
git clone https://github.com/41agent41/tradingapp.git
cd tradingapp

# 2. Make the script executable
chmod +x tradingapp.sh

# 3. First-time setup (installs Docker, writes .env)
./tradingapp.sh setup

# 4. Deploy the full stack
./tradingapp.sh deploy

# 5. Confirm everything is healthy
./tradingapp.sh test
```

### Available `tradingapp.sh` commands

| Command | Purpose | When to use |
|---|---|---|
| `setup` | Install Docker, write a baseline `.env`, configure IB | First-time host setup |
| `deploy` | Build images and bring the stack up | Initial deployment |
| `redeploy` | Stop, prune project images, rebuild from scratch | After code changes |
| `config` | Re-prompt for IB Gateway host and rewrite `.env` | Change IB settings |
| `env` | Same as `config`, but does not redeploy | Quick env regeneration |
| `start` / `stop` / `restart` | Compose lifecycle | Day-to-day ops |
| `status` | `docker-compose ps` | Quick health check |
| `logs` | Last 20 lines per service (`logs -f` to follow) | Inspect output |
| `test` | Check frontend, backend, IB service and IB Gateway reachability | Troubleshooting |
| `diagnose` | All of `test`, plus Docker, env file and container summaries | Debug a broken host |
| `fix` | Recreate `.env` if missing, restart services and re-test | Auto-recover |
| `ib-help` | Print IB Gateway configuration walk-through | Tweaking IB settings |
| `clean` | Stop, remove project images and prune Docker | Reset before a fresh `deploy` |

> Note: `tradingapp.sh config` **overwrites** `.env` with its own template.
> If you have hand-edited keys (e.g. `POSTGRES_HOST`, `JWT_SECRET`), copy
> them aside first and re-apply them after running `config`.

## Manual Deployment

If you prefer not to use `tradingapp.sh`:

```bash
# Install Docker (Ubuntu)
sudo apt update && sudo apt install -y curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER  # log out / back in after this

# Clone and configure
git clone https://github.com/41agent41/tradingapp.git
cd tradingapp
cp .env.example .env
$EDITOR .env   # set SERVER_IP, IB_HOST, POSTGRES_*, secrets, etc.

# Build and start
docker compose build
docker compose up -d
docker compose ps
```

## Environment Configuration

`.env.example` is the documented reference; copy it to `.env` and fill in
the values that apply to your environment. The most important keys:

```bash
# Server / network
SERVER_IP=10.7.3.20
NEXT_PUBLIC_API_URL=http://10.7.3.20:4000
CORS_ORIGINS=http://10.7.3.20:3000

# IB Gateway
IB_HOST=10.7.3.21
IB_PORT=4002
IB_CLIENT_ID=1
IB_TIMEOUT=30

# External Postgres / TimescaleDB
POSTGRES_HOST=db.example.com
POSTGRES_PORT=5432
POSTGRES_USER=tradingapp
POSTGRES_PASSWORD=<rotate-me>
POSTGRES_DB=tradingapp
POSTGRES_SSL=true

# Secrets (generate each with: openssl rand -hex 32)
API_TOKEN=<rotate-me>
NEXT_PUBLIC_API_TOKEN=<same value as API_TOKEN>
JWT_SECRET=<rotate-me>
SESSION_SECRET=<rotate-me>
```

### Configuring IB Gateway

1. Launch IB Gateway / TWS and log in.
2. `File → Global Configuration → API → Settings`
   - Check **Enable ActiveX and Socket Clients**.
   - Set **Socket port** to `4002` (paper) or `4001` (live).
   - Add your trading server IP to **Trusted IPs**.
3. Apply, click OK, and restart IB Gateway.
4. Run `./tradingapp.sh test` to confirm the socket is reachable.

`./tradingapp.sh ib-help` prints the same walk-through with values
substituted from your current `.env`.

## Authentication & CORS

Phase 2 added bearer-token authentication and tightened CORS handling.
Set up the two values together — they must match — and the frontend
build picks the token up automatically.

### Generate a token

```bash
# 32-byte hex string, plenty of entropy for a single-tenant app
openssl rand -hex 32
```

Put the value into `.env` **twice**: once on the server side
(`API_TOKEN`) and once on the frontend side (`NEXT_PUBLIC_API_TOKEN`).
They must be identical.

```bash
API_TOKEN=<the-token-you-generated>
NEXT_PUBLIC_API_TOKEN=<same-value>
```

Because Next.js bakes `NEXT_PUBLIC_*` variables into the static bundle
at build time, you must rebuild the frontend whenever either value
changes:

```bash
./tradingapp.sh redeploy
```

### How the token is used

- **REST**: every backend route except `/api/health` and
  `/api/database/health` requires `Authorization: Bearer <token>` (or
  `X-API-Token: <token>`). The frontend's `apiFetch` helper attaches the
  header automatically.
- **Socket.IO**: the handshake reads the token from `auth.token`, the
  `Authorization` header, or a `?token=` query parameter. The frontend's
  Socket.IO calls use `socketAuth()` which sets `auth.token`.
- **Validation**: comparisons run through `crypto.timingSafeEqual` so
  timing attacks cannot probe the token byte-by-byte.

If `API_TOKEN` is left empty, the backend prints a loud warning at
startup and accepts unauthenticated requests. This is convenient for
local development but should never ship to production.

### CORS

`CORS_ORIGINS` is now strictly enforced. Set it to a comma-separated
list of trusted origins (the exact strings browsers send in their
`Origin` header):

```bash
CORS_ORIGINS=http://10.7.3.20:3000,https://app.example.com
```

Setting `CORS_ORIGINS=*` (or leaving it empty) prints a startup warning
and falls back to accepting any origin — again, fine for dev, not for
production.

## Redis cache

The Redis container that ships with the base compose file is now wired
into the backend as a **read-through cache** for high-traffic endpoints:

- `/api/market-data/realtime` — `CACHE_TTL_REALTIME` seconds (default `2`).
- `/api/market-data/indicators/available` — 1 hour, refreshed via the
  cache wrapper.

A Redis outage degrades into a cache miss — every endpoint keeps working
without it. Health is surfaced in `/api/health` under
`services.cache.connected`. To disable caching entirely set
`REDIS_ENABLED=false` in `.env`.

## Service Verification

```bash
# Compose status
./tradingapp.sh status

# End-to-end health
./tradingapp.sh test

# Endpoint smoke tests
curl -I  http://<server-ip>:3000          # Frontend
curl -fs http://<server-ip>:4000/api/health
curl -fs http://<server-ip>:8000/health   # IB service
```

Open the frontend in a browser at `http://<server-ip>:3000`.

## Common Issues

| Symptom | First step |
|---|---|
| Services won't start (port clash) | `sudo ss -ltnp \| grep -E ':(3000\|4000\|8000)'` and free the port |
| Frontend can't reach backend | Verify `NEXT_PUBLIC_API_URL` and `CORS_ORIGINS` agree with your server IP |
| IB connection failures | `./tradingapp.sh ib-help`, then `./tradingapp.sh test` |
| Database health check fails | Confirm `POSTGRES_HOST` is reachable from inside the backend container (`docker compose exec backend node -e "require('net').connect(5432,'$POSTGRES_HOST').on('connect',()=>console.log('ok'))"`) |
| Charts not loading | `./tradingapp.sh logs` for frontend errors, then `./tradingapp.sh redeploy` |

For a fuller list, see [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

## Production Setup

### Reverse proxy + TLS

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo $EDITOR /etc/nginx/sites-available/tradingapp
```

Example `nginx` site:

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location /        { proxy_pass http://localhost:3000; }
    location /api/    { proxy_pass http://localhost:4000; }
    location /ib/     { proxy_pass http://localhost:8000; }

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

```bash
sudo ln -s /etc/nginx/sites-available/tradingapp /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d your-domain.com
```

### Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

If you expose the raw ports (no reverse proxy) also allow `3000`, `4000`,
`8000`.

### Systemd auto-start

```ini
# /etc/systemd/system/tradingapp.service
[Unit]
Description=TradingApp
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/tradingapp
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
User=tradingapp

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tradingapp
```

## Monitoring & Maintenance

```bash
# Service health
./tradingapp.sh status
./tradingapp.sh test

# Logs
./tradingapp.sh logs           # last 20 lines per service
./tradingapp.sh logs follow    # stream all services

# Resource usage
docker stats
docker system df
```

### Updates

```bash
cd /opt/tradingapp
git pull origin master
./tradingapp.sh redeploy
```

### Database backups

Because the database is external, backups are owned by whichever managed
service or self-hosted Postgres you point `POSTGRES_HOST` at. A typical
cron-driven dump:

```bash
#!/usr/bin/env bash
set -euo pipefail
BACKUP_DIR=/var/backups/tradingapp
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"
PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
  -h "$POSTGRES_HOST" -U "$POSTGRES_USER" "$POSTGRES_DB" \
  > "$BACKUP_DIR/tradingapp_${DATE}.sql"
find "$BACKUP_DIR" -name 'tradingapp_*.sql' -mtime +7 -delete
```

## Deployment Checklist

- [ ] Host meets the prerequisites
- [ ] Docker / Docker Compose installed (`./tradingapp.sh setup` handles this)
- [ ] Repository cloned and `tradingapp.sh` executable
- [ ] `.env` created from `.env.example` and reviewed (no placeholders left)
- [ ] `API_TOKEN` and `NEXT_PUBLIC_API_TOKEN` set to the same fresh random value
- [ ] `CORS_ORIGINS` set to the actual browser origin(s) — not `*`
- [ ] External Postgres reachable from the backend container; schema applied
      (or `--with-db` used to bring up the bundled TimescaleDB)
- [ ] IB Gateway / TWS running with API enabled and server IP trusted
- [ ] Firewall allows the required ports (or reverse proxy in place)
- [ ] `./tradingapp.sh deploy` completed
- [ ] `./tradingapp.sh test` reports all services healthy
- [ ] Frontend renders charts in the browser
- [ ] TLS certificate installed (production)
- [ ] Backup strategy in place for the external database

---

**You're ready to deploy.** If anything misbehaves, run
`./tradingapp.sh diagnose` and see [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).
