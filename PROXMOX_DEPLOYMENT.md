# Deploying TradingApp on a Bare-Metal Proxmox VE Host

End-to-end instructions for taking a machine with **nothing but Proxmox VE
freshly installed** to a running TradingApp deployment: application stack,
TimescaleDB database, broker session hosts, reverse proxy, monitoring and
backups.

**Guests are LXC containers** wherever the workload allows it — see
[§1.2](#12-why-lxc-and-the-two-places-it-costs-you) for what that requires and
the one component that cannot be a container.

This guide is the Proxmox-specific *wrapper* around
[`DEPLOYMENT.md`](DEPLOYMENT.md). Everything about the application itself —
env keys, auth, streaming, executions sync, alerting rules — lives there and
is cross-referenced rather than duplicated. Read this one to build the
infrastructure; read that one to run the app.

> **Scope note.** TradingApp places real orders. Every step below defaults to
> the safe setting (`LIVE_TRADING_ENABLED=false`, paper IB account,
> `ALPACA_PAPER=true`). Nothing here turns live trading on — see
> [`DEPLOYMENT.md` § Enabling live trading](DEPLOYMENT.md#enabling-live-trading)
> when you are ready for that, deliberately.

---

## Table of Contents

1. [Target topology](#1-target-topology)
2. [Plan the deployment](#2-plan-the-deployment)
3. [Proxmox host post-install](#3-proxmox-host-post-install)
4. [Create the app container](#4-create-the-app-container)
5. [Create the database container (TimescaleDB)](#5-create-the-database-container-timescaledb)
6. [Create the IB Gateway container](#6-create-the-ib-gateway-container)
7. [Optional: MT5 sidecar (must be a VM)](#7-optional-mt5-sidecar-must-be-a-vm)
8. [Deploy the application stack](#8-deploy-the-application-stack)
9. [Verify the deployment](#9-verify-the-deployment)
10. [Reverse proxy, TLS and firewalling](#10-reverse-proxy-tls-and-firewalling)
11. [Optional: monitoring container](#11-optional-monitoring-container)
12. [Backups and snapshots](#12-backups-and-snapshots)
13. [Boot order and auto-start](#13-boot-order-and-auto-start)
14. [Day-2 operations](#14-day-2-operations)
15. [Proxmox-specific troubleshooting](#15-proxmox-specific-troubleshooting)
16. [Appendix A: single-container quickstart](#appendix-a-single-container-quickstart)
17. [Appendix B: full deployment checklist](#appendix-b-full-deployment-checklist)

---

## 1. Target topology

### 1.1 The shape of it

TradingApp spans more than one host by design: the Docker stack is Linux, but
**IB Gateway and MetaTrader 5 are logged-in GUI sessions that cannot live
inside the Docker stack** (see
[`DEPLOYMENT.md` § Multi-Broker Host Topology](DEPLOYMENT.md#multi-broker-host-topology-ib--mt5)).
On Proxmox each becomes its own guest — an LXC container in every case except
MT5:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Proxmox VE host  (bare metal)                        vmbr0 → LAN         │
│                                                                          │
│  ┌────────────────────────┐   ┌────────────────────────┐                 │
│  │ CT 110  tradingapp-app │   │ CT 120  tradingapp-db  │                 │
│  │ LXC · Ubuntu + Docker  │──▶│ LXC · Ubuntu           │                 │
│  │  frontend      :3000   │   │ PostgreSQL+TimescaleDB │                 │
│  │  backend       :4000   │   │                  :5432 │                 │
│  │  broker_service:8000   │   └────────────────────────┘                 │
│  │  redis         :6379   │                                              │
│  │  nginx      :80/:443   │   ┌────────────────────────┐                 │
│  └───────────┬────────────┘   │ CT 130  ib-gateway     │                 │
│              │                │ LXC · IB Gateway + IBC │                 │
│              ├───────────────▶│ headless X, API :4002  │                 │
│              │                └────────────────────────┘                 │
│              │                                                           │
│              │                ┌────────────────────────┐  (optional)     │
│              ├───────────────▶│ VM 140  mt5-bridge     │  ← must be a VM │
│              │                │ Windows + MT5 + sidecar│                 │
│              │                └────────────────────────┘                 │
│              │                                                           │
│              │                ┌────────────────────────┐  (optional)     │
│              └───────────────▶│ CT 150  monitoring     │                 │
│                               │ LXC · Prometheus+Grafana│                │
│                               └────────────────────────┘                 │
└──────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Why LXC, and the two places it costs you

Containers share the host kernel, so they boot in seconds, carry no guest-OS
memory overhead, and `pct enter` beats waiting on a console. For four
long-lived Linux services on one hypervisor, that is a real density and
operability win.

Two consequences you have to design around rather than discover later:

**1. MT5 cannot be a container.** LXC guests share the host's Linux kernel, so
a Proxmox container is always Linux. The `MetaTrader5` Python package is
Windows-only and needs a live terminal, so the MT5 sidecar stays a full VM
(§7). If you don't trade MT5, every guest in this guide is an LXC.

**2. Docker-in-LXC needs specific container features.** The app container runs
a Docker Compose stack, which is nesting containers inside a container. It
works well on current Proxmox, but only with the right flags set **at create
time**:

| Requirement | Why |
|---|---|
| `--features nesting=1` | Lets the container run its own container runtime and systemd cleanly |
| `--features keyctl=1` | containerd uses the kernel keyring; without it Docker fails to start |
| `--unprivileged 1` | Keep it. A privileged container with nesting is close to root on the hypervisor |
| Storage-driver choice | `overlay2` works on **LVM-thin / ext4-backed** rootfs. On **ZFS-backed** rootfs it does not — add `fuse=1` and switch Docker to `fuse-overlayfs` (§4.2) |

Check which case you are in before creating anything:

```bash
pvesm status        # look at the Type column for your container storage
```

`lvmthin` or `dir` → nothing extra to do. `zfspool` → you will need the
`fuse-overlayfs` step in §4.2.

The security trade is worth stating plainly since it applies to the host that
holds your broker credentials: an unprivileged LXC is a solid boundary, but it
is a shared-kernel boundary, not a hardware-virtualised one, and a host kernel
update reboots every container at once. If that is unacceptable for the app
container specifically, it is the one guest worth making a VM — the rest of
this guide is unaffected either way.

**Minimum viable variant:** if you only have resources for one guest, see
[Appendix A](#appendix-a-single-container-quickstart) — one container, bundled
TimescaleDB via `--with-db`, an external IB Gateway elsewhere on the network.

---

## 2. Plan the deployment

Fill this table in **before** you create anything. Every later step refers
back to it, and the app's `.env` hard-codes several of these addresses.

| ID | Name | Type | Purpose | Cores | RAM | Disk | IP |
|---|---|---|---|---|---|---|---|
| 110 | `tradingapp-app` | **LXC** | Docker stack + nginx | 4 | 8 GB | 60 GB | `10.7.3.20` |
| 120 | `tradingapp-db` | **LXC** | PostgreSQL + TimescaleDB | 4 | 8 GB | 32 GB + 200 GB mp | `10.7.3.21` |
| 130 | `ib-gateway` | **LXC** | IB Gateway session (headless X) | 2 | 4 GB | 40 GB | `10.7.3.22` |
| 140 | `mt5-bridge` *(opt)* | **VM** | Windows + MT5 + sidecar | 2 | 4 GB | 80 GB | `10.7.3.23` |
| 150 | `monitoring` *(opt)* | **LXC** | Prometheus + Grafana | 2 | 2 GB | 40 GB | `10.7.3.24` |

Also decide:

- **Gateway / DNS**: e.g. `10.7.3.1` / `10.7.3.1`.
- **Domain** (if using TLS): e.g. `trading.example.com` → `10.7.3.20`.
- **Database sizing**: `candlestick_data` and `tick_data` are TimescaleDB
  hypertables with retention policies (2 years OHLCV, 30 days ticks — see
  [`backend/src/database/timescaledb-schema.sql`](backend/src/database/timescaledb-schema.sql)).
  The DB container gets a **separate 200 GB mount point** for the data
  directory (§5.1) so it can be grown, snapshotted and restored independently
  of the container's root filesystem. Tick data across many symbols grows
  fast — put that mount point on a pool you can expand.
- **LXC memory is a hard cgroup limit**, not a balloon. The container does not
  give memory back and does not gracefully degrade: overshoot and the kernel
  OOM-kills a process inside it. Size generously and keep swap small.

> ⚠️ **Subnet collision.** The Compose stack creates a bridge network on
> **`172.20.0.0/16`** with static container IPs (`docker-compose.yml`). If your
> LAN, VPN or another Proxmox bridge uses any part of `172.20.0.0/16`, the app
> container will lose routes to it. Pick a different LAN range, or edit the
> `networks.tradingapp-network.ipam` block **and** the hard-coded
> `172.20.0.x` addresses in `docker-compose.yml` / `docker-compose.db.yml`
> together — they must stay consistent.

---

## 3. Proxmox host post-install

Do all of this in the Proxmox web UI shell (`https://<pve-ip>:8006` → node →
**Shell**) or over SSH as `root`.

### 3.1 Confirm the install

```bash
pveversion -v | head -3
ip -br addr        # vmbr0 should hold the host's LAN IP
pvesm status       # note the Type column — see §1.2 for why it matters
```

### 3.2 Switch to the no-subscription repository

A fresh install points at the enterprise repo, which 401s without a
subscription key and blocks all updates. **Proxmox VE 9** uses deb822
`.sources` files; **VE 8** uses classic `.list` files. Run the block that
matches your version.

<details>
<summary><b>Proxmox VE 9.x</b></summary>

```bash
# Disable enterprise repos
sed -i 's/^Enabled: true/Enabled: false/' /etc/apt/sources.list.d/pve-enterprise.sources
sed -i 's/^Enabled: true/Enabled: false/' /etc/apt/sources.list.d/ceph.sources 2>/dev/null || true

# Enable no-subscription
cat > /etc/apt/sources.list.d/pve-no-subscription.sources <<'EOF'
Types: deb
URIs: http://download.proxmox.com/debian/pve
Suites: trixie
Components: pve-no-subscription
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
EOF
```
</details>

<details>
<summary><b>Proxmox VE 8.x</b></summary>

```bash
# Disable enterprise repos
sed -i 's/^deb/#deb/' /etc/apt/sources.list.d/pve-enterprise.list
sed -i 's/^deb/#deb/' /etc/apt/sources.list.d/ceph.list 2>/dev/null || true

# Enable no-subscription
echo "deb http://download.proxmox.com/debian/pve bookworm pve-no-subscription" \
  > /etc/apt/sources.list.d/pve-no-subscription.list
```
</details>

Then update and reboot into the new kernel:

```bash
apt update && apt full-upgrade -y
apt install -y chrony
reboot
```

> Because every container shares this kernel, **a host kernel upgrade restarts
> the entire deployment**. Do it during a market close, not mid-session. This
> is the operational cost of the all-LXC topology, and it is the main reason
> §13's boot ordering has to actually work.

### 3.3 Time synchronisation (not optional, and host-only)

Every bar, tick and fill in this system is timestamped, the whole stack runs
in **UTC** (`TZ=UTC` on every Docker container), and IB rejects or mislabels
data when the client clock drifts.

LXC guests **cannot set their own clock** — they read the host's. That is a
simplification, not a limitation: fix it once here and every container is
correct. Do not install chrony or NTP inside the containers; it will fail or,
worse, appear to work.

```bash
timedatectl set-timezone UTC
systemctl enable --now chrony
chronyc tracking | grep -E 'Reference ID|System time'
```

Only the Windows MT5 VM (§7), if you deploy one, needs its own time source.

### 3.4 Fetch the container templates

```bash
pveam update
pveam available --section system | grep ubuntu-24
pveam download local ubuntu-24.04-standard_24.04-2_amd64.tar.zst
```

Adjust the template filename to whatever `pveam available` currently lists —
the point release moves.

If you plan the optional **Windows MT5 VM**, also upload a Windows ISO plus
the **VirtIO driver ISO**
(<https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso>)
via **Datacenter → local → ISO Images → Upload**.

### 3.5 Create an SSH key for the guests

On your workstation, if you don't already have one:

```bash
ssh-keygen -t ed25519 -C "tradingapp"
ssh-copy-id root@<pve-ip>          # convenience: reach the host without a password
scp ~/.ssh/id_ed25519.pub root@<pve-ip>:/root/tradingapp.pub
```

`pct create --ssh-public-keys` injects this into the container's `root`
account, so you can SSH straight in without setting a root password.

---

## 4. Create the app container

CT 110 runs the whole Docker Compose stack — `frontend`, `backend`,
`broker_service`, `redis` — plus nginx as the TLS front door in §10.

### 4.1 Create it

Run on the Proxmox host. Substitute your container storage for `local-lvm`
(`pvesm status`; ZFS installs typically use `local-zfs`).

```bash
CTID=110
STORAGE=local-lvm
TEMPLATE=local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst

pct create $CTID $TEMPLATE \
  --hostname tradingapp-app \
  --cores 4 --memory 8192 --swap 1024 \
  --rootfs $STORAGE:60 \
  --net0 name=eth0,bridge=vmbr0,firewall=1,ip=10.7.3.20/24,gw=10.7.3.1 \
  --nameserver 10.7.3.1 --searchdomain lan \
  --features nesting=1,keyctl=1 \
  --unprivileged 1 \
  --ssh-public-keys /root/tradingapp.pub \
  --onboot 1 --startup order=2,up=30 \
  --start 1
```

On **ZFS-backed** storage, add `fuse=1` to the features list (see §4.2):

```bash
pct set $CTID --features nesting=1,keyctl=1,fuse=1
```

The three flags that matter, restated because getting them wrong produces
confusing failures much later: `nesting=1` (Docker won't start without it),
`keyctl=1` (containerd's keyring access), `firewall=1` on `net0` (the Proxmox
per-guest firewall in §10.3 is inert on an interface that lacks it).

`--swap 1024` keeps a small cushion. Don't set it large: swapping inside a
container that is meant to serve real-time ticks trades a visible failure for
an invisible latency problem.

### 4.2 Install Docker

```bash
pct enter 110
```

Inside the container:

```bash
apt update && apt full-upgrade -y
apt install -y git curl ca-certificates
ln -sf /usr/share/zoneinfo/UTC /etc/localtime      # timezone; the clock itself is the host's
```

**If your container storage is ZFS**, install the fuse-overlayfs driver
*before* Docker starts for the first time — Docker will otherwise pick an
unusable driver and cache that decision:

```bash
apt install -y fuse-overlayfs
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{ "storage-driver": "fuse-overlayfs" }
EOF
```

Now install Docker:

```bash
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
docker info | grep -E 'Storage Driver|Cgroup'
docker run --rm hello-world
```

`hello-world` succeeding is the real gate on the whole LXC approach. If it
fails, fix it here — §15 has the common causes — rather than continuing and
debugging it through the application stack.

### 4.3 Create the deploy user

`tradingapp.sh` **refuses to run as root** and requires sudo. A container drops
you into a root shell, so create the user explicitly:

```bash
apt install -y sudo
adduser --disabled-password --gecos "" tradingapp
usermod -aG sudo,docker tradingapp
echo 'tradingapp ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/tradingapp
chmod 440 /etc/sudoers.d/tradingapp

# Give it your SSH key so you can reach it directly
mkdir -p /home/tradingapp/.ssh
cp /root/.ssh/authorized_keys /home/tradingapp/.ssh/
chown -R tradingapp:tradingapp /home/tradingapp/.ssh
chmod 700 /home/tradingapp/.ssh && chmod 600 /home/tradingapp/.ssh/authorized_keys
```

Exit the container console and confirm the path you'll actually use:

```bash
exit
ssh tradingapp@10.7.3.20
docker ps        # must work without sudo
```

---

## 5. Create the database container (TimescaleDB)

The base `docker-compose.yml` deliberately does **not** provision Postgres —
the backend expects an external instance
([`DEPLOYMENT.md` § External database](DEPLOYMENT.md#external-database-recommended-for-production)).
Here that instance is its own container, which keeps the database's disk,
snapshot schedule and restore path independent of the application's.

> **Shortcut:** to skip this section, deploy with
> `./tradingapp.sh deploy --with-db`, which layers `docker-compose.db.yml` and
> runs TimescaleDB as a Docker container inside CT 110 with a Docker volume.
> Fine for evaluation. Not recommended otherwise: the data then shares a fate,
> a disk and a backup window with the application, and `./tradingapp.sh clean`
> prunes aggressively next to it.

### 5.1 Create it, with a separate data volume

No nesting or keyctl here — Postgres runs directly in the container, so this
is a plain unprivileged LXC.

```bash
CTID=120
STORAGE=local-lvm

pct create $CTID local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst \
  --hostname tradingapp-db \
  --cores 4 --memory 8192 --swap 1024 \
  --rootfs $STORAGE:32 \
  --mp0 $STORAGE:200,mp=/var/lib/postgresql,backup=1 \
  --net0 name=eth0,bridge=vmbr0,firewall=1,ip=10.7.3.21/24,gw=10.7.3.1 \
  --nameserver 10.7.3.1 --searchdomain lan \
  --unprivileged 1 \
  --ssh-public-keys /root/tradingapp.pub \
  --onboot 1 --startup order=1,up=60 \
  --start 1
```

`--mp0` puts the PostgreSQL data directory on its own 200 GB volume, mounted
at `/var/lib/postgresql` before Postgres is installed so the packages lay
their data down in the right place from the start. `backup=1` includes it in
vzdump runs. Grow it later without touching the rest:

```bash
pct resize 120 mp0 +100G
```

`--startup order=1,up=60` starts the database first on host boot and waits 60s
before releasing the next order group, so the app container (order 2) never
comes up against a database that isn't listening yet.

### 5.2 Install PostgreSQL + TimescaleDB

```bash
pct enter 120
```

```bash
apt update && apt full-upgrade -y
ln -sf /usr/share/zoneinfo/UTC /etc/localtime
apt install -y gnupg postgresql-common apt-transport-https lsb-release wget sudo

# PostgreSQL APT repository (PGDG)
/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y

# TimescaleDB repository
echo "deb https://packagecloud.io/timescale/timescaledb/ubuntu/ $(lsb_release -cs) main" \
  > /etc/apt/sources.list.d/timescaledb.list
wget --quiet -O - https://packagecloud.io/timescale/timescaledb/gpgkey \
  | gpg --dearmor > /etc/apt/trusted.gpg.d/timescaledb.gpg

apt update
apt install -y timescaledb-2-postgresql-17 postgresql-client-17
```

PostgreSQL 15, 16 and 17 are all supported by the schema (the bundled
container image is pg15; nothing in `timescaledb-schema.sql` is
version-specific). Pick 17 for a new build.

```bash
timescaledb-tune --quiet --yes    # sizes shared_buffers/work_mem, adds the preload
systemctl restart postgresql
```

> `timescaledb-tune` reads the memory the container reports. Proxmox mounts
> lxcfs, so `/proc/meminfo` inside the container shows the **cgroup limit**
> (8 GB), not the host's total — the tuning it produces is correct. Verify
> with `free -h` before trusting it; if that shows the host's full RAM, lxcfs
> isn't mounted and you must pass `--memory 8GB` to `timescaledb-tune`
> manually, or it will size Postgres for memory the container cannot have.

### 5.3 Create the role, database and schema

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE tradingapp WITH LOGIN PASSWORD 'REPLACE_WITH_A_STRONG_PASSWORD';
CREATE DATABASE tradingapp OWNER tradingapp;
SQL

sudo -u postgres psql -d tradingapp -c 'CREATE EXTENSION IF NOT EXISTS timescaledb;'
```

Generate the password with `openssl rand -base64 24` and record it — it goes
into the app container's `.env` as `POSTGRES_PASSWORD` in §8.2.

Apply the canonical schema from the app container once the repo is cloned
(§8.1):

```bash
# On CT 110, as the tradingapp user
PGPASSWORD='<the password>' psql \
  "host=10.7.3.21 port=5432 user=tradingapp dbname=tradingapp sslmode=disable" \
  -f /opt/tradingapp/backend/src/database/timescaledb-schema.sql
```

The script is idempotent — re-running it on an existing database is safe.
Verify:

```bash
PGPASSWORD='<the password>' psql "host=10.7.3.21 user=tradingapp dbname=tradingapp" \
  -c "SELECT extname FROM pg_extension WHERE extname='timescaledb';" \
  -c "SELECT hypertable_name FROM timescaledb_information.hypertables;"
```

You should see the `timescaledb` extension plus the `candlestick_data` and
`tick_data` hypertables.

### 5.4 Let the app container connect

Postgres listens on localhost by default. Open it to CT 110 — and **only**
CT 110:

```bash
# /etc/postgresql/17/main/postgresql.conf
sed -i "s/^#\?listen_addresses.*/listen_addresses = '10.7.3.21'/" \
  /etc/postgresql/17/main/postgresql.conf

# /etc/postgresql/17/main/pg_hba.conf — single host, scram auth
echo "host    tradingapp    tradingapp    10.7.3.20/32    scram-sha-256" \
  >> /etc/postgresql/17/main/pg_hba.conf

systemctl restart postgresql
```

Then firewall the container. Both layers are worth having — ufw inside, and
the Proxmox host-side rules from §10.3:

```bash
apt install -y ufw
ufw allow from 10.7.3.0/24 to any port 22 proto tcp
ufw allow from 10.7.3.20 to any port 5432 proto tcp
ufw --force enable
```

> ufw inside an **unprivileged** LXC works on current Proxmox but depends on
> the host's netfilter modules and can be blocked by the container's AppArmor
> profile. If `ufw enable` errors, don't fight it — the Proxmox per-guest
> firewall (§10.3) is enforced host-side at the container's network interface,
> covers the same ground, and cannot be bypassed from inside the guest.

**TLS between app and DB:** the example sets `sslmode=disable` /
`POSTGRES_SSL=false` because both containers sit on one hypervisor bridge. If
the DB ever moves off-host, generate a server certificate, set `ssl = on` in
`postgresql.conf`, change the `pg_hba.conf` line to `hostssl`, and set
`POSTGRES_SSL=true` in `.env`.

---

## 6. Create the IB Gateway container

`broker_service` connects **outbound** to IB Gateway's socket API. IB Gateway
is a Java GUI application that must stay logged in — it is the single most
fragile part of this deployment, and it gets its own guest with its own
snapshot schedule.

It runs happily in an LXC container, with one adjustment: a container has no
Proxmox graphical console (`pct enter` is a text shell), so the GUI is driven
by a **virtual framebuffer plus VNC** for the one-time configuration, and by
**IBC** (<https://github.com/IbcAlpha/IBC>) for automated login and daily
restarts thereafter.

### 6.1 Create it

```bash
CTID=130
STORAGE=local-lvm

pct create $CTID local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst \
  --hostname ib-gateway \
  --cores 2 --memory 4096 --swap 1024 \
  --rootfs $STORAGE:40 \
  --net0 name=eth0,bridge=vmbr0,firewall=1,ip=10.7.3.22/24,gw=10.7.3.1 \
  --nameserver 10.7.3.1 --searchdomain lan \
  --features nesting=1 \
  --unprivileged 1 \
  --ssh-public-keys /root/tradingapp.pub \
  --onboot 1 --startup order=1,up=30 \
  --start 1
```

`nesting=1` here is for systemd, not Docker — the IBC service unit and the
framebuffer both behave better with it.

### 6.2 Install IB Gateway headlessly

```bash
pct enter 130
```

```bash
apt update && apt full-upgrade -y
ln -sf /usr/share/zoneinfo/UTC /etc/localtime
apt install -y wget unzip xvfb x11vnc xterm libxtst6 libxrender1 libxi6 fontconfig

# IB Gateway (stable standalone, bundled JRE)
wget -O /tmp/ibgw.sh \
  https://download2.interactivebrokers.com/installers/ibgateway/stable-standalone/ibgateway-stable-standalone-linux-x64.sh
chmod +x /tmp/ibgw.sh && /tmp/ibgw.sh -q     # installs to ~/Jts

# IBC — automates login and the daily restart
mkdir -p /opt/ibc && cd /opt/ibc
wget -O IBCLinux.zip https://github.com/IbcAlpha/IBC/releases/latest/download/IBCLinux-3.20.0.zip
unzip -o IBCLinux.zip && chmod +x *.sh scripts/*.sh
```

Check the IBC releases page for the current version — the filename above
pins one, and a stale link 404s.

### 6.3 One-time GUI configuration over VNC

Start a framebuffer and a VNC server bound to localhost, then reach it through
an SSH tunnel — never expose VNC to the LAN:

```bash
# In the container
Xvfb :1 -screen 0 1280x900x24 &
DISPLAY=:1 ~/Jts/ibgateway/*/ibgateway &
DISPLAY=:1 x11vnc -localhost -nopw -display :1 -forever &
```

```bash
# On your workstation
ssh -L 5900:localhost:5900 root@10.7.3.22
# then point any VNC client at localhost:5900
```

In the IB Gateway window:

1. Log in with your **paper** account first.
2. `Configure → Settings → API → Settings`:
   - ✅ **Enable ActiveX and Socket Clients**
   - ❌ **Read-Only API** (uncheck only when you intend to place orders)
   - **Socket port**: `4002` (paper) or `4001` (live)
   - **Trusted IPs**: add `10.7.3.20` (the app container)
3. Apply, OK. The settings persist in `~/Jts`, so this is a one-time step.

Kill the temporary processes (`pkill x11vnc; pkill -f ibgateway; pkill Xvfb`)
once you're done — the permanent service in §6.4 starts its own.

### 6.4 Run it as a service under IBC

Put your credentials and `TradingMode=paper` into `/opt/ibc/config.ini`
(the file is commented throughout; the login settings are near the top), then:

```ini
# /etc/systemd/system/ibgateway.service
[Unit]
Description=IB Gateway (IBC)
After=network-online.target

[Service]
Type=simple
Environment=DISPLAY=:1
ExecStartPre=/usr/bin/Xvfb :1 -screen 0 1280x900x24
ExecStart=/opt/ibc/gatewaystart.sh
Restart=always
RestartSec=30
User=root

[Install]
WantedBy=multi-user.target
```

`ExecStartPre` with a long-running `Xvfb` blocks — use `xvfb-run` in
`ExecStart` instead if you prefer a single process:
`ExecStart=/usr/bin/xvfb-run -n 1 -s "-screen 0 1280x900x24" /opt/ibc/gatewaystart.sh`.

```bash
systemctl daemon-reload && systemctl enable --now ibgateway
systemctl status ibgateway
ss -ltnp | grep 4002        # the API socket should be listening
```

`./tradingapp.sh ib-help` (on the app container, after §8) prints the IB-side
walk-through with your actual `.env` values substituted.

### 6.5 Firewall

The IB socket API has no authentication beyond the trusted-IP list:

```bash
ufw allow from 10.7.3.0/24 to any port 22 proto tcp
ufw allow from 10.7.3.20 to any port 4002 proto tcp
ufw --force enable
```

Back it with a Proxmox rule (§10.3) — that one cannot be bypassed from inside
the guest.

> **Known operational gap.** A silently logged-out IB Gateway is
> indistinguishable from a quiet market — the app just stops receiving data.
> IBC's auto-restart helps; add a liveness check on top.
> `./tradingapp.sh test` covers it manually and `ops/prometheus/alerts.yml`
> has the scrape-level alerts. Tracked in
> [`GAP_ANALYSIS.md`](GAP_ANALYSIS.md#8-operational--deployment-gaps).

---

## 7. Optional: MT5 sidecar (must be a VM)

Skip this entirely unless you trade MetaTrader 5.

**This is the one guest that cannot be an LXC container.** Proxmox containers
share the host's Linux kernel, so they can only ever run Linux. The
`MetaTrader5` Python package is Windows-only and requires a live MT5 terminal,
so this component is a full hardware-virtualised VM or it doesn't exist. There
is no container workaround.

The FastAPI sidecar that `broker_service` calls is not in this repository —
you build it against the contract documented in
[`broker_service/mt5_adapter.py`](broker_service/mt5_adapter.py) (`/health`,
`/symbols`, `/history`, `/quote`, `/tick`, `/orders`, `/positions`,
`/account`).

```bash
qm create 140 \
  --name mt5-bridge \
  --memory 4096 --balloon 0 --cores 2 --cpu host \
  --net0 virtio,bridge=vmbr0,firewall=1 \
  --scsihw virtio-scsi-single --scsi0 local-lvm:80,discard=on,ssd=1 \
  --ide2 local:iso/Win11.iso,media=cdrom \
  --ide3 local:iso/virtio-win.iso,media=cdrom \
  --ostype win11 --agent enabled=1 \
  --bios ovmf --efidisk0 local-lvm:1,efitype=4m,pre-enrolled-keys=1 \
  --tpmstate0 local-lvm:1,version=v2.0 \
  --boot order='ide2;scsi0' --onboot 1 --startup order=1
qm start 140
```

Load the VirtIO SCSI driver from the second CD when the Windows installer
reports it cannot find a disk, and install `qemu-guest-agent` from the same
ISO afterwards. Unlike the containers, this guest needs **its own NTP
configuration** — it does not inherit the host clock.

Then in `.env` on the app container:

```bash
MT5_BRIDGE_URL=http://10.7.3.23:9100
MT5_BRIDGE_SECRET=<openssl rand -hex 32>
```

`broker_service` sends `X-MT5-Bridge-Secret` on every request when that is
set — **the sidecar must reject requests that don't carry the right value.**
Until it does, anything that can reach port 9100 can trade the account. Scope
the Windows firewall rule for 9100 to `10.7.3.20` only.

Alpaca and OANDA need no guest at all — they are cloud REST APIs, enabled by
setting credentials in `.env`
([`DEPLOYMENT.md` § Alpaca and OANDA](DEPLOYMENT.md#alpaca-and-oanda--optional-cloud-brokers)).

---

## 8. Deploy the application stack

Everything from here runs **inside CT 110** as the `tradingapp` user created
in §4.3.

### 8.1 Clone

```bash
ssh tradingapp@10.7.3.20

sudo mkdir -p /opt/tradingapp && sudo chown tradingapp:tradingapp /opt/tradingapp
git clone https://github.com/41agent41/tradingapp.git /opt/tradingapp
cd /opt/tradingapp
chmod +x tradingapp.sh

# Docker is already installed (§4.2), so this just writes the baseline .env
./tradingapp.sh setup
```

When prompted for the IB Gateway IP, answer `10.7.3.22`. `setup` detects the
existing Docker install and skips it — which is why §4.2 installed Docker by
hand: the script's installer assumes a normal host, and doing it manually let
us make the ZFS storage-driver decision before Docker's first start.

### 8.2 Write the real `.env`

`./tradingapp.sh setup` writes a *baseline* `.env` — correct IPs and ports,
but placeholder database credentials and **no** API token. Fill in the rest by
hand. `config` and `env` re-runs preserve hand-edited keys, so this survives
future reconfiguration.

Generate the secrets first:

```bash
openssl rand -hex 32   # API_TOKEN (and NEXT_PUBLIC_API_TOKEN — same value)
openssl rand -hex 32   # JWT_SECRET
openssl rand -hex 32   # SESSION_SECRET
```

Then `nano .env` so the important keys read:

```bash
# --- Host / network -------------------------------------------------
NODE_ENV=production
TZ=UTC
SERVER_IP=10.7.3.20
NEXT_PUBLIC_API_URL=http://10.7.3.20:4000     # https://trading.example.com/api once §10 is done
CORS_ORIGINS=http://10.7.3.20:3000            # exact browser origin(s), never *

# --- Auth (both must be identical) ----------------------------------
API_TOKEN=<the 64-char hex you generated>
NEXT_PUBLIC_API_TOKEN=<same value>
JWT_SECRET=<a different 64-char hex>
SESSION_SECRET=<a third 64-char hex>

# --- Database (CT 120) ----------------------------------------------
POSTGRES_HOST=10.7.3.21
POSTGRES_PORT=5432
POSTGRES_USER=tradingapp
POSTGRES_PASSWORD=<the password from §5.3>
POSTGRES_DB=tradingapp
POSTGRES_SSL=false          # true if you enabled hostssl in §5.4

# --- IB Gateway (CT 130) --------------------------------------------
IB_HOST=10.7.3.22
IB_PORT=4002                # 4001 = live
IB_CLIENT_ID=1
IB_TIMEOUT=30

# --- Safety rails: leave these off for the first deploy --------------
LIVE_TRADING_ENABLED=false
BACKFILL_ENABLED=false
EXECUTIONS_SYNC_ENABLED=false
SYSTEMATIC_ENABLED=false
SYSTEMATIC_EXECUTION_ENABLED=false
```

[`.env.example`](.env.example) documents every remaining key with inline
commentary — read it once before you go to production.

Two things that catch people out:

- **`NEXT_PUBLIC_*` values are baked into the frontend bundle at build time.**
  Changing `NEXT_PUBLIC_API_URL` or `NEXT_PUBLIC_API_TOKEN` requires
  `./tradingapp.sh redeploy`, not `restart`.
- **An empty `API_TOKEN` disables auth entirely** (the backend prints a loud
  startup warning). On a container reachable from your LAN, that is an open
  trading API. Set it before the first deploy, not after.

Lock the file down — it holds your database password, API token and, later,
broker credentials:

```bash
chmod 600 .env
```

Now apply the database schema (§5.3) if you haven't yet — the file is on disk
here.

### 8.3 Deploy

```bash
./tradingapp.sh deploy
```

The first build compiles the Next.js frontend and installs the Python and Node
dependency trees — expect 3–8 minutes. Subsequent `redeploy`s are faster.

If you chose the bundled database instead of CT 120, use
`./tradingapp.sh deploy --with-db` — the choice is remembered for later
commands (`--no-db` reverses it).

---

## 9. Verify the deployment

```bash
./tradingapp.sh status      # container states
./tradingapp.sh test        # frontend, backend, broker service, IB reachability
./tradingapp.sh diagnose    # the above plus Docker/env/container detail
```

Then check each layer directly:

```bash
# Frontend
curl -I http://10.7.3.20:3000

# Backend health (no auth required on this route)
curl -fs http://10.7.3.20:4000/api/health | jq

# Database health — proves CT 110 → CT 120 works
curl -fs http://10.7.3.20:4000/api/database/health | jq

# Broker service → IB Gateway
curl -fs http://10.7.3.20:8000/health | jq

# An authenticated route — proves API_TOKEN matches
curl -fs -H "Authorization: Bearer $API_TOKEN" \
  http://10.7.3.20:4000/api/orders/config | jq
```

Finally open `http://10.7.3.20:3000` in a browser and confirm a chart renders
with live data. `./tradingapp.sh verify-timestamps` checks the timezone chain
end to end if bars land on the wrong day or year.

Snapshot every container at this point — a known-good baseline is worth more
than any amount of documentation, and LXC snapshots are near-instant on
LVM-thin and ZFS:

```bash
# On the Proxmox host
pct snapshot 120 clean-install --description "TimescaleDB + schema applied"
pct snapshot 130 clean-install --description "IB Gateway configured, IBC running"
pct snapshot 110 clean-deploy  --description "First green deploy"
```

> Container snapshots require snapshot-capable storage (LVM-thin, ZFS, btrfs,
> Ceph). On plain **directory** storage `pct snapshot` fails — which is a good
> reason not to put these containers there.

---

## 10. Reverse proxy, TLS and firewalling

The raw ports serve plain HTTP and the bearer token travels in a header — on
anything beyond an isolated lab network, put TLS in front.

### 10.1 nginx in the app container

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo nano /etc/nginx/sites-available/tradingapp
```

```nginx
server {
    listen 80;
    server_name trading.example.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name trading.example.com;

    ssl_certificate     /etc/letsencrypt/live/trading.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/trading.example.com/privkey.pem;

    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    location /     { proxy_pass http://127.0.0.1:3000; }
    location /api/ { proxy_pass http://127.0.0.1:4000; }

    # Socket.IO — the real-time tick stream needs the upgrade headers
    location /socket.io/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/tradingapp /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d trading.example.com
```

Then update `.env` to the public origin and **rebuild** (the frontend bundle
embeds the API URL):

```bash
NEXT_PUBLIC_API_URL=https://trading.example.com/api
CORS_ORIGINS=https://trading.example.com
```

```bash
./tradingapp.sh redeploy
```

### 10.2 Why in-guest firewalling isn't enough here

Docker publishes ports by writing its own `iptables` rules, which are
evaluated before ufw's `INPUT` chain. Ports 3000, 4000, 8000 and **6379**
stay reachable from the LAN even with ufw enabled inside CT 110. Redis in the
base compose file has **no password** — an open 6379 is a full read/write
handle on your cache and streaming bus, and 8000 is the broker service, which
talks to your broker.

In an unprivileged container this is worse than on a VM: ufw's own operation
depends on host netfilter and the container's AppArmor profile, so it is not
even guaranteed to load. Filter at the hypervisor instead — §10.3 — where the
rules are enforced host-side and nothing inside the guest can bypass them.

### 10.3 Proxmox-level firewall (the authoritative layer)

Proxmox filters at the guest's network interface, on the host, before packets
reach Docker's rules. This works identically for containers and VMs, with one
container-specific prerequisite: **the interface must carry `firewall=1`**,
which the `pct create` commands above already set. Confirm:

```bash
pct config 110 | grep net0    # must contain firewall=1
```

Enable the firewall at **Datacenter → Firewall**, then per guest at
**CT → Firewall → Options → Firewall: Yes**. From the shell:

```bash
# /etc/pve/firewall/cluster.fw — datacenter-wide
cat >> /etc/pve/firewall/cluster.fw <<'EOF'
[OPTIONS]
enable: 1

[RULES]
IN ACCEPT -source 10.7.3.0/24 -p tcp -dport 8006 -log nolog   # Proxmox UI
IN ACCEPT -source 10.7.3.0/24 -p tcp -dport 22   -log nolog   # SSH
EOF
```

```bash
# /etc/pve/firewall/110.fw — app container: publish only 80/443, keep the rest internal
cat > /etc/pve/firewall/110.fw <<'EOF'
[OPTIONS]
enable: 1
policy_in: DROP

[RULES]
IN ACCEPT -source 10.7.3.0/24 -p tcp -dport 22 -log nolog
IN ACCEPT -p tcp -dport 80  -log nolog
IN ACCEPT -p tcp -dport 443 -log nolog
# Prometheus scraping from the monitoring container only (§11)
IN ACCEPT -source 10.7.3.24 -p tcp -dport 4000 -log nolog
IN ACCEPT -source 10.7.3.24 -p tcp -dport 8000 -log nolog
EOF
```

The same file naming applies to every guest — `/etc/pve/firewall/<ID>.fw` —
so give CT 120 and CT 130 the equivalents of their ufw rules from §5.4 and
§6.5.

With `policy_in: DROP`, ports 3000 / 6379 / 8000 are unreachable from the LAN
while nginx still proxies to them over the container's own loopback and the
Docker containers still reach each other on the bridge. Verify from another
machine:

```bash
nc -vz 10.7.3.20 443     # succeeds
nc -vz 10.7.3.20 6379    # must fail
nc -vz 10.7.3.20 3000    # must fail
```

**Verify you still have UI and SSH access before you log out** — a wrong rule
here locks you out of the hypervisor, and recovery means physical or IPMI
console access.

> **Why not just bind the ports to localhost in Compose?** You can — but note
> that `tradingapp.sh` always invokes Compose with an explicit
> `-f docker-compose.yml` (see `compose_cmd()` in the script), and an explicit
> `-f` **suppresses** Docker's automatic pickup of `docker-compose.override.yml`.
> A dropped-in override file would apply to a bare `docker compose up` and be
> silently ignored by every `./tradingapp.sh` command — the worst possible
> failure mode for a security control. If you want the binding change anyway,
> edit the `ports:` entries in `docker-compose.yml` itself (e.g.
> `"127.0.0.1:4000:4000"`, and drop the `redis` `ports:` block entirely),
> accept that `git pull` may conflict there, and treat it as an addition to
> the firewall rather than a replacement for it.

---

## 11. Optional: monitoring container

Both `backend` and `broker_service` expose Prometheus metrics at `/metrics`
(the backend's is on the auth allow-list, so no token is needed). This repo
ships ready-made alert rules and a Grafana dashboard.

```bash
pct create 150 local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst \
  --hostname monitoring \
  --cores 2 --memory 2048 --swap 512 \
  --rootfs local-lvm:40 \
  --net0 name=eth0,bridge=vmbr0,firewall=1,ip=10.7.3.24/24,gw=10.7.3.1 \
  --nameserver 10.7.3.1 --searchdomain lan \
  --unprivileged 1 \
  --ssh-public-keys /root/tradingapp.pub \
  --onboot 1 --startup order=3 \
  --start 1

pct enter 150
```

Inside the container:

```bash
apt update && apt install -y prometheus grafana
```

Copy [`ops/prometheus/alerts.yml`](ops/prometheus/alerts.yml) to
`/etc/prometheus/alerts.yml`, then:

```yaml
# /etc/prometheus/prometheus.yml
rule_files:
  - /etc/prometheus/alerts.yml

scrape_configs:
  - job_name: tradingapp-backend
    static_configs: [{ targets: ['10.7.3.20:4000'] }]
    metrics_path: /metrics
  - job_name: tradingapp-broker_service
    static_configs: [{ targets: ['10.7.3.20:8000'] }]
    metrics_path: /metrics
```

> These targets only work if CT 110's firewall admits this container — that is
> what the two `-source 10.7.3.24` rules in the `110.fw` example (§10.3) are
> for. If you additionally bound the Docker ports to `127.0.0.1`, scrape
> through nginx instead, with a `/metrics` location allow-listed to
> `10.7.3.24`.

```bash
promtool check rules /etc/prometheus/alerts.yml
systemctl restart prometheus && systemctl enable --now grafana-server
```

Then import [`ops/grafana/tradingapp-dashboard.json`](ops/grafana/tradingapp-dashboard.json)
via Grafana → **Dashboards → New → Import**, selecting your Prometheus
datasource for the `DS_PROMETHEUS` variable.
[`ops/grafana/README.md`](ops/grafana/README.md) documents every metric the
panels rely on.

Also worth scraping the hypervisor: `apt install prometheus-pve-exporter` on
the Proxmox host surfaces per-guest CPU, memory and disk pressure. On an
all-LXC deployment this matters more than usual — the containers compete for
one kernel's page cache and I/O queues, so host-level pressure shows up as
application latency with no in-container symptom.

---

## 12. Backups and snapshots

Three independent layers, each covering what the others don't.

### 12.1 Guest backups (vzdump)

**Datacenter → Backup → Add**: select 110/120/130 (and 140 if present),
storage `local` (or a Proxmox Backup Server / NFS share), schedule nightly,
mode **Snapshot**, compression `zstd`.

CLI equivalent:

```bash
vzdump 110 120 130 --mode snapshot --compress zstd --storage local --mailnotification failure
```

Two container-specific notes:

- **Mode `snapshot` needs snapshot-capable storage** (LVM-thin, ZFS, btrfs,
  Ceph). On directory storage, vzdump falls back to `suspend` — which pauses
  the container for the duration of the copy. On a trading host during market
  hours, that is an outage, not a backup window. Check your storage type
  before scheduling.
- **The `mp0` data volume on CT 120 is included** because §5.1 set
  `backup=1`. Verify with `pct config 120 | grep mp0` — a mount point marked
  `backup=0` is silently skipped, which is exactly the surprise you don't want
  during a restore.

**A vzdump of the DB container is not a database backup.** There is no guest
agent to freeze the filesystem for a container, so the copy is
crash-consistent at best — it restores like a machine that lost power. Good
enough for infrastructure recovery, not for "restore yesterday's data
cleanly". That is what §12.2 is for.

### 12.2 Database dumps

In CT 120, `/usr/local/bin/backup-tradingapp.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
BACKUP_DIR=/var/backups/tradingapp
DATE=$(date -u +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"
sudo -u postgres pg_dump -Fc tradingapp > "$BACKUP_DIR/tradingapp_${DATE}.dump"
find "$BACKUP_DIR" -name 'tradingapp_*.dump' -mtime +14 -delete
```

```bash
chmod +x /usr/local/bin/backup-tradingapp.sh
# 02:10 UTC daily, before the vzdump window
echo '10 2 * * * root /usr/local/bin/backup-tradingapp.sh' > /etc/cron.d/tradingapp-backup
```

`/var/backups` lives on the container's **root** volume, not the `mp0` data
volume — deliberately, so a lost data volume doesn't take the dumps with it.
Better still, push them off the host entirely.

Restore with `pg_restore -d tradingapp -c /var/backups/.../file.dump`. Test
this at least once — an untested backup is a hypothesis.

> TimescaleDB hypertables dump and restore through `pg_dump`/`pg_restore`
> normally, but restore into a database where the extension is **already
> created**, and check Timescale's version-specific dump notes if you are
> crossing a major version.

### 12.3 Pre-change snapshots

Before every app update, IB Gateway upgrade or schema change:

```bash
pct snapshot 110 pre-update-$(date -u +%Y%m%d)
pct snapshot 120 pre-update-$(date -u +%Y%m%d)
```

Roll back with `pct rollback 110 <snapname>`. Prune old snapshots — on
LVM-thin and ZFS they consume real space and eventually stall writes.

### 12.4 What is not backed up

- **`.env`** exists only in CT 110 and holds every secret. Keep a copy in a
  password manager; it is the one file a rebuild cannot regenerate.
- **IBC's `config.ini`** in CT 130 holds your IB credentials. Same treatment.
- **Redis** is a cache and stream bus — losing it is harmless, it refills.
- **Docker images** rebuild from the repo; no need to back them up.

---

## 13. Boot order and auto-start

The `--startup order=` values set earlier bring the deployment up in sequence
after a host reboot — which, on an all-LXC host, is *every* kernel update:

```bash
pct set 120 --onboot 1 --startup order=1,up=60     # DB first, then wait 60s
pct set 130 --onboot 1 --startup order=1,up=30     # IB Gateway
pct set 110 --onboot 1 --startup order=2,up=30     # app stack
pct set 150 --onboot 1 --startup order=3           # monitoring
qm  set 140 --onboot 1 --startup order=1           # MT5 VM, if present
```

Inside CT 110 the Compose stack has `restart: unless-stopped` on every
service, so Docker restarts it once the container is up. If you want an
explicit systemd unit (useful when the compose invocation needs flags such as
`--with-db`):

```ini
# /etc/systemd/system/tradingapp.service
[Unit]
Description=TradingApp
After=docker.service network-online.target
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
sudo systemctl daemon-reload && sudo systemctl enable --now tradingapp
```

Verify the whole chain with a real host reboot during a market close, then
`./tradingapp.sh test`. A boot order that has never been tested is not a boot
order — and with containers you will exercise it on every kernel update
whether you planned to or not.

---

## 14. Day-2 operations

```bash
# Update the application (inside CT 110)
cd /opt/tradingapp
git pull origin master
./tradingapp.sh redeploy         # rebuilds images — required after any NEXT_PUBLIC_* change

# Logs
./tradingapp.sh logs             # last 20 lines per service
./tradingapp.sh logs follow      # stream

# Resource pressure
docker stats
docker system df                 # image/volume growth — prune between releases
```

From the Proxmox host, useful on a container deployment:

```bash
pct list                         # all containers and states
pct exec 110 -- docker ps        # run a command without entering
pct df 110                       # per-volume usage
```

Once the base deployment is stable, enable the optional subsystems **one at a
time**, verifying each before moving on. Each makes live venue requests on a
timer, so turning several on at once makes a misbehaving one hard to identify:

| Feature | Key | Where it is documented |
|---|---|---|
| Scheduled backfill | `BACKFILL_ENABLED=true` | [`DEPLOYMENT.md` § Data collection & retention](DEPLOYMENT.md#data-collection--retention-phase-5) |
| Executions (fills) sync | `EXECUTIONS_SYNC_ENABLED=true` | [`DEPLOYMENT.md` § Executions sync](DEPLOYMENT.md#executions-fills-sync) |
| Systematic strategies | `SYSTEMATIC_ENABLED=true` | [`.env.example`](.env.example), [`SYSTEMATIC_TRADING_ROADMAP.md`](SYSTEMATIC_TRADING_ROADMAP.md) |
| Live order placement | `LIVE_TRADING_ENABLED=true` | [`DEPLOYMENT.md` § Enabling live trading](DEPLOYMENT.md#enabling-live-trading) |

Proxmox-side routine: patch the host during a market close and reboot (all
containers restart together — see §13), watch storage headroom (`pvesm
status`; LVM-thin pools that hit 100% corrupt data, they don't just fail
writes), and review `journalctl -u pve-firewall` after firewall edits.

---

## 15. Proxmox-specific troubleshooting

### Docker-in-LXC

| Symptom | Cause / fix |
|---|---|
| `docker: failed to start daemon` / containerd exits immediately | `keyctl=1` missing. `pct set 110 --features nesting=1,keyctl=1` and restart the container. |
| Docker starts but every `run` fails with an overlay/mount error | `nesting=1` missing, or you are on ZFS-backed storage with `overlay2`. Add `fuse=1`, install `fuse-overlayfs`, set it in `/etc/docker/daemon.json`, then `rm -rf /var/lib/docker` and restart Docker (this discards images — rebuild them). |
| `docker info` shows storage driver `vfs` | Docker fell back to the slow, space-hungry driver. Same fix as above; don't leave it on `vfs` for a build-heavy stack. |
| Docker daemon warns about `/dev/kmsg` | Harmless in LXC — the device isn't exposed to containers. If a tool insists, `ln -s /dev/console /dev/kmsg` in a startup script. |
| Docker works, but only after making the container privileged | Don't ship that. Revert to `--unprivileged 1` and add the specific feature flag that was actually missing (`nesting`/`keyctl`/`fuse`). |
| AppArmor denials in `dmesg` on the host, Docker misbehaving | As a last resort add `lxc.apparmor.profile: unconfined` to `/etc/pve/lxc/110.conf` — but understand it removes a meaningful part of the container boundary on the host holding your broker credentials. Prefer identifying the missing feature flag. |

### Containers and the host

| Symptom | Cause / fix |
|---|---|
| `pct create` fails: "storage does not support container images" | You targeted an ISO-only directory storage. Use `local-lvm` / `local-zfs`, or enable *Container* content on that storage. |
| `pct snapshot` fails | Directory storage doesn't support snapshots. Move the container to LVM-thin/ZFS, or rely on vzdump alone. |
| `free -h` inside a container shows the host's total RAM | lxcfs isn't mounted for that container. Restart it; until then, tools that autotune from `/proc/meminfo` (notably `timescaledb-tune`, §5.2) will size for memory the container cannot have. |
| Container OOM-kills a process well below the host's free memory | Working as designed — LXC memory is a hard cgroup limit. Raise it: `pct set 110 --memory 12288`. |
| Time is wrong inside a container | Fix the **host** clock (§3.3). Containers cannot set time; NTP installed inside is a no-op at best. |
| `ufw enable` fails inside an unprivileged container | Expected on some kernels/profiles. Use the Proxmox per-guest firewall (§10.3) — it is host-enforced and strictly stronger. |
| Proxmox firewall rules have no effect on a container | The interface lacks `firewall=1`. `pct set 110 --net0 name=eth0,bridge=vmbr0,firewall=1,ip=10.7.3.20/24,gw=10.7.3.1`. |
| Everything unreachable after enabling the firewall | Datacenter rules default-deny once enabled. Recover from the physical/IPMI console: `pvefw-stop`, fix `/etc/pve/firewall/cluster.fw`, restart. |
| Host storage full, containers wedged | LVM-thin pool exhausted, usually by snapshots or backups on `local`. Delete old snapshots/backups, then restart the affected containers. |

### Application-level

| Symptom | Cause / fix |
|---|---|
| App container can't reach the DB container | Check in order: `nc -vz 10.7.3.21 5432` from CT 110, `listen_addresses`, the `pg_hba.conf` line, then the firewall rules (§5.4, §10.3). |
| Backend health OK but `/api/database/health` fails | Reachability is fine, credentials or schema are not. Verify `POSTGRES_PASSWORD` in `.env` and that `timescaledb-schema.sql` was applied. |
| Routes to part of the LAN disappear on CT 110 only | Docker's `172.20.0.0/16` bridge collides with a real subnet. See the warning in §2. |
| Ports still open from the LAN despite `ufw enable` | Docker's iptables rules are evaluated before ufw's INPUT chain. Filter at the hypervisor — §10.3. |
| A `docker-compose.override.yml` you created has no effect | `tradingapp.sh` passes an explicit `-f docker-compose.yml`, which suppresses automatic override pickup. Edit `docker-compose.yml` directly, or invoke `docker compose -f docker-compose.yml -f <your-file>` yourself. |
| IB Gateway logged out, no data, no error | The known gap in §6.5. Check `systemctl status ibgateway` in CT 130 and reconnect over the VNC tunnel (§6.3). |

Application-level issues beyond these (chart rendering, MT5 `501`/`503`,
timestamp drift) are covered in [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) and
[`DEPLOYMENT.md` § Common Issues](DEPLOYMENT.md#common-issues). Start with
`./tradingapp.sh diagnose`.

---

## Appendix A: single-container quickstart

For evaluation, or when the hypervisor has limited resources. One LXC runs the
app **and** the bundled TimescaleDB container; IB Gateway lives wherever it
already lives.

```bash
# On the Proxmox host
pct create 110 local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst \
  --hostname tradingapp \
  --cores 6 --memory 12288 --swap 1024 \
  --rootfs local-lvm:200 \
  --net0 name=eth0,bridge=vmbr0,firewall=1,ip=10.7.3.20/24,gw=10.7.3.1 \
  --nameserver 10.7.3.1 \
  --features nesting=1,keyctl=1 \
  --unprivileged 1 \
  --ssh-public-keys /root/tradingapp.pub \
  --onboot 1 --start 1
pct enter 110
```

```bash
# Inside the container — add fuse-overlayfs first if on ZFS (§4.2)
apt update && apt install -y git curl sudo ca-certificates
curl -fsSL https://get.docker.com | sh
docker run --rm hello-world        # gate: must pass before continuing

adduser --disabled-password --gecos "" tradingapp
usermod -aG sudo,docker tradingapp
echo 'tradingapp ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/tradingapp && chmod 440 /etc/sudoers.d/tradingapp

mkdir -p /opt/tradingapp && chown tradingapp:tradingapp /opt/tradingapp
su - tradingapp
git clone https://github.com/41agent41/tradingapp.git /opt/tradingapp
cd /opt/tradingapp && chmod +x tradingapp.sh
./tradingapp.sh setup            # answer with your IB Gateway IP
nano .env                        # API_TOKEN + NEXT_PUBLIC_API_TOKEN, CORS_ORIGINS, secrets
chmod 600 .env
./tradingapp.sh deploy --with-db # bundled TimescaleDB, schema applied automatically
./tradingapp.sh test
```

The schema is applied on **first container start only**. To re-apply it you
must remove the `tradingapp_pgdata` volume — which deletes the data. Plan the
move to a dedicated DB container (§5) before you accumulate history worth
keeping.

---

## Appendix B: full deployment checklist

**Hypervisor**

- [ ] Proxmox VE updated; enterprise repo disabled, no-subscription enabled
- [ ] Host timezone UTC, `chrony` running and synchronised (containers inherit it)
- [ ] Container storage type identified — LVM-thin/dir vs ZFS (§1.2)
- [ ] Ubuntu LXC template downloaded
- [ ] LAN subnet does not overlap `172.20.0.0/16`
- [ ] Datacenter firewall configured, UI/SSH access verified before logout

**App container (110)**

- [ ] Created unprivileged with `nesting=1,keyctl=1` (+ `fuse=1` on ZFS)
- [ ] `net0` carries `firewall=1`
- [ ] `docker run --rm hello-world` passes; storage driver is `overlay2` or
      `fuse-overlayfs`, **not** `vfs`
- [ ] Non-root `tradingapp` user created with sudo + docker group
- [ ] Repo cloned to `/opt/tradingapp`, `tradingapp.sh` executable
- [ ] `.env` complete — no placeholders, `chmod 600`, copy stored offline
- [ ] `API_TOKEN` == `NEXT_PUBLIC_API_TOKEN`, freshly generated
- [ ] `CORS_ORIGINS` is the real browser origin, not `*`
- [ ] `LIVE_TRADING_ENABLED=false` for the first deploy
- [ ] `./tradingapp.sh deploy` completed, `test` all green
- [ ] Charts render in a browser
- [ ] nginx + TLS in front (production), `redeploy` run after the URL change

**Database container (120)**

- [ ] Data directory on its own mount point, `backup=1` confirmed
- [ ] PostgreSQL + TimescaleDB installed; `timescaledb-tune` sized against the
      container's limit, not the host's RAM
- [ ] `tradingapp` role and database created, strong password recorded
- [ ] `timescaledb-schema.sql` applied; both hypertables present
- [ ] `listen_addresses` / `pg_hba.conf` scoped to CT 110 only
- [ ] `pg_dump` cron installed and one restore tested

**IB Gateway container (130)**

- [ ] IB Gateway installed, logged into the **paper** account
- [ ] API enabled, socket port set, CT 110 in Trusted IPs
- [ ] IBC configured; `ibgateway.service` enabled and surviving a restart
- [ ] VNC not exposed to the LAN (SSH tunnel only)
- [ ] Port 4001/4002 restricted to CT 110

**Operations**

- [ ] Proxmox firewall on 110 drops 3000/6379/8000 from the LAN — verified
      with `nc` from another machine, not assumed
- [ ] `--onboot` and `--startup order` set on every guest; host reboot tested
- [ ] vzdump schedule covering 110/120/130; mode `snapshot` supported by the
      storage (not silently falling back to `suspend`)
- [ ] Baseline snapshots taken after the first green deploy
- [ ] Prometheus scraping both services; alert rules loaded and validated
- [ ] Grafana dashboard imported
- [ ] Optional subsystems (backfill, executions sync, systematic) enabled one
      at a time, each verified before the next

---

**Related documentation:** [`DEPLOYMENT.md`](DEPLOYMENT.md) (application
deployment reference) · [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) ·
[`backend/src/database/README.md`](backend/src/database/README.md) (schema
detail) · [`.env.example`](.env.example) (every configuration key) ·
[`FEATURES.md`](FEATURES.md) (what the deployed system does).
