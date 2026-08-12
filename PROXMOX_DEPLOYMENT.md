# Deploying TradingApp on a Bare-Metal Proxmox VE Host

End-to-end instructions for taking a machine with **nothing but Proxmox VE
freshly installed** to a running TradingApp deployment: application stack,
TimescaleDB database, broker session hosts, reverse proxy, monitoring and
backups.

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
4. [Create the app VM](#4-create-the-app-vm)
5. [Create the database VM (TimescaleDB)](#5-create-the-database-vm-timescaledb)
6. [Create the IB Gateway VM](#6-create-the-ib-gateway-vm)
7. [Optional: MT5 sidecar VM](#7-optional-mt5-sidecar-vm)
8. [Deploy the application stack](#8-deploy-the-application-stack)
9. [Verify the deployment](#9-verify-the-deployment)
10. [Reverse proxy, TLS and firewalling](#10-reverse-proxy-tls-and-firewalling)
11. [Optional: monitoring container](#11-optional-monitoring-container)
12. [Backups and snapshots](#12-backups-and-snapshots)
13. [Boot order and auto-start](#13-boot-order-and-auto-start)
14. [Day-2 operations](#14-day-2-operations)
15. [Proxmox-specific troubleshooting](#15-proxmox-specific-troubleshooting)
16. [Appendix A: single-VM quickstart](#appendix-a-single-vm-quickstart)
17. [Appendix B: full deployment checklist](#appendix-b-full-deployment-checklist)

---

## 1. Target topology

TradingApp spans more than one machine by design: the Docker stack is Linux,
but **IB Gateway and MetaTrader 5 are logged-in GUI sessions that cannot live
inside the Docker stack** (see
[`DEPLOYMENT.md` § Multi-Broker Host Topology](DEPLOYMENT.md#multi-broker-host-topology-ib--mt5)).
On Proxmox each of those becomes a guest on the same hypervisor:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Proxmox VE host  (bare metal)                        vmbr0 → LAN         │
│                                                                          │
│  ┌────────────────────────┐   ┌────────────────────────┐                 │
│  │ VM 110  tradingapp-app │   │ VM 120  tradingapp-db  │                 │
│  │ Ubuntu 24.04 + Docker  │──▶│ Ubuntu 24.04           │                 │
│  │  frontend      :3000   │   │ PostgreSQL+TimescaleDB │                 │
│  │  backend       :4000   │   │                  :5432 │                 │
│  │  broker_service:8000   │   └────────────────────────┘                 │
│  │  redis         :6379   │                                              │
│  │  nginx      :80/:443   │   ┌────────────────────────┐                 │
│  └───────────┬────────────┘   │ VM 130  ib-gateway     │                 │
│              │                │ IB Gateway / TWS, GUI  │                 │
│              └───────────────▶│ socket API 4002 (paper)│                 │
│              │                └────────────────────────┘                 │
│              │                                                           │
│              │                ┌────────────────────────┐  (optional)     │
│              ├───────────────▶│ VM 140  mt5-bridge     │                 │
│              │                │ Windows + MT5 + sidecar│                 │
│              │                └────────────────────────┘                 │
│              │                                                           │
│              │                ┌────────────────────────┐  (optional)     │
│              └───────────────▶│ CT 150  monitoring     │                 │
│                               │ Prometheus + Grafana   │                 │
│                               └────────────────────────┘                 │
└──────────────────────────────────────────────────────────────────────────┘
```

**Why VMs and not LXC containers for the app host:** Docker inside an
unprivileged LXC works but needs `nesting=1`, `keyctl=1` and fights with
overlayfs on some storage backends. The app host runs a Docker Compose stack
with a custom bridge network — a plain VM removes an entire class of failure
you would otherwise debug at 3am. The database and monitoring hosts are
container-friendly; the guide uses a VM for the DB (snapshot/backup semantics
are cleaner for a data host) and an LXC for monitoring, where the resource
saving is worth it.

**Minimum viable variant:** if you only have resources for one guest, see
[Appendix A](#appendix-a-single-vm-quickstart) — one VM, bundled TimescaleDB
via `--with-db`, an external IB Gateway elsewhere on the network.

---

## 2. Plan the deployment

Fill this table in **before** you create anything. Every later step refers
back to it, and the app's `.env` hard-codes several of these addresses.

| VMID | Name | Type | Purpose | vCPU | RAM | Disk | IP |
|---|---|---|---|---|---|---|---|
| 110 | `tradingapp-app` | VM | Docker stack + nginx | 4 | 8 GB | 60 GB | `10.7.3.20` |
| 120 | `tradingapp-db` | VM | PostgreSQL + TimescaleDB | 4 | 8 GB | 200 GB | `10.7.3.21` |
| 130 | `ib-gateway` | VM | IB Gateway / TWS session | 2 | 4 GB | 60 GB | `10.7.3.22` |
| 140 | `mt5-bridge` *(opt)* | VM | Windows + MT5 + sidecar | 2 | 4 GB | 80 GB | `10.7.3.23` |
| 150 | `monitoring` *(opt)* | LXC | Prometheus + Grafana | 2 | 2 GB | 40 GB | `10.7.3.24` |

Also decide:

- **Gateway / DNS**: e.g. `10.7.3.1` / `10.7.3.1`.
- **Domain** (if using TLS): e.g. `trading.example.com` → `10.7.3.20`.
- **Database sizing**: `candlestick_data` and `tick_data` are TimescaleDB
  hypertables with retention policies (2 years OHLCV, 30 days ticks — see
  [`backend/src/database/timescaledb-schema.sql`](backend/src/database/timescaledb-schema.sql)).
  200 GB is comfortable for a handful of symbols; tick data across many
  symbols grows fast, so size the DB disk on a storage pool you can expand.

> ⚠️ **Subnet collision.** The Compose stack creates a bridge network on
> **`172.20.0.0/16`** with static container IPs (`docker-compose.yml`). If your
> LAN, VPN or another Proxmox bridge uses any part of `172.20.0.0/16`, the app
> VM will lose routes to it. Pick a different LAN range, or edit the
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
pvesm status       # storage: local (ISOs/templates), local-lvm or local-zfs (VM disks)
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
apt install -y libguestfs-tools chrony    # image customisation + NTP
reboot
```

`libguestfs-tools` is used in §4 to pre-install the QEMU guest agent into the
cloud image; `chrony` is not optional for this workload — see next.

### 3.3 Time synchronisation (not optional)

Every bar, tick and fill in this system is timestamped, the whole stack runs
in **UTC** (`TZ=UTC` is set on every container), and IB rejects or mislabels
data when the client clock drifts. Verify the host clock is disciplined and
UTC before anything else:

```bash
timedatectl set-timezone UTC
systemctl enable --now chrony
chronyc tracking | grep -E 'Reference ID|System time'
```

Guests inherit the host clock via `kvm-clock`, so fixing it here fixes it
everywhere except the Windows guests (§6/§7), which need their own NTP config.

### 3.4 Fetch the guest images

```bash
# Ubuntu 24.04 LTS cloud image — used for the app and DB VMs
cd /var/lib/vz/template/iso
wget https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img

# LXC template for the optional monitoring container
pveam update && pveam available | grep ubuntu-24
pveam download local ubuntu-24.04-standard_24.04-2_amd64.tar.zst
```

If you plan a **Windows** guest for IB Gateway or MT5, also upload a Windows
ISO plus the **VirtIO driver ISO**
(<https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso>)
to `local` storage via **Datacenter → local → ISO Images → Upload**.

### 3.5 Create an SSH key for the guests

On your workstation (not the Proxmox host), if you don't already have one:

```bash
ssh-keygen -t ed25519 -C "tradingapp"
ssh-copy-id root@<pve-ip>          # convenience: reach the host without a password
```

Copy the **public** key to the Proxmox host so cloud-init can inject it:

```bash
scp ~/.ssh/id_ed25519.pub root@<pve-ip>:/root/tradingapp.pub
```

---

## 4. Create the app VM

This VM runs the whole Docker Compose stack: `frontend`, `backend`,
`broker_service`, `redis` — plus nginx as the TLS front door in §10.

### 4.1 Build it from the cloud image

Run on the Proxmox host. Adjust `local-lvm` if your VM storage is named
differently (`pvesm status` tells you; ZFS installs use `local-zfs`).

```bash
VMID=110
STORAGE=local-lvm
IMG=/var/lib/vz/template/iso/noble-server-cloudimg-amd64.img

# Pre-install the guest agent into the image (gives Proxmox guest IP/fsfreeze)
virt-customize -a "$IMG" --install qemu-guest-agent --truncate /etc/machine-id

qm create $VMID \
  --name tradingapp-app \
  --memory 8192 --balloon 0 \
  --cores 4 --cpu host \
  --net0 virtio,bridge=vmbr0 \
  --scsihw virtio-scsi-single \
  --ostype l26 \
  --agent enabled=1 \
  --serial0 socket --vga serial0

qm disk import $VMID "$IMG" $STORAGE          # PVE 8+ ("qm importdisk" on older)
qm set $VMID --scsi0 $STORAGE:vm-$VMID-disk-0,discard=on,ssd=1
qm disk resize $VMID scsi0 60G
qm set $VMID --ide2 $STORAGE:cloudinit --boot order=scsi0

# cloud-init: user, key, static IP
qm set $VMID \
  --ciuser tradingapp \
  --sshkeys /root/tradingapp.pub \
  --ipconfig0 ip=10.7.3.20/24,gw=10.7.3.1 \
  --nameserver 10.7.3.1 \
  --searchdomain lan

qm set $VMID --onboot 1 --startup order=2,up=30
qm start $VMID
```

`--balloon 0` disables memory ballooning: Node, Postgres and the JVM-less but
still heap-hungry Next.js build all behave badly when memory is pulled out
from under them, and a ballooned trading host that swaps mid-session is a
latency problem you cannot see from inside the container.

`--cpu host` passes the physical CPU flags through, which matters for the
crypto and compression paths in Node and Postgres.

### 4.2 First login

```bash
ssh tradingapp@10.7.3.20

# Sanity
ip -br addr; timedatectl; free -h; df -h /
sudo apt update && sudo apt full-upgrade -y
sudo timedatectl set-timezone UTC
```

The cloud-init user is passwordless-sudo by default. `tradingapp.sh` refuses
to run as root and needs sudo — this user satisfies both.

> If `qm agent $VMID ping` fails from the host, the guest agent didn't install
> — run `sudo apt install -y qemu-guest-agent && sudo systemctl enable --now
> qemu-guest-agent` inside the VM. Without it, Proxmox cannot quiesce the
> filesystem for snapshot backups (§12).

---

## 5. Create the database VM (TimescaleDB)

The base `docker-compose.yml` deliberately does **not** provision Postgres —
the backend expects an external instance
([`DEPLOYMENT.md` § External database](DEPLOYMENT.md#external-database-recommended-for-production)).
On Proxmox that external instance is simply another VM, which keeps the
database's disk, snapshot schedule and restore path independent of the
application's.

> **Shortcut:** to skip this section entirely, deploy with
> `./tradingapp.sh deploy --with-db`, which layers `docker-compose.db.yml` and
> runs TimescaleDB as a container on the app VM with a Docker volume. That is
> fine for evaluation and lab use. It is not recommended for anything you care
> about: the data then shares a fate, a disk and a backup window with the
> application, and `./tradingapp.sh clean` prunes aggressively next to it.

### 5.1 Create the VM

Same recipe as §4.1 with the DB's numbers:

```bash
VMID=120
STORAGE=local-lvm
IMG=/var/lib/vz/template/iso/noble-server-cloudimg-amd64.img

qm create $VMID \
  --name tradingapp-db \
  --memory 8192 --balloon 0 \
  --cores 4 --cpu host \
  --net0 virtio,bridge=vmbr0 \
  --scsihw virtio-scsi-single \
  --ostype l26 --agent enabled=1 \
  --serial0 socket --vga serial0

qm disk import $VMID "$IMG" $STORAGE
qm set $VMID --scsi0 $STORAGE:vm-$VMID-disk-0,discard=on,ssd=1
qm disk resize $VMID scsi0 200G
qm set $VMID --ide2 $STORAGE:cloudinit --boot order=scsi0
qm set $VMID \
  --ciuser tradingapp --sshkeys /root/tradingapp.pub \
  --ipconfig0 ip=10.7.3.21/24,gw=10.7.3.1 \
  --nameserver 10.7.3.1 --searchdomain lan

# Start before the app VM (lower order number wins)
qm set $VMID --onboot 1 --startup order=1,up=60
qm start $VMID
```

> **Disk cache setting.** For a database VM, leave the disk on the Proxmox
> default (`cache=none`) — it is the only mode that honours flushes end to
> end. Do **not** set `cache=unsafe` or `writeback` on this VM to make imports
> faster; a host crash mid-write corrupts the cluster.

### 5.2 Install PostgreSQL + TimescaleDB

Inside VM 120 (`ssh tradingapp@10.7.3.21`):

```bash
sudo apt update && sudo apt install -y gnupg postgresql-common apt-transport-https lsb-release wget

# PostgreSQL APT repository (PGDG)
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y

# TimescaleDB repository
echo "deb https://packagecloud.io/timescale/timescaledb/ubuntu/ $(lsb_release -cs) main" \
  | sudo tee /etc/apt/sources.list.d/timescaledb.list
wget --quiet -O - https://packagecloud.io/timescale/timescaledb/gpgkey \
  | gpg --dearmor | sudo tee /etc/apt/trusted.gpg.d/timescaledb.gpg >/dev/null

sudo apt update
sudo apt install -y timescaledb-2-postgresql-17 postgresql-client-17
```

PostgreSQL 15, 16 and 17 are all supported by the schema (the bundled
container image is pg15; nothing in
`timescaledb-schema.sql` is version-specific). Pick 17 for a new build.

Tune and enable the extension:

```bash
sudo timescaledb-tune --quiet --yes    # sizes shared_buffers/work_mem, adds the preload
sudo systemctl restart postgresql
```

### 5.3 Create the role, database and schema

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE tradingapp WITH LOGIN PASSWORD 'REPLACE_WITH_A_STRONG_PASSWORD';
CREATE DATABASE tradingapp OWNER tradingapp;
SQL

sudo -u postgres psql -d tradingapp -c 'CREATE EXTENSION IF NOT EXISTS timescaledb;'
```

Generate the password with `openssl rand -base64 24` and record it — it goes
into the app VM's `.env` as `POSTGRES_PASSWORD` in §8.2.

Apply the canonical schema. Easiest is from the app VM once the repo is
cloned (§8.1), but you can also copy the file over:

```bash
# On the app VM, after cloning (§8.1):
PGPASSWORD='<the password>' psql \
  "host=10.7.3.21 port=5432 user=tradingapp dbname=tradingapp sslmode=disable" \
  -f backend/src/database/timescaledb-schema.sql
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

### 5.4 Let the app VM connect

By default Postgres listens on localhost only. Open it to the app VM — and
**only** the app VM:

```bash
# /etc/postgresql/17/main/postgresql.conf
sudo sed -i "s/^#\?listen_addresses.*/listen_addresses = '10.7.3.21'/" \
  /etc/postgresql/17/main/postgresql.conf

# /etc/postgresql/17/main/pg_hba.conf — single host, scram auth
echo "host    tradingapp    tradingapp    10.7.3.20/32    scram-sha-256" \
  | sudo tee -a /etc/postgresql/17/main/pg_hba.conf

sudo systemctl restart postgresql
```

Then firewall the VM so nothing else can even attempt a connection:

```bash
sudo apt install -y ufw
sudo ufw allow from 10.7.3.0/24 to any port 22 proto tcp
sudo ufw allow from 10.7.3.20 to any port 5432 proto tcp
sudo ufw --force enable
```

**TLS between app and DB:** the example sets `sslmode=disable` /
`POSTGRES_SSL=false` because both VMs sit on one hypervisor bridge. If the DB
ever moves off-host, generate a server certificate, set `ssl = on` in
`postgresql.conf`, change the `pg_hba.conf` line to `hostssl`, and set
`POSTGRES_SSL=true` in `.env`.

---

## 6. Create the IB Gateway VM

`broker_service` connects **outbound** to IB Gateway's socket API. IB Gateway
is a GUI Java application that must stay logged in — it is the single most
fragile part of this deployment and the reason it gets its own guest with its
own snapshot schedule.

### 6.1 Choose the guest OS

| Option | Notes |
|---|---|
| **Ubuntu 24.04 desktop + IBC** | Recommended. IBC (<https://github.com/IbcAlpha/IBC>) automates login and daily restarts; run headless under `xvfb` and manage as a systemd unit. Snapshot-friendly, no licence cost. |
| **Windows 11 / Server** | Familiar, and required anyway if you also run MT5 (§7). Needs the VirtIO driver ISO at install time (`--scsi0` and `--net0` are paravirtualised). |

Create the VM (Ubuntu desktop variant shown; install from ISO, not the cloud
image, since you need a desktop session):

```bash
qm create 130 \
  --name ib-gateway \
  --memory 4096 --balloon 0 --cores 2 --cpu host \
  --net0 virtio,bridge=vmbr0 \
  --scsihw virtio-scsi-single --scsi0 local-lvm:60,discard=on,ssd=1 \
  --ide2 local:iso/ubuntu-24.04-desktop-amd64.iso,media=cdrom \
  --ostype l26 --agent enabled=1 \
  --boot order='ide2;scsi0' \
  --onboot 1 --startup order=1,up=30
qm start 130
```

Then open **Console** in the Proxmox UI and install normally, giving the guest
the static IP `10.7.3.22`.

For a **Windows** guest, add `--ide3 local:iso/virtio-win.iso,media=cdrom` and
`--ostype win11`, and load the VirtIO SCSI driver from that second CD when the
installer reports it cannot find a disk.

### 6.2 Install and configure IB Gateway

1. Download IB Gateway from Interactive Brokers and install it in the guest.
2. Log in with your **paper** account first.
3. `Configure → Settings → API → Settings`:
   - ✅ **Enable ActiveX and Socket Clients**
   - ❌ **Read-Only API** (leave unchecked only when you intend to place orders)
   - **Socket port**: `4002` (paper) or `4001` (live)
   - **Trusted IPs**: add `10.7.3.20` (the app VM)
4. `Configure → Settings → Lock and Exit`: disable auto-logoff, or accept the
   daily restart and let IBC handle re-login.
5. Apply, OK, restart IB Gateway.

`./tradingapp.sh ib-help` (on the app VM, after §8) prints this same
walk-through with your actual `.env` values substituted.

### 6.3 Firewall

The IB socket API has no authentication beyond the trusted-IP list. Restrict
it at the OS level too:

```bash
# Ubuntu guest
sudo ufw allow from 10.7.3.0/24 to any port 22 proto tcp
sudo ufw allow from 10.7.3.20 to any port 4002 proto tcp
sudo ufw --force enable
```

On Windows, create an inbound rule for TCP 4001/4002 scoped to remote address
`10.7.3.20` only.

> **Known operational gap.** A silently logged-out IB Gateway is
> indistinguishable from a quiet market — the app just stops receiving data.
> Add a liveness check: `./tradingapp.sh test` covers it manually, and
> `ops/prometheus/alerts.yml` has the scrape-level alerts. This is tracked in
> [`GAP_ANALYSIS.md`](GAP_ANALYSIS.md#8-operational--deployment-gaps).

---

## 7. Optional: MT5 sidecar VM

Skip this unless you trade MetaTrader 5. The `MetaTrader5` Python package is
Windows-only and needs a live terminal, so it runs as a **Windows guest with a
FastAPI sidecar** that `broker_service` calls over HTTP. The sidecar is not in
this repository — you build it against the contract documented in
[`broker_service/mt5_adapter.py`](broker_service/mt5_adapter.py) (`/health`,
`/symbols`, `/history`, `/quote`, `/tick`, `/orders`, `/positions`,
`/account`).

```bash
qm create 140 \
  --name mt5-bridge \
  --memory 4096 --balloon 0 --cores 2 --cpu host \
  --net0 virtio,bridge=vmbr0 \
  --scsihw virtio-scsi-single --scsi0 local-lvm:80,discard=on,ssd=1 \
  --ide2 local:iso/Win11.iso,media=cdrom \
  --ide3 local:iso/virtio-win.iso,media=cdrom \
  --ostype win11 --agent enabled=1 \
  --boot order='ide2;scsi0' --onboot 1 --startup order=1
qm start 140
```

Windows 11 also wants a TPM and EFI disk — add
`--bios ovmf --efidisk0 local-lvm:1,efitype=4m,pre-enrolled-keys=1 --tpmstate0 local-lvm:1,version=v2.0`
to the `qm create` above if the installer refuses to proceed.

Then in `.env` on the app VM:

```bash
MT5_BRIDGE_URL=http://10.7.3.23:9100
MT5_BRIDGE_SECRET=<openssl rand -hex 32>
```

`broker_service` sends `X-MT5-Bridge-Secret` on every request when that is
set — **the sidecar must reject requests that don't carry the right value.**
Until it does, anything that can reach port 9100 can trade the account. Also
scope the Windows firewall rule for 9100 to `10.7.3.20` only.

Alpaca and OANDA need no guest at all — they are cloud REST APIs, enabled by
setting credentials in `.env`
([`DEPLOYMENT.md` § Alpaca and OANDA](DEPLOYMENT.md#alpaca-and-oanda--optional-cloud-brokers)).

---

## 8. Deploy the application stack

Everything from here runs **inside VM 110** as the `tradingapp` user.

### 8.1 Install Docker and clone

```bash
ssh tradingapp@10.7.3.20

sudo apt install -y git
sudo mkdir -p /opt/tradingapp && sudo chown tradingapp:tradingapp /opt/tradingapp
git clone https://github.com/41agent41/tradingapp.git /opt/tradingapp
cd /opt/tradingapp
chmod +x tradingapp.sh

# Installs Docker + Compose, then prompts for the IB Gateway IP and writes .env
./tradingapp.sh setup
```

When prompted for the IB Gateway IP, answer `10.7.3.22`. `setup` adds your
user to the `docker` group — **log out and back in** before continuing, or
`docker` calls will fail with a permission error:

```bash
exit
ssh tradingapp@10.7.3.20
cd /opt/tradingapp
docker ps      # should succeed without sudo
```

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

# --- Database (VM 120) ----------------------------------------------
POSTGRES_HOST=10.7.3.21
POSTGRES_PORT=5432
POSTGRES_USER=tradingapp
POSTGRES_PASSWORD=<the password from §5.3>
POSTGRES_DB=tradingapp
POSTGRES_SSL=false          # true if you enabled hostssl in §5.4

# --- IB Gateway (VM 130) --------------------------------------------
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
  startup warning). On a VM reachable from your LAN, that is an open trading
  API. Set it before the first deploy, not after.

Lock the file down — it holds your database password, API token and, later,
broker credentials:

```bash
chmod 600 .env
```

### 8.3 Deploy

```bash
./tradingapp.sh deploy
```

The first build compiles the Next.js frontend and installs the Python and Node
dependency trees — expect 3–8 minutes on the specced VM. Subsequent
`redeploy`s are faster.

If you chose the bundled database instead of VM 120, use
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

# Database health — proves VM 110 → VM 120 works
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

Take a Proxmox snapshot of both VMs at this point — a known-good baseline is
worth more than any amount of documentation:

```bash
# On the Proxmox host
qm snapshot 120 clean-install --description "TimescaleDB + schema applied"
qm snapshot 110 clean-deploy  --description "First green deploy"
```

---

## 10. Reverse proxy, TLS and firewalling

The raw ports serve plain HTTP and the bearer token travels in a header — on
anything beyond an isolated lab network, put TLS in front.

### 10.1 nginx on the app VM

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

### 10.2 Guest firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable
```

Note what this does **not** do: Docker publishes ports by writing its own
`iptables` rules in the `DOCKER` chain, which are evaluated before ufw's
`INPUT` filtering. Ports 3000, 4000, 8000 and **6379** stay reachable from the
LAN even with ufw enabled. Redis in the base compose file has **no
password** — an open 6379 is a full read/write handle on your cache and
streaming bus, and 8000 is the broker service, which talks to your broker.

This is exactly the gap the hypervisor firewall closes (§10.3) — on Proxmox
that is the more reliable fix than fighting Docker's iptables rules from
inside the guest, because it is enforced on the host side of the guest's
network interface and no in-guest change can bypass it.

### 10.3 Proxmox-level firewall

Proxmox filters at the guest's tap interface, on the host — *before* packets
ever reach Docker's rules. That makes it the authoritative control for what
the LAN can reach on VM 110.

Enable it at **Datacenter → Firewall**, then per guest at
**VM → Firewall → Options → Firewall: Yes**. From the shell:

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
# /etc/pve/firewall/110.fw — app VM: publish only 80/443, keep the rest internal
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

With `policy_in: DROP`, 3000 / 6379 / 8000 are unreachable from the LAN while
nginx still proxies to them over the VM's own loopback and the containers
still reach each other on the Docker bridge. Verify from another machine:

```bash
nc -vz 10.7.3.20 443     # succeeds
nc -vz 10.7.3.20 6379    # must fail
nc -vz 10.7.3.20 3000    # must fail
```

Apply the same treatment to the DB and IB Gateway guests (`120.fw`, `130.fw`)
so their ufw rules from §5.4 and §6.3 are backed by a host-side rule.

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

Create a lightweight LXC — no Docker inside, so a container is a good fit:

```bash
pct create 150 local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst \
  --hostname monitoring \
  --memory 2048 --cores 2 \
  --rootfs local-lvm:40 \
  --net0 name=eth0,bridge=vmbr0,ip=10.7.3.24/24,gw=10.7.3.1 \
  --nameserver 10.7.3.1 \
  --features nesting=1 \
  --unprivileged 1 --onboot 1 --startup order=3
pct start 150
pct enter 150
```

Inside the container:

```bash
apt update && apt install -y prometheus grafana
```

Point Prometheus at the app VM and load the shipped rules — copy
[`ops/prometheus/alerts.yml`](ops/prometheus/alerts.yml) to
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

> These targets only work if the app VM's firewall admits the monitoring
> container — that is what the two `-source 10.7.3.24` rules in the `110.fw`
> example (§10.3) are for. If you additionally bound the container ports to
> `127.0.0.1` in `docker-compose.yml`, scrape through nginx instead, with a
> `/metrics` location allow-listed to `10.7.3.24`.

```bash
promtool check rules /etc/prometheus/alerts.yml
systemctl restart prometheus && systemctl enable --now grafana-server
```

Then import [`ops/grafana/tradingapp-dashboard.json`](ops/grafana/tradingapp-dashboard.json)
via Grafana → **Dashboards → New → Import**, selecting your Prometheus
datasource for the `DS_PROMETHEUS` variable.
[`ops/grafana/README.md`](ops/grafana/README.md) documents every metric the
panels rely on.

Also worth scraping the hypervisor itself: `apt install prometheus-pve-exporter`
on the Proxmox host surfaces per-guest CPU, memory and disk pressure, which is
how you catch the app VM swapping before it shows up as chart latency.

---

## 12. Backups and snapshots

Three independent layers, each covering what the others don't.

### 12.1 Guest backups (vzdump)

**Datacenter → Backup → Add**: select VMs 110/120/130, storage `local` (or a
Proxmox Backup Server / NFS share), schedule nightly, mode **Snapshot**,
compression `zstd`. With the guest agent installed (§4.1) Proxmox freezes the
filesystem for a consistent image.

CLI equivalent:

```bash
vzdump 110 120 130 --mode snapshot --compress zstd --storage local --mailnotification failure
```

**A vzdump of the DB VM is not a database backup.** A filesystem snapshot of a
running Postgres is crash-consistent, not transaction-consistent — it restores
like a machine that lost power. Good enough for infrastructure recovery, not
for "restore yesterday's data cleanly". That is what §12.2 is for.

### 12.2 Database dumps

On the DB VM (120), `/usr/local/bin/backup-tradingapp.sh`:

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
sudo chmod +x /usr/local/bin/backup-tradingapp.sh
# 02:10 UTC daily, before the vzdump window
echo '10 2 * * * root /usr/local/bin/backup-tradingapp.sh' | sudo tee /etc/cron.d/tradingapp-backup
```

Restore with `pg_restore -d tradingapp -c /var/backups/.../file.dump`. Test
this at least once — an untested backup is a hypothesis.

> TimescaleDB hypertables dump and restore through `pg_dump`/`pg_restore`
> normally, but restore into a database where the extension is **already
> created**, and check Timescale's version-specific dump notes if you are
> crossing a major version.

### 12.3 Pre-change snapshots

Before every app update, IB Gateway upgrade or schema change:

```bash
qm snapshot 110 pre-update-$(date -u +%Y%m%d)
qm snapshot 120 pre-update-$(date -u +%Y%m%d)
```

Roll back with `qm rollback 110 <snapname>`. Prune old snapshots — on LVM-thin
and ZFS they accumulate real space and eventually stall writes.

### 12.4 What is not backed up

- **`.env`** exists only on VM 110 and holds every secret. Keep a copy in a
  password manager; it is the one file a rebuild cannot regenerate.
- **Redis** is a cache and stream bus — losing it is harmless, it refills.
- **IB Gateway configuration** lives in the guest's home directory; the vzdump
  covers it, but note the account credentials are not stored there.

---

## 13. Boot order and auto-start

The `--startup order=` values set earlier make a host reboot come up in the
right sequence: database and IB Gateway first, application second.

```bash
qm set 120 --onboot 1 --startup order=1,up=60     # DB, then wait 60s
qm set 130 --onboot 1 --startup order=1,up=30     # IB Gateway
qm set 110 --onboot 1 --startup order=2,up=30     # app stack
pct set 150 --onboot 1 --startup order=3          # monitoring
```

Inside the app VM the Compose stack has `restart: unless-stopped` on every
service, so Docker restarts it after a reboot. If you want an explicit systemd
unit (useful when the compose invocation needs flags such as `--with-db`):

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

Verify the whole chain with a real reboot of the hypervisor during a market
close, then `./tradingapp.sh test`. A boot order that has never been tested is
not a boot order.

---

## 14. Day-2 operations

```bash
# Update the application
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

Once the base deployment is stable, enable the optional subsystems **one at a
time**, verifying each before moving on. Each makes live venue requests on a
timer, so turning several on at once makes a misbehaving one hard to identify:

| Feature | Key | Where it is documented |
|---|---|---|
| Scheduled backfill | `BACKFILL_ENABLED=true` | [`DEPLOYMENT.md` § Data collection & retention](DEPLOYMENT.md#data-collection--retention-phase-5) |
| Executions (fills) sync | `EXECUTIONS_SYNC_ENABLED=true` | [`DEPLOYMENT.md` § Executions sync](DEPLOYMENT.md#executions-fills-sync) |
| Systematic strategies | `SYSTEMATIC_ENABLED=true` | [`.env.example`](.env.example), [`SYSTEMATIC_TRADING_ROADMAP.md`](SYSTEMATIC_TRADING_ROADMAP.md) |
| Live order placement | `LIVE_TRADING_ENABLED=true` | [`DEPLOYMENT.md` § Enabling live trading](DEPLOYMENT.md#enabling-live-trading) |

Proxmox-side routine: keep the host patched (`apt update && apt full-upgrade`
during a market close, then reboot), watch storage headroom (`pvesm status` —
LVM-thin pools that hit 100% corrupt data, they don't just fail writes), and
review `journalctl -u pve-firewall` after firewall edits.

---

## 15. Proxmox-specific troubleshooting

| Symptom | Cause / fix |
|---|---|
| `qm disk import` fails with "storage does not support content type images" | You targeted `local` (dir storage for ISOs). Use `local-lvm` / `local-zfs`, or enable *Disk image* content on that storage. |
| VM has no IP after cloud-init | `--ipconfig0` was set after first boot. Cloud-init only applies on first boot: `qm set <id> --ipconfig0 ...` then regenerate with `qm cloudinit update <id>` and reboot. |
| `qm agent <id> ping` times out | `qemu-guest-agent` not installed/running in the guest, or `--agent enabled=1` missing. Backups fall back to non-quiesced snapshots until fixed. |
| App VM can't reach the DB VM | Check in order: `nc -vz 10.7.3.21 5432` from VM 110, `listen_addresses` in `postgresql.conf`, the `pg_hba.conf` line, then the ufw rule (§5.4). |
| Backend health OK but `/api/database/health` fails | Reachability is fine, credentials or schema are not. Verify `POSTGRES_PASSWORD` in `.env` and that `timescaledb-schema.sql` was applied. |
| Everything unreachable after enabling the Proxmox firewall | Datacenter rules default-deny once enabled. Recover from the physical/IPMI console: `pvefw-stop` (temporarily), fix `/etc/pve/firewall/cluster.fw`, restart. |
| Routes to part of the LAN disappear on VM 110 only | Docker's `172.20.0.0/16` bridge collides with a real subnet. See the warning in §2. |
| Ports still open from the LAN despite `ufw enable` | Docker's iptables rules are evaluated before ufw's INPUT chain. Filter at the hypervisor instead — §10.3. |
| A `docker-compose.override.yml` you created has no effect | `tradingapp.sh` passes an explicit `-f docker-compose.yml`, which suppresses automatic override pickup. Edit `docker-compose.yml` directly, or invoke `docker compose -f docker-compose.yml -f <your-file>` yourself. |
| Guests drift in time / IB rejects data timestamps | Host chrony not running (§3.3), or a Windows guest using its own time source. Confirm with `chronyc tracking` on the host and `w32tm /query /status` on Windows. |
| Host storage full, VMs paused ("io-error") | LVM-thin pool exhausted, usually by snapshots or backups on `local`. Delete old snapshots/backups, then resume: `qm resume <id>`. |
| Poor frontend/chart responsiveness under load | Check `docker stats` on VM 110 and host-level steal time. Ballooning left on (`--balloon` non-zero) or an over-committed host are the usual causes. |

Application-level issues (IB connection failures, charts not loading, MT5
`501`/`503`) are covered in [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) and
[`DEPLOYMENT.md` § Common Issues](DEPLOYMENT.md#common-issues). Start with
`./tradingapp.sh diagnose`.

---

## Appendix A: single-VM quickstart

For evaluation, or when the hypervisor has limited resources. One Ubuntu VM
runs the app **and** the bundled TimescaleDB container; IB Gateway lives
wherever it already lives.

```bash
# On the Proxmox host — 6 vCPU / 12 GB / 200 GB, otherwise identical to §4.1
VMID=110 ; STORAGE=local-lvm ; IMG=/var/lib/vz/template/iso/noble-server-cloudimg-amd64.img
virt-customize -a "$IMG" --install qemu-guest-agent --truncate /etc/machine-id
qm create $VMID --name tradingapp --memory 12288 --balloon 0 --cores 6 --cpu host \
  --net0 virtio,bridge=vmbr0 --scsihw virtio-scsi-single --ostype l26 \
  --agent enabled=1 --serial0 socket --vga serial0
qm disk import $VMID "$IMG" $STORAGE
qm set $VMID --scsi0 $STORAGE:vm-$VMID-disk-0,discard=on,ssd=1
qm disk resize $VMID scsi0 200G
qm set $VMID --ide2 $STORAGE:cloudinit --boot order=scsi0 \
  --ciuser tradingapp --sshkeys /root/tradingapp.pub \
  --ipconfig0 ip=10.7.3.20/24,gw=10.7.3.1 --nameserver 10.7.3.1
qm set $VMID --onboot 1 && qm start $VMID
```

```bash
# Inside the VM
sudo apt update && sudo apt install -y git
sudo mkdir -p /opt/tradingapp && sudo chown tradingapp:tradingapp /opt/tradingapp
git clone https://github.com/41agent41/tradingapp.git /opt/tradingapp
cd /opt/tradingapp && chmod +x tradingapp.sh
./tradingapp.sh setup            # answer with your IB Gateway IP
# log out / back in for the docker group
nano .env                        # API_TOKEN + NEXT_PUBLIC_API_TOKEN, CORS_ORIGINS, secrets
chmod 600 .env
./tradingapp.sh deploy --with-db # bundled TimescaleDB, schema applied automatically
./tradingapp.sh test
```

The schema is applied on **first container start only**. To re-apply it you
must remove the `tradingapp_pgdata` volume — which deletes the data. Plan the
move to a dedicated DB VM (§5) before you accumulate history worth keeping.

---

## Appendix B: full deployment checklist

**Hypervisor**

- [ ] Proxmox VE updated; enterprise repo disabled, no-subscription enabled
- [ ] Host timezone UTC, `chrony` running and synchronised
- [ ] VM storage identified; free space verified for all planned disks
- [ ] Ubuntu cloud image and LXC template downloaded
- [ ] LAN subnet does not overlap `172.20.0.0/16`
- [ ] Datacenter firewall configured, UI/SSH access verified before logout

**Database VM (120)**

- [ ] PostgreSQL + TimescaleDB installed, `timescaledb-tune` applied
- [ ] `tradingapp` role and database created, strong password recorded
- [ ] `timescaledb-schema.sql` applied; hypertables present
- [ ] `listen_addresses` / `pg_hba.conf` scoped to the app VM only
- [ ] ufw restricts 5432 to `10.7.3.20`
- [ ] `pg_dump` cron installed and one restore tested

**IB Gateway VM (130)**

- [ ] IB Gateway installed, logged into the **paper** account
- [ ] API enabled, socket port set, app VM in Trusted IPs
- [ ] Auto-restart / IBC configured so a daily logout doesn't go unnoticed
- [ ] Firewall restricts 4001/4002 to the app VM

**App VM (110)**

- [ ] Docker + Compose installed; user in the `docker` group
- [ ] Repo cloned to `/opt/tradingapp`, `tradingapp.sh` executable
- [ ] `.env` complete — no placeholders, `chmod 600`, copy stored offline
- [ ] `API_TOKEN` == `NEXT_PUBLIC_API_TOKEN`, freshly generated
- [ ] `CORS_ORIGINS` is the real browser origin, not `*`
- [ ] `LIVE_TRADING_ENABLED=false` for the first deploy
- [ ] `./tradingapp.sh deploy` completed, `test` all green
- [ ] `/api/database/health` returns healthy
- [ ] Charts render in a browser
- [ ] Proxmox VM firewall on 110 drops 3000/6379/8000 from the LAN — verified
      with `nc` from another machine, not assumed
- [ ] nginx + TLS in front (production), `redeploy` run after the URL change

**Operations**

- [ ] `--onboot` and `--startup order` set on every guest; reboot tested
- [ ] vzdump schedule covering 110/120/130
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
