# TradingApp Deployment Guide

Complete guide for deploying TradingApp on a remote server. All operations
flow through the single management script `./tradingapp.sh` — there are no
other deployment scripts in this repository.

> Building the hosts themselves from scratch on a hypervisor? See
> [`PROXMOX_DEPLOYMENT.md`](PROXMOX_DEPLOYMENT.md) — it covers Proxmox VE
> post-install, LXC container creation (including the flags Docker-in-LXC
> requires), a dedicated TimescaleDB container, the IB Gateway and MT5
> session hosts, firewalling and backups, then hands off to this document
> for the application itself.

## Table of Contents

1. [Upgrading from `ib_service`](#upgrading-from-ib_service)
2. [Prerequisites](#prerequisites)
3. [Multi-Broker Host Topology (IB + MT5)](#multi-broker-host-topology-ib--mt5)
4. [One-Command Deployment](#one-command-deployment)
5. [Manual Deployment](#manual-deployment)
6. [Environment Configuration](#environment-configuration)
7. [Executions (fills) sync](#executions-fills-sync)
8. [Service Verification](#service-verification)
9. [Common Issues](#common-issues)
10. [Production Setup](#production-setup)
11. [Monitoring & Maintenance](#monitoring--maintenance)
12. [Deployment Checklist](#deployment-checklist)

## Upgrading from `ib_service`

The `ib_service` directory and Docker Compose service are now **`broker_service`**
— the service grew beyond Interactive Brokers (it also hosts the MT5, Alpaca
and OANDA adapters), so the name no longer fit. This is a **breaking change**
for existing deployments:

- The Compose service is now named `broker_service` (was `ib_service`) — update
  any scripts that call `docker compose logs ib_service` / `exec ib_service`.
- Env vars renamed: `IB_SERVICE_URL` → `BROKER_SERVICE_URL`,
  `IB_SERVICE_PORT` → `BROKER_SERVICE_PORT`, `IB_SERVICE_HOST` →
  `BROKER_SERVICE_HOST`. Update your `.env` accordingly — the old names are
  **not** read as fallbacks.
- `IB_HOST` / `IB_PORT` / `IB_CLIENT_ID` (the actual IB Gateway connection)
  are **unchanged** — only the service-identity vars above were renamed.
- `./tradingapp.sh` already targets the new service name; no script changes
  needed on your part beyond `.env`.

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

### MetaTrader 5 (MT5) — optional second broker

MT5 is optional; skip this if you're only trading through IB. The
`MetaTrader5` Python package only runs against a live MT5 terminal and is
**Windows-only**, so it cannot join the Linux Docker stack. Instead:

- A **dedicated Windows host** runs the MT5 terminal, logged into its own
  MT5 account, plus a small FastAPI sidecar service that exposes the HTTP
  contract documented in
  [`broker_service/mt5_adapter.py`](broker_service/mt5_adapter.py) (`/health`,
  `/symbols`, `/history`, `/quote`, `/tick`, `/orders`, `/positions`,
  `/account`). The sidecar itself is not part of this repository — it's a
  separate service you build and run on that Windows host.
- The Linux `broker_service` container talks to it as an HTTP client
  (`MT5Adapter`) — set `MT5_BRIDGE_URL` (e.g.
  `MT5_BRIDGE_URL=http://10.7.3.22:9100`) and redeploy. Until it's set,
  `source=mt5` / `broker=mt5` resolve to a clean `501` instead of a
  confusing `404`.
- Also set `MT5_BRIDGE_SECRET` to a random shared secret, and have the
  sidecar reject any request whose `X-MT5-Bridge-Secret` header doesn't
  match — the sidecar contract otherwise has no auth story, so anything
  that can reach `MT5_BRIDGE_URL` can trade the account. `broker_service`
  logs a startup warning if `MT5_BRIDGE_URL` is set without
  `MT5_BRIDGE_SECRET`.
- See [Multi-Broker Host Topology](#multi-broker-host-topology-ib--mt5)
  below for how this host relates to the rest of the deployment, and the
  design trade-offs of running IB and MT5 as separate dedicated hosts with
  separate accounts.

### Alpaca and OANDA — optional cloud brokers

Both are optional and, unlike MT5, need **no dedicated host** — they're cloud
REST APIs the `broker_service` container calls directly over HTTPS, so
enabling either is just setting credentials and redeploying:

- **Alpaca** (US equities/options): set `ALPACA_API_KEY` and
  `ALPACA_API_SECRET`; `ALPACA_PAPER` (default `true`) selects Alpaca's paper
  or live trading endpoint. Once both credentials are set, `source=alpaca` /
  `broker=alpaca` become available.
- **OANDA** (FX/CFD): set `OANDA_API_TOKEN` and `OANDA_ACCOUNT_ID`;
  `OANDA_ENVIRONMENT` (`practice` default, or `live`) selects the endpoint.
  Once both credentials are set, `source=oanda` / `broker=oanda` become
  available.

Until a broker's credentials are set, requests for it resolve to a clean
`501` (same as MT5 without `MT5_BRIDGE_URL`), not a confusing `404`.

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

## Multi-Broker Host Topology (IB + MT5)

TradingApp can trade through several broker venues at once via the adapter
seam in [`broker_service/adapters.py`](broker_service/adapters.py). IB and
MT5 are both **GUI applications that hold a logged-in broker session**, and
neither runs inside the Docker stack, so a full deployment spans up to four
hosts. Alpaca and OANDA don't need this treatment — they're cloud REST APIs
the `broker_service` container calls directly (see
[Alpaca and OANDA](#alpaca-and-oanda--optional-cloud-brokers) above) — so
this topology discussion is specific to IB + MT5:

```
                    ┌────────────────────────────────────────────┐
                    │  App host — Docker Compose                 │
                    │  frontend :3000  backend :4000  redis :6379│
                    │  broker_service :8000  (172.20.0.0/16 bridge)  │
                    └───────┬──────────────────────┬─────────────┘
                            │                       │
              IB socket API │                       │ HTTP (MT5Adapter)
                (4001/4002) │                       │ MT5_BRIDGE_URL
                            ▼                       ▼
              ┌──────────────────────┐   ┌───────────────────────────┐
              │ IB Gateway / TWS host│   │ MT5 Windows host           │
              │ logged into one      │   │ MT5 terminal, logged into  │
              │ IB account           │   │ one MT5 account            │
              │ (Win/Linux, GUI)     │   │  + FastAPI sidecar :9100   │
              │                      │   │  (not in this repo — see   │
              │                      │   │  broker_service/mt5_adapter.py)│
              └──────────────────────┘   └───────────────────────────┘
                            │
                            │ (elsewhere)
                            ▼
              ┌──────────────────────┐
              │ External Postgres /  │
              │ TimescaleDB          │
              └──────────────────────┘
```

- **App host → IB Gateway host:** `broker_service` connects outbound over the
  IB socket API (`IB_HOST:IB_PORT`, `ibapi`). One TCP session, one
  `IB_CLIENT_ID`, one logged-in IB account.
- **App host → MT5 host:** `broker_service`'s `MT5Adapter` connects outbound
  over plain HTTP to the sidecar (`MT5_BRIDGE_URL`). One logged-in MT5
  account, driven by whatever process keeps the MT5 terminal signed in on
  that host.
- Both venues are **broker-scoped** end-to-end: contract catalogues,
  positions, order audit and the net-exposure cap are keyed per broker, so
  IB and MT5 never reconcile against each other and a systematic run
  targets exactly one venue (see `FEATURES.md` §
  [Multi-broker: IB + MetaTrader](FEATURES.md#multi-broker-interactive-brokers--metatrader-mt5)).
- Only the app host needs inbound exposure to end users (3000/4000, or a
  reverse proxy in front of them). The IB Gateway and MT5 hosts should only
  accept inbound connections from the app host's IP — put both behind the
  same private network/VPN as the app host, never on the public internet.

### Design considerations: one dedicated host + one account per broker

The current design — a separate host per broker, each logged into its own
broker account — is a reasonable default, but it's worth being deliberate
about *why*, because it also compounds some existing weaknesses rather
than fixing them.

**What it gets right:**

- **Forced by MT5, not optional.** `MetaTrader5` only runs Windows-side
  against a live terminal, so *some* Windows host is unavoidable for MT5
  regardless of how IB is deployed.
- **Blast-radius isolation.** A crash, reboot, or Windows Update on the
  MT5 host can't take down the IB session (or the Docker stack), and vice
  versa. A resource-hungry MT5 backtest can't starve IB Gateway's socket
  loop.
- **Session isolation.** IB Gateway and an MT5 terminal are both fragile,
  stateful GUI sessions (auto-logout, 2FA re-prompts, update dialogs).
  Keeping them on separate machines means a stuck dialog or forced restart
  on one doesn't require touching the other.

**Where it's worth challenging:**

- **It doubles the "must stay logged in" operational problem instead of
  solving it.** The single-host review already flagged the IB Gateway
  session as a manual, non-declarative dependency and a hard SPOF. Adding
  a second GUI-session host for MT5 doesn't reduce that risk, it
  duplicates it — now there are two broker sessions that can silently log
  out and quietly stop trading, each needing its own babysitting
  (auto-restart, session-alive monitoring, 2FA handling).
- **The MT5 sidecar contract supports shared-secret auth, but it's opt-in
  and the sidecar side still has to enforce it.** `MT5Adapter`
  (`broker_service/mt5_adapter.py`) sends an `X-MT5-Bridge-Secret` header
  on every request when `MT5_BRIDGE_SECRET` is set (`broker_service` logs a
  startup warning if `MT5_BRIDGE_URL` is configured without it). That's
  only half the contract — the sidecar itself, built and run on the
  Windows host outside this repo, has to reject requests missing the
  header or presenting the wrong value. Until that check is implemented
  there, *anything* that can reach `MT5_BRIDGE_URL:9100` can still query
  positions/account and place, cancel, or modify orders on that MT5
  account — the same class of gap as the unauthenticated Redis instance in
  the base compose file. mTLS is a stronger alternative if the sidecar
  framework makes that easier than header-checking.
- **"Dedicated host" doesn't necessarily mean "separate hardware."** The
  two accounts genuinely need to stay separate (they're different broker
  relationships), but the *hosts* don't automatically need to be separate
  physical/virtual machines. IB Gateway also runs on Windows — if host
  count/cost is a concern, both sessions could run on **one** Windows host
  under separate OS users/services (or separate VMs on one hypervisor),
  which cuts patching/monitoring surface in half while keeping the account
  boundary intact via OS-level isolation rather than hardware isolation.
  Conversely, if the two hosts exist for genuine reliability/compliance
  reasons (e.g. so an MT5-host outage never touches IB), that's a valid
  reason to keep them apart — but it should be a stated decision, not a
  default.
- **No failover per broker.** Each broker is still a single account on a
  single host with no standby — this design isolates failures *between*
  brokers, it doesn't add redundancy *within* either one. If MT5 or IB
  Gateway logs out or the host drops, that venue goes dark until someone
  intervenes; there's no secondary session to fail over to.
- **Scaling stays vertical, doubled.** IB already can't run more than one
  active session per `IB_CLIENT_ID`; MT5 has the same one-terminal-session
  constraint. So this topology doesn't just inherit the IB service's
  "vertical scaling only" ceiling, it applies it independently to a second
  broker — running two venues doesn't add throughput, it adds two more
  places a single stuck session can halt trading.

**Recommendation:** keep the two accounts logically separate (required),
but treat "separate hardware" as a choice to justify rather than a given —
decide it based on actual reliability/compliance needs rather than
defaulting to it. Whichever way that's decided, prioritize: (1) setting
`MT5_BRIDGE_SECRET` and enforcing it on the sidecar before relying on MT5
for anything beyond a lab test, (2) firewalling both the IB Gateway host and
the MT5 host to accept connections only from the app host, and (3) an
explicit liveness check + alert for both broker sessions — silent logout
on either host is currently indistinguishable from "no trading opportunity
today" until someone notices.

**Future considerations** (tracked, not yet scheduled — see
[`GAP_ANALYSIS.md` § Operational / Deployment Gaps](GAP_ANALYSIS.md#8-operational--deployment-gaps)
for the living version of this list):

- Implement the `X-MT5-Bridge-Secret` check on the sidecar itself (the
  `broker_service` side now sends it — see `MT5_BRIDGE_SECRET` above) or
  move to mTLS.
- Firewall the IB Gateway and MT5 hosts to accept connections only from the
  app host.
- Add a liveness check + alert for both broker sessions.
- Revisit whether IB Gateway and MT5 need separate hosts or can share one
  with OS-level isolation.

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
| `verify-timestamps` | Run `verify_timestamp_config.sh` against the running stack | Debug wrong-year / wrong-timezone bars |
| `clean` | Stop, remove project images and prune Docker | Reset before a fresh `deploy` |

> `tradingapp.sh config` / `env` **merge** into `.env`: `SERVER_IP`,
> `IB_HOST` and the `NEXT_PUBLIC_API_URL` / `CORS_ORIGINS` URLs derived
> from `SERVER_IP` are updated in place, and every other key (ports,
> Postgres/Redis credentials, and anything you've hand-added like
> `POSTGRES_HOST`, `API_TOKEN`, `BACKFILL_ENABLED`) is filled in only if
> missing — a hand-edited `.env` survives a re-run. Pass
> `--non-interactive` to skip the IB Gateway IP prompt (uses
> `DEFAULT_IB_HOST` unless `IB_HOST` is already exported), for scripted /
> CI installs.

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

# MT5 sidecar (optional second broker — see Multi-Broker Host Topology)
MT5_BRIDGE_URL=http://10.7.3.22:9100
MT5_BRIDGE_SECRET=<rotate-me>   # sidecar must enforce X-MT5-Bridge-Secret

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

## Real-time streaming (Phase 4)

The IB service runs an in-process `StreamingManager` that subscribes
to IB tick data (`reqMktData`) and publishes each tick to Redis on
`marketdata:tick:<SYMBOL>`. The backend opens a second Redis client in
subscribe-mode and forwards every tick to Socket.IO clients in the
`market-data:<SYMBOL>` room.

The end-to-end flow is:

```
IB Gateway ──reqMktData──▶ broker_service ──redis.publish──▶ Redis
                                                          │  pSUBSCRIBE
                                                          ▼
                              Socket.IO room ◀── backend StreamingBridge
                                    │
                                    ▼
                        frontend useRealtimeStream hook
                        (MSFTRealtimeChart, etc.)
```

Operational notes:

- **Per-symbol refcounting** lives in both the IB service and the
  backend so multiple browsers sharing a symbol only generate one
  IB-side subscription.
- **Subscriptions clean up on disconnect.** When a Socket.IO client
  drops, the backend bridge runs `releaseSocket()` which decrements
  every symbol it held and `cancelMktData`s anything that reaches
  refcount zero.
- **REST polling fallback** still works. The frontend seeds the price
  display with a one-shot `/api/market-data/realtime` call before the
  first tick arrives — useful when streaming is disabled or when
  Redis is briefly unreachable.
- **Turning it off:** set `STREAMING_ENABLED=false` in `.env` and the
  backend bridge will not connect to Redis. The chart falls back to
  one-shot REST calls (no live updates) and the rest of the app keeps
  working normally.
- **Diagnostics:**
    - Backend `/api/health` includes a `services.streaming` block
      (connected flag, per-symbol refcounts, ticks received /
      forwarded / dropped totals).
    - IB service `GET /market-data/stream/status` shows the same view
      from the publisher side.

## Data collection & retention (Phase 5)

The backend can keep the database topped up and pruned automatically,
driven by rows in the `data_collection_config` table. Both the backfill
worker and the retention cleanup read that table, so nothing happens
until you add rows to it.

### 1. Tell the backend what to collect

Insert a config row per `(contract, timeframe)` you want managed. The
contract must already exist in `contracts` (the schema seeds a few; the
*Download* page and contract search create more):

```sql
-- Collect MSFT 1-hour bars every 15 minutes, keep 365 days.
INSERT INTO data_collection_config
  (contract_id, timeframe, enabled, auto_collect, collection_interval_minutes, retention_days)
SELECT id, '1hour', true, true, 15, 365
FROM contracts
WHERE symbol = 'MSFT' AND sec_type = 'STK'
ON CONFLICT (contract_id, timeframe) DO UPDATE
  SET enabled = EXCLUDED.enabled,
      auto_collect = EXCLUDED.auto_collect,
      collection_interval_minutes = EXCLUDED.collection_interval_minutes,
      retention_days = EXCLUDED.retention_days;
```

- `auto_collect = true` → eligible for the backfill scheduler.
- `enabled = true` → eligible for retention cleanup (`retention_days`).
- `collection_interval_minutes` → minimum age before a row is refetched,
  so a fast global tick doesn't hammer IB for slow-moving data.

### 2. Enable the scheduler

The scheduler is **off by default** because it makes live IB requests on
a timer. Turn it on in `.env` and redeploy:

```bash
BACKFILL_ENABLED=true
BACKFILL_INTERVAL_MINUTES=15   # how often the scheduler ticks
BACKFILL_PERIOD=5D             # window fetched per run (any IB period)
BACKFILL_INITIAL_DELAY_MS=30000
```

```bash
./tradingapp.sh redeploy
```

Each pass fetches the recent window for every eligible row and upserts it
(existing bars update, new bars insert, holes inside the window
self-heal). It records a `data_collection_sessions` row per attempt and
per-day quality counts into `data_quality_metrics`.

### 3. Retention cleanup

Retention is enforced two ways:

- **TimescaleDB retention policy** (in the schema) drops whole chunks
  older than 2 years for `candlestick_data` and 30 days for `tick_data`.
- **`POST /api/market-data/database/clean`** deletes bars older than each
  config row's `retention_days` and returns the real number removed —
  use this for a tighter, per-symbol retention than the coarse global
  policy. Run it from cron against the authenticated endpoint.

### Diagnostics

```bash
# Scheduler state: enabled flag, last run, per-run totals.
curl -fs http://<server-ip>:4000/api/health | jq .services.backfill

# Per-symbol storage + average quality score.
curl -fs -H "Authorization: Bearer $API_TOKEN" \
  http://<server-ip>:4000/api/market-data/database/stats | jq
```

## Executions (fills) sync

Positions and P&L default to being inferred from **submitted orders** — what
the app asked a venue to trade, recorded in `order_audit`. That estimate
silently disagrees with the account on a partial fill, on a rejection that
lands after the acknowledgement, and on any trade placed outside the app.
Turning on the fills sync replaces the estimate with the venue's own execution
reports.

**Enable it if** you use a strategy's `risk.max_daily_loss` (the sync is its
P&L source — with the sync off, a declared cap fails *closed* and the run
places nothing), or you want `/api/account/executions` and `/api/account/pnl`
to report anything.

```bash
# .env
EXECUTIONS_SYNC_ENABLED=true
EXECUTIONS_SYNC_INTERVAL_SECONDS=120   # per-venue poll cadence (min 15)
EXECUTIONS_SYNC_LOOKBACK_DAYS=2        # window per poll (1-30)
EXECUTIONS_DEFAULT_ACCOUNT_MODE=paper  # for fills with no order of ours behind them
```

```bash
./tradingapp.sh redeploy
```

The poller reads every venue the app has traded at recently plus every venue
with a running strategy, so an unconfigured broker is never polled. The window
**overlaps on purpose** — a fill can be reported late, and IB delivers a fill's
commission on a callback separate from the fill itself, so re-reading is how
those converge. Rows upsert on `(broker, exec_id)`, so re-delivery never
duplicates.

> **IB timestamps.** IB reports execution times in the **Gateway's** timezone
> when it doesn't supply one on the wire. The service interprets those in
> `IB_TIMEZONE` (default `UTC`) — if your Gateway is not running in UTC, set
> `IB_TIMEZONE` to its actual zone or every fill will be stamped with the
> account's offset applied in the wrong direction.

### Diagnostics

```bash
# Poller state: enabled flag, last run, fetched / inserted / relinked totals.
curl -fs http://<server-ip>:4000/api/health | jq .services.executions

# Recorded fills, and today's realised P&L.
curl -fs -H "Authorization: Bearer $API_TOKEN" \
  "http://<server-ip>:4000/api/account/executions?limit=20" | jq
curl -fs -H "Authorization: Bearer $API_TOKEN" \
  http://<server-ip>:4000/api/account/pnl | jq

# Reconciliation: what the app believes it holds vs what the venue reports.
curl -fs -H "Authorization: Bearer $API_TOKEN" \
  "http://<server-ip>:4000/api/account/reconciliation?broker=ib" | jq
```

### Positions come from fills *plus* working orders

Once the sync is on, a position is the recorded fills **plus the unfilled
remainder of any still-working orders** — not one or the other. Fills alone lag
the poll interval, so a freshly-placed order would read as flat and a strategy
could re-enter a position it already holds; submitted orders alone cannot see a
partial fill. Both halves together mean an order moves from "in flight" to
"filled" without ever being double-counted or briefly invisible.

A **strategy run** sees only the exposure it created (fills carry the run id of
the signal behind them), so a second run on the same symbol, or a trade you
place by hand, cannot change what its sizing and pyramiding rules do.
`ORDER_MAX_POSITION` is the opposite by design: it caps *account* exposure at
the venue, so manual trades count toward it.

Per-run attribution can therefore drift from the account — a manual trade
belongs to no run, a corporate action to no order. `GET /api/account/reconciliation`
exists to surface that: it lists every symbol either side knows about with a
`matched` flag, so a divergence is something you can see rather than something
that quietly accumulates. Worth a periodic check (or a cron alert on
`.mismatches > 0`) on any account that is also traded by hand.

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
| MT5 requests return 501 | `MT5_BRIDGE_URL` is unset — expected until the MT5 sidecar host is deployed (see [Multi-Broker Host Topology](#multi-broker-host-topology-ib--mt5)) |
| MT5 requests return 503 | Sidecar unreachable — confirm the MT5 Windows host is up, the terminal is logged in, and the app host can reach `MT5_BRIDGE_URL` (firewall/VPN) |
| Alpaca/OANDA requests return 501 | Credentials unset — expected until `ALPACA_API_KEY`+`ALPACA_API_SECRET` or `OANDA_API_TOKEN`+`OANDA_ACCOUNT_ID` are both set (see [Alpaca and OANDA](#alpaca-and-oanda--optional-cloud-brokers)) |
| Alpaca/OANDA requests return 503 | The broker's API is unreachable from the app host — check outbound HTTPS / firewall rules |
| Database health check fails | Confirm `POSTGRES_HOST` is reachable from inside the backend container (`docker compose exec backend node -e "require('net').connect(5432,'$POSTGRES_HOST').on('connect',()=>console.log('ok'))"`) |
| Charts not loading | `./tradingapp.sh logs` for frontend errors, then `./tradingapp.sh redeploy` |

For a fuller list, see [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

## Production Setup

### Enabling live trading

The order-placement path (`POST /api/orders` → `POST /orders` on the IB
service) is gated by an env var that is **off by default**. Without it
the backend and the IB service both reject any `account_mode=live`
request with HTTP 403 — paper orders work, live orders don't.

To enable live trading:

1. Set on **both** services in your `.env`:

   ```bash
   LIVE_TRADING_ENABLED=true
   ```

2. Restart so both containers pick the new value up:

   ```bash
   ./tradingapp.sh redeploy
   ```

3. Verify the gate is fully open:

   ```bash
   curl -s -H "Authorization: Bearer $API_TOKEN" http://<host>:4000/api/orders/config | jq
   ```

   `live_trading_enabled` must be `true`. If only one side has the flag
   set, you'll see `backend_live_enabled` and `ib_live_enabled` disagree
   — fix that before sending any live order.

The `ORDER_MAX_QUANTITY` (default 100k) and `ORDER_MAX_PRICE` (default
$1M) caps are applied by the backend validator on every submission;
raise them only if your real-world order sizes exceed them. Every
attempt is persisted in `order_audit` (visible in the `/trade` blotter
and via `GET /api/orders/audit`).

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

### Health, logs, resources

```bash
# Service health
./tradingapp.sh status
./tradingapp.sh test

# Logs (structured JSON in non-TTY contexts — see Prometheus / Grafana below)
./tradingapp.sh logs           # last 20 lines per service
./tradingapp.sh logs follow    # stream all services

# Resource usage
docker stats
docker system df
```

### Prometheus / Grafana

Both the backend (Express + `prom-client`) and the IB service (FastAPI +
`prometheus_fastapi_instrumentator`) expose a `GET /metrics` endpoint
that returns the standard Prometheus text format. The backend endpoint
is on the auth allow-list so the scraper does not need a bearer token.

Minimal Prometheus scrape config:

```yaml
rule_files:
  - /etc/prometheus/alerts.yml   # ops/prometheus/alerts.yml (see below)

scrape_configs:
  - job_name: tradingapp-backend
    static_configs: [{ targets: ['backend:4000'] }]
    metrics_path: /metrics
  - job_name: tradingapp-broker_service
    static_configs: [{ targets: ['broker_service:8000'] }]
    metrics_path: /metrics
```

### Alerting rules

A ready-to-load rule file ships in
[`ops/prometheus/alerts.yml`](ops/prometheus/alerts.yml). Mount it into
the Prometheus container and reference it from `rule_files` (above). It
reuses the exact metrics and label conventions the Grafana dashboard
relies on, so each alert and its panel always agree. Rules cover:

- **`TradingAppTargetDown`** (critical) — either service's `/metrics` is
  unscrapeable for 2m.
- **`BackendHighErrorRate` / `IBServiceHighErrorRate`** (warning) — 5xx
  ratio above 5% over 5m.
- **`BackendHighLatencyP95` / `IBServiceHighLatencyP95`** (warning) — p95
  latency above 1s (backend) / 2s (IB service).
- **`BackendEventLoopLagHigh`** (warning) — Node event-loop p99 lag above
  200ms (main-thread blocking).
- **`IBServiceNoTraffic`** (info) — the IB service is up but has served no
  application traffic for 30m.

Thresholds are conservative starting points — tune them to your traffic.
Validate edits with `promtool check rules ops/prometheus/alerts.yml`.

A pre-built Grafana dashboard ships in
[`ops/grafana/tradingapp-dashboard.json`](ops/grafana/tradingapp-dashboard.json) —
three rows (Backend / IB Service / Process) covering request rate, p95
latency, error rate, persisted backtest runs and process metrics
(RSS, CPU, event-loop lag). Import via Grafana **Dashboards → New →
Import** and pick your Prometheus datasource for the `DS_PROMETHEUS`
template variable. The companion
[`ops/grafana/README.md`](ops/grafana/README.md) lists every metric the
panels rely on and where in the code it is emitted.

### Request correlation

Every backend response carries an `X-Request-Id` header (the value is
echoed back from the caller's request or minted as a uuid4 on the way
in). The same id is propagated into every backend → broker_service axios
hop, so a single grep across both services' structured logs reconstructs
the trace. The frontend `apiFetch` mints the id browser-side, so traces
start from the click.

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
