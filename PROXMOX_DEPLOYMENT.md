# Deploying TradingApp on a Bare-Metal Proxmox VE Host

This guide takes a machine with only Proxmox VE installed to a running
TradingApp: the app stack, a TimescaleDB database, the broker hosts, a
reverse proxy, monitoring and backups.

Guests are LXC containers wherever the workload allows. [§1.2](#12-why-lxc-and-the-two-places-it-costs-you)
says what that needs, and names the one component that cannot be a container.

This guide builds the infrastructure. The app itself (settings, auth,
streaming, executions sync, alerting) is covered in
[`DEPLOYMENT.md`](DEPLOYMENT.md). To drive the install from a script or an
agent, use [`AGENT_INSTALL_RUNBOOK.md`](AGENT_INSTALL_RUNBOOK.md); it automates
§4 and §8.

> **Scope.** TradingApp places real orders. Every step here keeps to paper:
> live trading stays off and every broker connection is a paper account.
> Nothing in this guide turns live trading on. That is a separate, deliberate
> step: [`DEPLOYMENT.md` § Enabling live trading](DEPLOYMENT.md#enabling-live-trading).

---

## Table of Contents

1. [Target topology](#1-target-topology)
2. [Plan the deployment](#2-plan-the-deployment)
3. [Proxmox host post-install](#3-proxmox-host-post-install)
4. [Create the app container](#4-create-the-app-container)
5. [Create the database container (TimescaleDB)](#5-create-the-database-container-timescaledb)
6. [Create the IB Gateway container](#6-create-the-ib-gateway-container)
7. [Optional: MT5 sidecar (Windows VM)](#7-optional-mt5-sidecar-windows-vm)
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

The Docker stack is Linux. IB Gateway and MetaTrader 5 are logged-in GUI
sessions that cannot live inside it (see
[`DEPLOYMENT.md` § Host layout with IB and MT5](DEPLOYMENT.md#host-layout-with-ib-and-mt5)).
On Proxmox each one gets its own guest. Every guest is an LXC container except
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

Containers share the host kernel. They boot in seconds, carry no guest-OS
memory overhead, and `pct enter` is faster than a console. For four
long-lived Linux services on one hypervisor, that is a real gain.

It costs you in two places.

**1. MT5 runs Windows code.** An LXC guest always runs the host's Linux
kernel. The `MetaTrader5` Python package needs Windows Python and a live
terminal, so this guide puts the MT5 sidecar in a Windows VM (§7). The sidecar
can also run the terminal under Wine on Linux, in a VM or a privileged LXC
(see [`mt5_sidecar/README.md`](mt5_sidecar/README.md)). If you don't trade
MT5, every guest is an LXC.

**2. Docker-in-LXC needs specific container features.** The app container runs
a Docker Compose stack: containers inside a container. This works well on
current Proxmox, but only with the right flags set at create time:

| Requirement | Why |
|---|---|
| `--features nesting=1` | Lets the container run its own container runtime and systemd |
| `--features keyctl=1` | containerd uses the kernel keyring; without it Docker fails to start |
| `--unprivileged 1` | Keep it. A privileged container with nesting is close to root on the hypervisor |
| Storage-driver choice | `overlay2` works on LVM-thin or ext4-backed rootfs. On ZFS-backed rootfs it does not: add `fuse=1` and switch Docker to `fuse-overlayfs` (§4.2) |

Check which case you are in before you create anything:

```bash
pvesm status        # look at the Type column for your container storage
```

`lvmthin` or `dir`: nothing extra to do. `zfspool`: you need the
`fuse-overlayfs` step in §4.2.

On security: an unprivileged LXC is a solid boundary, but it shares the
kernel. It is not hardware virtualisation, and a host kernel update reboots
every container at once. If that is not acceptable for the app container, make
that one guest a VM. Nothing else in this guide changes.

**Smallest variant:** one guest only. See
[Appendix A](#appendix-a-single-container-quickstart): one container with the
bundled TimescaleDB, and IB Gateway elsewhere on the network.

---

## 2. Plan the deployment

Fill in this table before you create anything. Later steps refer back to it.

| ID | Name | Type | Purpose | Cores | RAM | Disk | IP |
|---|---|---|---|---|---|---|---|
| 110 | `tradingapp-app` | **LXC** | Docker stack + nginx | 4 | 8 GB | 60 GB | `10.7.3.20` |
| 120 | `tradingapp-db` | **LXC** | PostgreSQL + TimescaleDB | 4 | 8 GB | 32 GB + 200 GB mp | `10.7.3.21` |
| 130 | `ib-gateway` | **LXC** | IB Gateway session (headless X) | 2 | 4 GB | 40 GB | `10.7.3.22` |
| 140 | `mt5-bridge` *(opt)* | **VM** | Windows + MT5 + sidecar | 2 | 4 GB | 80 GB | `10.7.3.23` |
| 150 | `monitoring` *(opt)* | **LXC** | Prometheus + Grafana | 2 | 2 GB | 40 GB | `10.7.3.24` |

Also decide:

- **Gateway and DNS**: for example `10.7.3.1` for both.
- **Domain** (if using TLS): for example `trading.example.com` → `10.7.3.20`.
- **Database size**: `candlestick_data` and `tick_data` are TimescaleDB
  hypertables with retention policies (2 years of OHLCV, 30 days of ticks; see
  [`backend/src/database/timescaledb-schema.sql`](backend/src/database/timescaledb-schema.sql)).
  The database container gets a separate 200 GB mount point for its data
  directory (§5.1), so it can be grown, snapshotted and restored on its own.
  Tick data across many symbols grows fast. Put that mount point on a pool you
  can expand.
- **LXC memory is a hard cgroup limit**, not a balloon. Go over it and the
  kernel kills a process inside the container. Size generously and keep swap
  small.

> **Subnet collision.** The Compose stack creates a bridge network on
> `172.20.0.0/16` with fixed container addresses (`docker-compose.yml`). If
> your LAN, VPN or another Proxmox bridge uses any part of `172.20.0.0/16`, the
> app container loses its routes to it. Pick a different LAN range, or edit
> the `networks.tradingapp-network.ipam` block and every `172.20.0.x` address
> in `docker-compose.yml` and `docker-compose.db.yml` together.

---

## 3. Proxmox host post-install

Do all of this in the Proxmox web UI shell (`https://<pve-ip>:8006` → node →
**Shell**) or over SSH as `root`.

### 3.1 Confirm the install

```bash
pveversion -v | head -3
ip -br addr        # vmbr0 should hold the host's LAN IP
pvesm status       # note the Type column (§1.2)
```

### 3.2 Switch to the no-subscription repository

A fresh install points at the enterprise repository. Without a subscription
key it answers 401 and blocks all updates. Proxmox VE 9 uses deb822
`.sources` files; VE 8 uses `.list` files. Run the block for your version.

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

> Every container shares this kernel, so a host kernel upgrade restarts the
> whole deployment. Do it during a market close. This is the main cost of the
> all-LXC layout, and the reason the boot order in §13 has to work.

### 3.3 Time synchronisation (not optional, and host-only)

Every bar, tick and fill is timestamped. The stack runs in UTC, and IB rejects
or mislabels data when the client clock drifts.

LXC guests cannot set their own clock. They read the host's. So fix it once,
here, and every container is right. Do not install chrony or NTP inside the
containers: it fails, or seems to work and does nothing.

```bash
timedatectl set-timezone UTC
systemctl enable --now chrony
chronyc tracking | grep -E 'Reference ID|System time'
```

Only the Windows MT5 VM (§7), if you have one, needs its own time source.

### 3.4 Fetch the container templates

```bash
pveam update
pveam available --section system | grep ubuntu-24
pveam download local ubuntu-24.04-standard_24.04-2_amd64.tar.zst
```

Use the template filename that `pveam available` lists today; the point
release moves.

For the optional Windows MT5 VM, also upload a Windows ISO and the VirtIO
driver ISO
(<https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso>)
under **Datacenter → local → ISO Images → Upload**.

### 3.5 Create an SSH key for the guests

On your workstation, if you don't have one yet:

```bash
ssh-keygen -t ed25519 -C "tradingapp"
ssh-copy-id root@<pve-ip>          # reach the host without a password
scp ~/.ssh/id_ed25519.pub root@<pve-ip>:/root/tradingapp.pub
```

`pct create --ssh-public-keys` puts this key on the container's `root`
account, so you can SSH in without setting a root password.

---

## 4. Create the app container

CT 110 runs the Docker Compose stack (`frontend`, `backend`, `broker_service`,
`redis`) and nginx as the TLS front door (§10).

[`install/proxmox-create-ct.sh`](install/proxmox-create-ct.sh) does §4.1 as a
script. The steps below are what it does.

### 4.1 Create it

Run on the Proxmox host. Use your container storage in place of `local-lvm`
(`pvesm status`; ZFS installs usually have `local-zfs`).

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

On ZFS-backed storage, add `fuse=1` to the features (see §4.2):

```bash
pct set $CTID --features nesting=1,keyctl=1,fuse=1
```

Three flags matter most, because getting them wrong fails much later and
confusingly:

- `nesting=1`: Docker won't start without it.
- `keyctl=1`: containerd needs the keyring.
- `firewall=1` on `net0`: without it, the Proxmox firewall in §10.3 does
  nothing for this guest.

`--swap 1024` is a small cushion. Don't make it large: a container that swaps
while serving live ticks is slow without saying so.

### 4.2 Install Docker

```bash
pct enter 110
```

Inside the container:

```bash
apt update && apt full-upgrade -y
apt install -y git curl ca-certificates openssl
ln -sf /usr/share/zoneinfo/UTC /etc/localtime      # timezone; the clock itself is the host's
```

**If your container storage is ZFS**, install the fuse-overlayfs driver before
Docker starts for the first time. Otherwise Docker picks a driver that does
not work and remembers that choice:

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

`hello-world` is the real test of the LXC setup. If it fails, fix it here (§15
has the usual causes). Do not carry on and debug it through the app.

`./tradingapp.sh install` can install Docker itself, but it does not know
about ZFS. Installing Docker by hand here lets you choose the storage driver
first. `install` then sees Docker is present and skips that step.

### 4.3 Create the deploy user

`tradingapp.sh` refuses to run as root and needs sudo. A container gives you a
root shell, so create the user:

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

Leave the container console and check the path you will actually use:

```bash
exit
ssh tradingapp@10.7.3.20
docker ps        # must work without sudo
```

---

## 5. Create the database container (TimescaleDB)

Here the database runs in its own container. Its disk, snapshot schedule and
restore path are then separate from the app's, and you can rebuild the app
container without touching your data (§8.6).

> **Skipping this section.** `./tradingapp.sh install` without
> `--external-db` runs TimescaleDB as a Docker container inside CT 110, with
> its data in a Docker volume. That is fine for evaluation. For anything
> longer, use this section: with the bundled database, the data shares a disk
> and a backup window with the app.

You only create the role, the database and the `timescaledb` extension here.
The backend creates and updates the schema itself when it starts.

### 5.1 Create it, with a separate data volume

No nesting or keyctl here: Postgres runs directly in the container, so this is
a plain unprivileged LXC.

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

`--mp0` puts the PostgreSQL data directory on its own 200 GB volume. It is
mounted at `/var/lib/postgresql` before Postgres is installed, so the packages
put their data there from the start. `backup=1` includes it in vzdump runs.
Grow it later without touching the rest:

```bash
pct resize 120 mp0 +100G
```

`--startup order=1,up=60` starts the database first on host boot and waits 60
seconds before the next group. The backend waits for its database however long
it takes, so this is about a tidy start, not correctness.

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

PostgreSQL 15, 16 and 17 all work (the bundled image is 15). Pick 17 for a new
build.

> If `apt update` finds no TimescaleDB packages, packagecloud has not
> published for your Ubuntu codename yet. Use the previous LTS codename
> (`jammy` for a `noble` container) in
> `/etc/apt/sources.list.d/timescaledb.list`. The packages are built against
> the PGDG PostgreSQL you just installed, not the distribution's.

```bash
timescaledb-tune --quiet --yes    # sizes shared_buffers/work_mem, adds the preload
systemctl restart postgresql
```

> `timescaledb-tune` reads the memory the container reports. Proxmox mounts
> lxcfs, so `/proc/meminfo` shows the cgroup limit (8 GB), not the host's
> total, and the tuning is right. Check with `free -h` first. If it shows the
> host's full RAM, lxcfs is not mounted: pass `--memory 8GB` to
> `timescaledb-tune`, or it sizes Postgres for memory the container cannot
> have.

### 5.3 Create the role, database and extension

1. Generate a password and keep it. You give it to `install` in §8.2.

   ```bash
   openssl rand -base64 24
   ```

2. Create the role and the database:

   ```bash
   sudo -u postgres psql <<'SQL'
   CREATE ROLE tradingapp WITH LOGIN PASSWORD 'REPLACE_WITH_THE_PASSWORD';
   CREATE DATABASE tradingapp OWNER tradingapp;
   SQL
   ```

3. Create the extension. The app's role is not a superuser, so do this here:

   ```bash
   sudo -u postgres psql -d tradingapp -c 'CREATE EXTENSION IF NOT EXISTS timescaledb;'
   ```

That is all the database needs. Do not apply the schema by hand. On its first
start the backend applies `timescaledb-schema.sql` and every migration, and
records them in `schema_migrations`.

### 5.4 Let the app container connect

Postgres listens on localhost by default. Open it to CT 110, and only CT 110:

```bash
# /etc/postgresql/17/main/postgresql.conf
sed -i "s/^#\?listen_addresses.*/listen_addresses = '10.7.3.21'/" \
  /etc/postgresql/17/main/postgresql.conf

# /etc/postgresql/17/main/pg_hba.conf: one host, scram auth
echo "host    tradingapp    tradingapp    10.7.3.20/32    scram-sha-256" \
  >> /etc/postgresql/17/main/pg_hba.conf

systemctl restart postgresql
```

Then firewall the container. Have both layers: ufw inside, and the Proxmox
rules from §10.3:

```bash
apt install -y ufw
ufw allow from 10.7.3.0/24 to any port 22 proto tcp
ufw allow from 10.7.3.20 to any port 5432 proto tcp
ufw --force enable
```

> ufw inside an unprivileged LXC works on current Proxmox, but it depends on
> the host's netfilter modules and the container's AppArmor profile. If
> `ufw enable` errors, skip it. The Proxmox per-guest firewall (§10.3) is
> enforced on the host, covers the same ground, and cannot be bypassed from
> inside the guest.

**TLS between app and database:** this guide uses `POSTGRES_SSL=false`
because both containers are on one hypervisor bridge. If the database moves
off this host, give Postgres a server certificate, set `ssl = on` in
`postgresql.conf`, change the `pg_hba.conf` line to `hostssl`, and set
`POSTGRES_SSL=true` in the app's `.env`.

### 5.5 Moving from the bundled database

If CT 110 already runs the bundled database and you want to move to CT 120,
`install --external-db` refuses: it would leave the data behind. Move the data
first:

1. Do §5.1 to §5.4.
2. On CT 110, stop the backend and dump the bundled database:

   ```bash
   cd /opt/tradingapp
   docker compose -f docker-compose.yml -f docker-compose.db.yml stop backend
   docker compose -f docker-compose.yml -f docker-compose.db.yml exec -T postgres \
     pg_dump -U tradingapp -Fc tradingapp > /tmp/tradingapp.dump
   ```

3. Copy `/tmp/tradingapp.dump` to CT 120 and restore it:

   ```bash
   sudo -u postgres psql -d tradingapp -c 'SELECT timescaledb_pre_restore();'
   sudo -u postgres pg_restore -d tradingapp --no-owner --role=tradingapp /tmp/tradingapp.dump
   sudo -u postgres psql -d tradingapp -c 'SELECT timescaledb_post_restore();'
   ```

   An error that the `timescaledb` extension already exists is expected.

4. On CT 110, switch over. `--no-db` stops using the bundled database; the
   key in `.env` stays, so the restored secrets still open:

   ```bash
   ./tradingapp.sh --no-db install --external-db
   ```

   It asks for the database host (`10.7.3.21`) and the password from §5.3.

5. Once the app is healthy on CT 120, remove the old volume:
   `docker volume ls | grep pgdata`, then `docker volume rm <name>`.

---

## 6. Create the IB Gateway container

`broker_service` connects out to IB Gateway's socket API. IB Gateway is a Java
GUI application that must stay logged in. It is the most fragile part of this
deployment, so it gets its own guest and its own snapshots.

It runs well in an LXC, with one change. A container has no graphical console
(`pct enter` is a text shell), so you drive the GUI through a virtual
framebuffer and VNC for the one-time setup, and through IBC
(<https://github.com/IbcAlpha/IBC>) for automatic login and daily restarts.

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

`nesting=1` here is for systemd, not Docker. The IBC unit and the framebuffer
both behave better with it.

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

# IBC: automates login and the daily restart.
# Check https://github.com/IbcAlpha/IBC/releases for the current version:
# the asset filename carries it, so there is no version-agnostic URL.
IBC_VERSION=3.20.0
mkdir -p /opt/ibc && cd /opt/ibc
wget -O IBCLinux.zip \
  "https://github.com/IbcAlpha/IBC/releases/download/${IBC_VERSION}/IBCLinux-${IBC_VERSION}.zip"
unzip -o IBCLinux.zip && chmod +x *.sh scripts/*.sh
```

### 6.3 One-time GUI configuration over VNC

Start a framebuffer and a VNC server bound to localhost, and reach it through
an SSH tunnel. Never expose VNC to the LAN.

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

1. Log in with your **paper** account.
2. Open `Configure → Settings → API → Settings` and set:
   - **Enable ActiveX and Socket Clients**: on.
   - **Read-Only API**: on, until you intend to place orders.
   - **Socket port**: `4002` (paper). `4001` is live.
   - **Trusted IPs**: add `10.7.3.20` (the app container).
3. Click Apply, then OK. The settings are saved in `~/Jts`, so you do this
   once.

When done, stop the temporary processes
(`pkill x11vnc; pkill -f ibgateway; pkill Xvfb`). The service in §6.4 starts
its own.

### 6.4 Run it as a service under IBC

Put your credentials and `TradingMode=paper` in `/opt/ibc/config.ini` (the
login settings are near the top). Then create the unit:

```ini
# /etc/systemd/system/ibgateway.service
[Unit]
Description=IB Gateway (IBC)
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/xvfb-run -n 1 -s "-screen 0 1280x900x24" /opt/ibc/gatewaystart.sh
Restart=always
RestartSec=30
User=root

[Install]
WantedBy=multi-user.target
```

`xvfb-run` owns the framebuffer as one supervised process. Do not start `Xvfb`
from `ExecStartPre` instead: `ExecStartPre` must finish before `ExecStart`
runs, so a long-running `Xvfb` there hangs the unit forever.

```bash
systemctl daemon-reload && systemctl enable --now ibgateway
systemctl status ibgateway
ss -ltnp | grep 4002        # the API socket should be listening
```

The app learns about the gateway when you add an IB connection under
Settings > Connections (§8.4): host `10.7.3.22`, port `4002`.

### 6.5 Firewall

The IB socket API has no authentication beyond the trusted-IP list:

```bash
ufw allow from 10.7.3.0/24 to any port 22 proto tcp
ufw allow from 10.7.3.20 to any port 4002 proto tcp
ufw --force enable
```

Back it with a Proxmox rule (§10.3). That one cannot be bypassed from inside
the guest.

> **Known gap.** A logged-out IB Gateway looks like a quiet market: data just
> stops. The app checks each connection on a timer
> (`BROKER_PROBE_INTERVAL_SECONDS`, on Settings > Schedulers and data) and
> shows its state on Settings > Connections. IBC's auto-restart helps, and
> `ops/prometheus/alerts.yml` has scrape-level alerts. Tracked in
> [`GAP_ANALYSIS.md`](docs/plans/GAP_ANALYSIS.md#8-operational--deployment-gaps).

---

## 7. Optional: MT5 sidecar (Windows VM)

Skip this unless you trade MetaTrader 5.

Proxmox containers can only run Linux. The `MetaTrader5` Python package needs
Windows Python and a live MT5 terminal, so this guide runs it in a Windows VM.
The other option is the terminal and Windows Python under Wine on Linux, in a
VM or a privileged LXC; [`mt5_sidecar/README.md`](mt5_sidecar/README.md)
covers that, and [`install/mt5-sidecar-wine.sh`](install/mt5-sidecar-wine.sh)
scripts it.

The sidecar that `broker_service` calls is in
[`mt5_sidecar/`](mt5_sidecar/README.md). Its README covers installing it on
Windows and running it as a scheduled task. The HTTP contract is at the top
of [`broker_service/mt5_adapter.py`](broker_service/mt5_adapter.py). One
sidecar serves one terminal and one account. A second account needs a second
terminal and sidecar on another port.

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

When the Windows installer cannot find a disk, load the VirtIO SCSI driver
from the second CD. Install `qemu-guest-agent` from the same ISO afterwards.
Unlike the containers, this guest needs its own NTP setup: it does not use the
host clock.

Then connect it to the app:

1. Make a shared secret of at least 24 characters, for example with
   `openssl rand -hex 32`.
2. Put it in the sidecar's `sidecar.env` as `MT5_BRIDGE_SECRET`, and set
   `MT5_ALLOW_REAL=false`.
3. Scope the Windows firewall rule for port 9100 to `10.7.3.20` only.
4. In the app, add an MT5 connection under Settings > Connections (§8.4) with
   the URL `http://10.7.3.23:9100` and the same secret.

`broker_service` sends the secret as `X-MT5-Bridge-Secret` on every request.
The sidecar rejects any request without it, and refuses to start on a
non-loopback address without a secret. Anything that reaches the port with the
secret can trade the account, so keep the firewall rule tight.

Alpaca and OANDA need no guest. They are cloud APIs: add them under
Settings > Connections with their keys
([`DEPLOYMENT.md` § Adding brokers](DEPLOYMENT.md#adding-brokers)).

---

## 8. Deploy the application stack

Everything from here runs inside CT 110 as the `tradingapp` user from §4.3.

One command commissions the app: `./tradingapp.sh install`. It writes `.env`,
builds and starts the stack, waits for the backend to migrate the database,
and prints the URL. Brokers, risk limits, alerts and data collection are then
set in the app. You do not edit `.env` or run SQL.

### 8.1 Clone

```bash
ssh tradingapp@10.7.3.20

sudo mkdir -p /opt/tradingapp && sudo chown tradingapp:tradingapp /opt/tradingapp
git clone https://github.com/41agent41/tradingapp.git /opt/tradingapp
cd /opt/tradingapp
```

### 8.2 Install

With the database container from §5:

```bash
./tradingapp.sh install --external-db
```

It asks for the database host (`10.7.3.21`) and the password from §5.3. To
skip the questions, pass them in a file:

```bash
umask 077
cat > ~/install.answers <<'EOF'
POSTGRES_HOST=10.7.3.21
POSTGRES_PASSWORD=<the password from §5.3>
EOF
./tradingapp.sh install --external-db --answers ~/install.answers --non-interactive
rm ~/install.answers
```

With the bundled database instead (no §5), run `./tradingapp.sh install` with
no flag. It generates the database password itself.

What `install` does:

1. Checks curl and openssl. Installs Docker if missing (here it is already
   there, from §4.2).
2. Writes `.env` with seven keys: `POSTGRES_HOST`, `POSTGRES_PORT`,
   `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_SSL` and
   `SETTINGS_ENCRYPTION_KEY`. It generates the encryption key. It never
   replaces a password or key that is already there.
3. Builds and starts the stack. The first build takes several minutes.
4. Waits until the backend reports ready: database reached, schema migrated,
   encryption key checked. It stops early, with the reason, on
   `migration_failed` or `key_mismatch`.
5. Checks the frontend, backend and broker service. It does not test brokers.
6. Prints the URL and, on a new install, the setup code.

The broker service token and the Redis password are not in `.env`. They are
generated into a Docker volume on first start.

**Save the encryption key off this host now.** It opens every secret the app
stores in the database (broker credentials, alert tokens). A rebuild that
keeps the database needs it (§8.6).

```bash
./tradingapp.sh backup-key     # prints SETTINGS_ENCRYPTION_KEY; put it in a password manager
```

`install` is safe to re-run. It is also how you upgrade and repair.

### 8.3 First sign-in

1. Open `http://10.7.3.20:3000`.
2. Enter the setup code. If you missed it, `./tradingapp.sh setup-code` shows
   it again.
3. Choose the login password.

If the page shows a message over it, the backend is still waiting for
something: `waiting_for_database`, `migrating`, `migration_failed` or
`key_mismatch`. See §15.

### 8.4 Add brokers

Open **Settings > Connections**. The page lists brokers in priority order:
OANDA, MT5, IB, Alpaca. For each one you use:

1. Choose the broker and mark the connection **paper**.
2. Enter its details:
   - **IB**: host `10.7.3.22`, port `4002` (§6).
   - **MT5**: the sidecar URL `http://10.7.3.23:9100` and the secret you put
     on the sidecar (§7).
   - **OANDA**: the practice API token and account id.
   - **Alpaca**: the paper API key and secret.
3. Save. The app tests the connection as it saves, and shows the result.

The app keeps checking each connection on a timer
(`BROKER_PROBE_INTERVAL_SECONDS`, on Settings > Schedulers and data; 0 pauses
it). Per-connection risk limits and prop-firm rules are on the connection's
own form.

Secrets entered here are stored in the database, sealed with
`SETTINGS_ENCRYPTION_KEY`. They are not in `.env`.

### 8.5 Finish the Getting started checklist

The Settings page shows a **Getting started** checklist. It is worked out from
the app's state, so it shows what is left:

1. Login password set (§8.3).
2. Order MFA enrolled and a trading token made, on Settings > Security.
3. A broker connection added (§8.4).
4. Instruments chosen for data collection: the table on Settings >
   Schedulers and data. Turn on the backfill scheduler there too
   (`BACKFILL_ENABLED`).
5. Alerts: the Telegram bot token and chat id, and the heartbeat URL, on
   Settings > Alerts and safety. Point the heartbeat at a monitor off this
   Proxmox host.

### 8.6 Rebuild this container

Use this when CT 110 is lost, broken, or you want a clean one. The database
container (CT 120) stays as it is. You need the key you saved with
`backup-key` in §8.2.

1. Destroy or set aside the old CT 110. Do not touch CT 120.
2. Do §4.1 to §4.3 again.
3. Clone the repository (§8.1).
4. Write an answers file with the database details and the saved key:

   ```bash
   umask 077
   cat > ~/install.answers <<'EOF'
   POSTGRES_HOST=10.7.3.21
   POSTGRES_PASSWORD=<the password from §5.3>
   SETTINGS_ENCRYPTION_KEY=<the key from backup-key>
   EOF
   ```

5. Install:

   ```bash
   cd /opt/tradingapp
   ./tradingapp.sh install --external-db --answers ~/install.answers --non-interactive
   rm ~/install.answers
   ```

The backend finds the existing schema, applies only pending migrations, checks
the key, and comes up configured. There is no setup screen; your login,
brokers and settings are already there. Redo §10.1 (nginx) if you used it.

If it stops with `key_mismatch`, the key is wrong. Put the right one in `.env`
and run `install` again. If the key is lost for good,
`./tradingapp.sh forget-secrets` clears the secrets sealed with it.
Connections and settings stay, and you enter their secrets again.

---

## 9. Verify the deployment

`install` already ran these checks once. Run them again once the stack has
settled:

```bash
./tradingapp.sh status      # container states
./tradingapp.sh test        # frontend, backend, broker service, readiness
./tradingapp.sh doctor      # database, schema, key and broker state, and what .env holds
```

Then check each layer directly:

```bash
# Frontend
curl -I http://10.7.3.20:3000

# Readiness: database reached, schema up to date, key matches
curl -s http://10.7.3.20:4000/api/health/ready | jq

# Database health: proves CT 110 → CT 120 works
curl -fs http://10.7.3.20:4000/api/database/health | jq

# Broker service (loopback only: run this inside CT 110)
curl -fs http://127.0.0.1:8000/health | jq
```

Brokers are checked by the app, not by these commands. Their state is on
Settings > Connections.

Open `http://10.7.3.20:3000`, sign in, and confirm a chart renders with data.

Snapshot every container now. A known-good baseline is worth a lot, and LXC
snapshots are near-instant on LVM-thin and ZFS:

```bash
# On the Proxmox host
pct snapshot 120 clean-install --description "TimescaleDB, role and extension"
pct snapshot 130 clean-install --description "IB Gateway configured, IBC running"
pct snapshot 110 clean-deploy  --description "First green deploy"
```

> Container snapshots need snapshot-capable storage (LVM-thin, ZFS, btrfs,
> Ceph). On plain directory storage `pct snapshot` fails, which is a good
> reason not to put these containers there.

---

## 10. Reverse proxy, TLS and firewalling

The raw ports serve plain HTTP. On anything beyond an isolated lab network,
put TLS in front.

### 10.1 nginx in the app container

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo nano /etc/nginx/sites-available/tradingapp
```

```nginx
# Sites files are read inside nginx's http {} block, so the map can live here.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

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

    # Everything goes to the frontend, which forwards /api and /socket.io
    # to the backend itself. The upgrade headers carry Socket.IO's live
    # updates through. (proxy_set_header is not inherited into a location
    # that sets its own, so all of them live here.)
    location / {
        proxy_pass http://127.0.0.1:3000;
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

```bash
sudo ln -s /etc/nginx/sites-available/tradingapp /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d trading.example.com
```

Nothing about the address is built into the frontend, so no rebuild is
needed. Then, in the app, open **Settings > Network** and set:

- **Allowed browser origins** (`CORS_ORIGINS`): `https://trading.example.com`.
- **Trusted reverse proxies** (`TRUST_PROXY`): `172.20.0.1`. nginx reaches the
  frontend from the Docker network's gateway, and this lets the backend
  believe the client address nginx passes on (for login lockout and the audit
  log).

Both apply as soon as you save.

### 10.2 Why in-guest firewalling isn't enough here

Docker publishes ports by writing its own `iptables` rules, which run before
ufw's `INPUT` chain. Ports 3000 and 4000 stay reachable from the LAN even with
ufw on inside CT 110. (Redis is not published at all, and the broker service
is published on loopback only.)

In an unprivileged container ufw may not even load: it depends on host
netfilter and the container's AppArmor profile. Filter at the hypervisor
instead (§10.3). Those rules are enforced on the host, and nothing inside the
guest can bypass them.

### 10.3 Proxmox-level firewall (the authoritative layer)

Proxmox filters at the guest's network interface, on the host, before packets
reach Docker's rules. It works the same for containers and VMs, with one
condition: the interface must carry `firewall=1`. The `pct create` commands
above set it. Confirm:

```bash
pct config 110 | grep net0    # must contain firewall=1
```

Enable the firewall at **Datacenter → Firewall**, then per guest at
**CT → Firewall → Options → Firewall: Yes**. From the shell:

```bash
# /etc/pve/firewall/cluster.fw: datacenter-wide.
# This file does not exist on a fresh install, so write it whole. If you
# already have one, merge these lines by hand: a second [OPTIONS] or
# [RULES] section in the same file is a parse error, not an append.
cat > /etc/pve/firewall/cluster.fw <<'EOF'
[OPTIONS]
enable: 1

[RULES]
IN ACCEPT -source 10.7.3.0/24 -p tcp -dport 8006 -log nolog   # Proxmox UI
IN ACCEPT -source 10.7.3.0/24 -p tcp -dport 22   -log nolog   # SSH
EOF
```

Enabling the datacenter firewall applies a default-DROP input policy to the
host itself. The two rules above keep the web UI and SSH reachable. Write them
in the same edit that sets `enable: 1`, never after.

```bash
# /etc/pve/firewall/110.fw: app container. Publish only 80/443, keep the rest internal
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

Every guest uses the same naming, `/etc/pve/firewall/<ID>.fw`. Give CT 120
and CT 130 the equivalents of their ufw rules from §5.4 and §6.5.

With `policy_in: DROP`, ports 3000, 6379 and 8000 are unreachable from the
LAN. nginx still reaches them over the container's loopback, and the Docker
containers still reach each other on the bridge. Check from another machine:

```bash
nc -vz 10.7.3.20 443     # succeeds
nc -vz 10.7.3.20 6379    # must fail
nc -vz 10.7.3.20 3000    # must fail
```

**Check you still have UI and SSH access before you log out.** A wrong rule
here locks you out of the hypervisor, and recovery needs the physical or IPMI
console.

> **Why not bind the ports to localhost in Compose?** You can, but not with an
> override file. `tradingapp.sh` always passes an explicit
> `-f docker-compose.yml`, and that stops Docker from reading
> `docker-compose.override.yml`. An override would apply to a bare
> `docker compose up` and be ignored by every `./tradingapp.sh` command. To
> change the bindings, edit the `ports:` entries in `docker-compose.yml`
> itself (for example `"127.0.0.1:4000:4000"`), expect `git pull` to conflict
> there, and keep the firewall as well.

---

## 11. Optional: monitoring container

`backend` and `broker_service` both expose Prometheus metrics at `/metrics`
(the backend's needs no token). The repo ships alert rules and a Grafana
dashboard.

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

Inside the container. Prometheus is in Ubuntu's `universe` repository.
Grafana is not packaged by Debian or Ubuntu and needs its own repository:

```bash
apt update && apt install -y prometheus apt-transport-https software-properties-common wget

# Grafana's own repository: `apt install grafana` fails without it
mkdir -p /etc/apt/keyrings
wget -q -O - https://apt.grafana.com/gpg.key \
  | gpg --dearmor > /etc/apt/keyrings/grafana.gpg
echo "deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main" \
  > /etc/apt/sources.list.d/grafana.list

apt update && apt install -y grafana
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

> These targets work only if CT 110's firewall admits this container: that is
> what the two `-source 10.7.3.24` rules in `110.fw` (§10.3) are for. The
> broker service is bound to `127.0.0.1`, so its job must scrape through nginx
> instead, with a `/metrics` location allowed only from `10.7.3.24`.

```bash
promtool check rules /etc/prometheus/alerts.yml
systemctl restart prometheus && systemctl enable --now grafana-server
```

Import [`ops/grafana/tradingapp-dashboard.json`](ops/grafana/tradingapp-dashboard.json)
in Grafana under **Dashboards → New → Import**, and pick your Prometheus data
source for the `DS_PROMETHEUS` variable.
[`ops/grafana/README.md`](ops/grafana/README.md) lists every metric the panels
use.

Scrape the hypervisor too: `apt install prometheus-pve-exporter` on the
Proxmox host shows per-guest CPU, memory and disk pressure. On an all-LXC
host the containers share one kernel's page cache and I/O queues, so host
pressure shows up as app latency with no sign inside the container.

---

## 12. Backups and snapshots

Three layers, each covering what the others miss.

### 12.1 Guest backups (vzdump)

**Datacenter → Backup → Add**: select 110, 120 and 130 (and 140 if present),
storage `local` (or a Proxmox Backup Server or NFS share), schedule nightly,
mode **Snapshot**, compression `zstd`.

CLI equivalent:

```bash
vzdump 110 120 130 --mode snapshot --compress zstd --storage local
```

Set up failure notifications under **Datacenter → Notifications**. The old
`--mailnotification` flag is deprecated on PVE 8 and gone on PVE 9.

Two container notes:

- **Mode `snapshot` needs snapshot-capable storage** (LVM-thin, ZFS, btrfs,
  Ceph). On directory storage vzdump falls back to `suspend`, which pauses the
  container during the copy. On a trading host in market hours, that is an
  outage. Check your storage type before scheduling.
- **The `mp0` data volume on CT 120 is included** because §5.1 set
  `backup=1`. Check with `pct config 120 | grep mp0`. A mount point marked
  `backup=0` is skipped without warning.

**A vzdump of the database container is not a database backup.** A container
has no guest agent to freeze the filesystem, so the copy is crash-consistent
at best: it restores like a machine that lost power. Good enough to recover
the infrastructure, not to restore yesterday's data cleanly. That is what
§12.2 is for.

### 12.2 Database dumps

In CT 120, create `/usr/local/bin/backup-tradingapp.sh`:

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

`/var/backups` is on the container's root volume, not the `mp0` data volume,
so losing the data volume does not take the dumps with it. Better still, copy
them off the host.

Restore into a database where the `timescaledb` extension already exists:

```bash
sudo -u postgres psql -d tradingapp -c 'SELECT timescaledb_pre_restore();'
sudo -u postgres pg_restore -d tradingapp -c /var/backups/tradingapp/<file>.dump
sudo -u postgres psql -d tradingapp -c 'SELECT timescaledb_post_restore();'
```

Test a restore at least once. An untested backup is a guess. Check
Timescale's version notes if you cross a major version.

The dumps hold the broker credentials and other secrets, sealed with
`SETTINGS_ENCRYPTION_KEY`. A restore is only useful with that key (§12.4).

### 12.3 Pre-change snapshots

Before every app update or IB Gateway upgrade:

```bash
pct snapshot 110 pre-update-$(date -u +%Y%m%d)
pct snapshot 120 pre-update-$(date -u +%Y%m%d)
```

Snapshot CT 120 too: an app update can apply database migrations. Roll back
with `pct rollback 110 <snapname>` (and 120 to the same point). Prune old
snapshots: on LVM-thin and ZFS they take real space and eventually stall
writes.

### 12.4 What is not backed up

- **`SETTINGS_ENCRYPTION_KEY`** opens every secret stored in the database.
  Print it with `./tradingapp.sh backup-key` and keep it in a password
  manager. Without it a rebuild (§8.6) cannot read the stored secrets. The
  rest of `.env` is only the database address and password, which you already
  have.
- **IBC's `config.ini`** in CT 130 holds your IB credentials. Keep a copy the
  same way.
- **Redis** is a cache and stream bus. Losing it is harmless; it refills.
- **The internal secrets volume** (broker service token, Redis password) is
  regenerated on a new host. Nothing to keep.
- **Docker images** rebuild from the repository.

---

## 13. Boot order and auto-start

The `--startup order=` values bring the deployment up in sequence after a host
reboot. On an all-LXC host that is every kernel update:

```bash
pct set 120 --onboot 1 --startup order=1,up=60     # database first, then wait 60s
pct set 130 --onboot 1 --startup order=1,up=30     # IB Gateway
pct set 110 --onboot 1 --startup order=2,up=30     # app stack
pct set 150 --onboot 1 --startup order=3           # monitoring
qm  set 140 --onboot 1 --startup order=1           # MT5 VM, if present
```

The backend waits for its database however long it takes, so a slow database
start delays the app but does not break it.

Inside CT 110 every Compose service has `restart: unless-stopped`, so Docker
restarts the stack once the container is up. For an explicit systemd unit,
call `tradingapp.sh`, not `docker compose`. The script knows when the host
runs the bundled database (`install` writes `.tradingapp.with-db`) and adds
`docker-compose.db.yml`. A bare `docker compose up -d` would start the stack
without it.

```ini
# /etc/systemd/system/tradingapp.service
[Unit]
Description=TradingApp
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/tradingapp
ExecStart=/bin/bash /opt/tradingapp/tradingapp.sh start
ExecStop=/bin/bash /opt/tradingapp/tradingapp.sh stop
User=tradingapp

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now tradingapp
```

`install/install.sh service` writes the same unit.

Test the whole chain with a real host reboot during a market close, then run
`./tradingapp.sh test`. A boot order that has never been tested does not
count, and on containers every kernel update tests it for you.

---

## 14. Day-2 operations

```bash
# Upgrade the application (inside CT 110). Migrations apply themselves.
cd /opt/tradingapp
git pull && ./tradingapp.sh install

# State
./tradingapp.sh status           # containers
./tradingapp.sh doctor           # database, schema, key, brokers, .env
./tradingapp.sh migrate          # show the schema state, apply anything pending now

# Logs
./tradingapp.sh logs             # recent lines per service
./tradingapp.sh logs follow      # stream

# Resource pressure
docker stats
docker system df                 # image and volume growth
```

Other maintenance commands:

| Command | Does |
|---|---|
| `backup-key` | Prints `SETTINGS_ENCRYPTION_KEY`, to store off the host |
| `settings-import` | Moves settings still in `.env` into the app |
| `rotate-internal-secrets` | Replaces the broker service token and Redis password |
| `forget-secrets` | Clears secrets sealed with a lost key (asks you to type FORGET) |
| `clean [--include-database]` | Removes containers and images. The database volume is kept unless you add `--include-database` and type DELETE |

From the Proxmox host:

```bash
pct list                         # all containers and states
pct exec 110 -- docker ps        # run a command without entering
pct df 110                       # per-volume usage
```

Once the base deployment is stable, turn on the optional subsystems one at a
time, and check each before the next. Each makes broker requests on a timer,
so turning several on at once makes a faulty one hard to find. Each is a
switch on the Settings page:

| Feature | Key | Where it is documented |
|---|---|---|
| Scheduled backfill | `BACKFILL_ENABLED` | [`DEPLOYMENT.md` § Data collection](DEPLOYMENT.md#data-collection) |
| Executions (fills) sync | `EXECUTIONS_SYNC_ENABLED` | [`DEPLOYMENT.md` § Executions sync](DEPLOYMENT.md#executions-fills-sync) |
| Systematic strategies | `SYSTEMATIC_ENABLED` | [`SYSTEMATIC_TRADING_ROADMAP.md`](docs/plans/SYSTEMATIC_TRADING_ROADMAP.md) |
| Strategy auto-execution | `SYSTEMATIC_EXECUTION_ENABLED`, after Telegram, the heartbeat URL and the account limits are set | [`PAPER_DEPLOYMENT_RUNBOOK.md`](PAPER_DEPLOYMENT_RUNBOOK.md), [`FEATURES.md` § Risk controls](FEATURES.md#risk-controls-kill-switch--alerting) |
| Live order placement | `LIVE_TRADING_ENABLED` (needs a trading token and MFA) | [`DEPLOYMENT.md` § Enabling live trading](DEPLOYMENT.md#enabling-live-trading) |

Proxmox routine: patch the host during a market close and reboot (all
containers restart together, see §13). Watch storage headroom with
`pvesm status`: an LVM-thin pool that reaches 100% corrupts data. Review
`journalctl -u pve-firewall` after firewall edits.

---

## 15. Proxmox-specific troubleshooting

### Docker-in-LXC

| Symptom | Cause and fix |
|---|---|
| `docker: failed to start daemon`, or containerd exits at once | `keyctl=1` missing. `pct set 110 --features nesting=1,keyctl=1` and restart the container. |
| Docker starts but every `run` fails with an overlay or mount error | `nesting=1` missing, or ZFS-backed storage with `overlay2`. Add `fuse=1`, install `fuse-overlayfs`, set it in `/etc/docker/daemon.json`, then `rm -rf /var/lib/docker` and restart Docker. This discards the images; `./tradingapp.sh install` rebuilds them. |
| `docker info` shows storage driver `vfs` | Docker fell back to the slow, space-hungry driver. Same fix as above. |
| Docker warns about `/dev/kmsg` | Harmless in LXC. If a tool insists, `ln -s /dev/console /dev/kmsg` in a startup script. |
| Docker works only after making the container privileged | Don't ship that. Go back to `--unprivileged 1` and add the feature flag that was actually missing (`nesting`, `keyctl` or `fuse`). |
| AppArmor denials in `dmesg` on the host, Docker misbehaving | Last resort: add `lxc.apparmor.profile: unconfined` to `/etc/pve/lxc/110.conf`. This removes much of the container boundary on the host that holds your broker credentials. Find the missing feature flag instead if you can. |

### Containers and the host

| Symptom | Cause and fix |
|---|---|
| `pct create` fails: "storage does not support container images" | You chose an ISO-only directory storage. Use `local-lvm` or `local-zfs`, or enable *Container* content on that storage. |
| `pct snapshot` fails | Directory storage has no snapshots. Move the container to LVM-thin or ZFS, or rely on vzdump. |
| `free -h` in a container shows the host's total RAM | lxcfs is not mounted for it. Restart the container. Until then, tools that size from `/proc/meminfo` (such as `timescaledb-tune`, §5.2) size for memory the container cannot have. |
| A container kills a process well below the host's free memory | Working as designed: LXC memory is a hard limit. Raise it: `pct set 110 --memory 12288`. |
| Time is wrong in a container | Fix the host clock (§3.3). Containers cannot set time. |
| `ufw enable` fails in an unprivileged container | Expected on some kernels and profiles. Use the Proxmox per-guest firewall (§10.3). |
| Proxmox firewall rules have no effect on a container | The interface lacks `firewall=1`. `pct set 110 --net0 name=eth0,bridge=vmbr0,firewall=1,ip=10.7.3.20/24,gw=10.7.3.1`. |
| Everything unreachable after enabling the firewall | Datacenter rules deny by default once enabled. From the physical or IPMI console: `pvefw-stop`, fix `/etc/pve/firewall/cluster.fw`, restart. |
| Host storage full, containers stuck | LVM-thin pool full, usually from snapshots or backups on `local`. Delete old ones, then restart the affected containers. |

### Application-level

The backend reports what it is waiting for on `/api/health/ready`, and the
page shows the same message. `./tradingapp.sh doctor` prints it too.

| State or symptom | Cause and fix |
|---|---|
| `waiting_for_database` | The backend cannot reach the database. It keeps retrying with no deadline. From CT 110 check `nc -vz 10.7.3.21 5432`, then `listen_addresses`, the `pg_hba.conf` line, the password in `.env`, and the firewall rules (§5.4, §10.3). |
| `migrating` | Normal on first start and after an upgrade. Wait. |
| `migration_failed` | A migration did not apply. The detail names it. Check that the `timescaledb` extension exists (§5.3) and the role owns the database. Fix it, then `./tradingapp.sh migrate` or `restart`. |
| `key_mismatch` | `SETTINGS_ENCRYPTION_KEY` in `.env` is not the key this database was sealed with. Put the saved key back (§8.6). If it is lost, `./tradingapp.sh forget-secrets`. |
| A broker shows as down on Settings > Connections | The app's own check failed. For IB, see §6.3 to §6.5 (logged in, trusted IPs, firewall). For MT5, check the sidecar URL, the secret on both sides, and the firewall rule (§7). |
| Routes to part of the LAN disappear on CT 110 only | Docker's `172.20.0.0/16` bridge collides with a real subnet. See §2. |
| Ports still open from the LAN despite `ufw enable` | Docker's iptables rules run before ufw. Filter at the hypervisor (§10.3). |
| A `docker-compose.override.yml` you created has no effect | `tradingapp.sh` passes `-f docker-compose.yml`, which stops override pickup. Edit `docker-compose.yml` directly (§10.3). |
| IB Gateway logged out, no data, no error | The known gap in §6.5. Check `systemctl status ibgateway` in CT 130 and reconnect over the VNC tunnel (§6.3). |

Other app issues (charts, MT5 `501` or `503`, timestamps) are in
[`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) and
[`DEPLOYMENT.md` § Common issues](DEPLOYMENT.md#common-issues). Start with
`./tradingapp.sh doctor`.

---

## Appendix A: single-container quickstart

For evaluation, or a small hypervisor. One LXC runs the app and the bundled
TimescaleDB. IB Gateway lives wherever it already lives.

`install/proxmox-create-ct.sh --bundled-db` does step 1 as a script.

1. On the Proxmox host, create the container:

   ```bash
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

2. Inside the container, install Docker (add fuse-overlayfs first on ZFS,
   §4.2) and create the deploy user:

   ```bash
   apt update && apt install -y git curl sudo ca-certificates openssl
   curl -fsSL https://get.docker.com | sh
   docker run --rm hello-world        # must pass before you go on

   adduser --disabled-password --gecos "" tradingapp
   usermod -aG sudo,docker tradingapp
   echo 'tradingapp ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/tradingapp && chmod 440 /etc/sudoers.d/tradingapp
   mkdir -p /opt/tradingapp && chown tradingapp:tradingapp /opt/tradingapp
   ```

3. As the deploy user, clone and install:

   ```bash
   su - tradingapp
   git clone https://github.com/41agent41/tradingapp.git /opt/tradingapp
   cd /opt/tradingapp
   ./tradingapp.sh install
   ./tradingapp.sh backup-key       # store the key off this host
   ```

4. Sign in and add brokers (§8.3 to §8.5).

The data lives in the `tradingapp_pgdata` Docker volume (Docker adds the
project name, so it shows as `tradingapp_tradingapp_pgdata`).
`./tradingapp.sh clean` keeps it unless you add `--include-database`. Plan the
move to a database container (§5.5) before you collect history worth keeping.

---

## Appendix B: full deployment checklist

**Hypervisor**

- [ ] Proxmox VE updated; enterprise repository off, no-subscription on
- [ ] Host timezone UTC, `chrony` running and synchronised (containers use it)
- [ ] Container storage type known: LVM-thin or dir, or ZFS (§1.2)
- [ ] Ubuntu LXC template downloaded
- [ ] LAN subnet does not overlap `172.20.0.0/16`
- [ ] Datacenter firewall configured, UI and SSH access checked before logout

**App container (110)**

- [ ] Created unprivileged with `nesting=1,keyctl=1` (plus `fuse=1` on ZFS)
- [ ] `net0` carries `firewall=1`
- [ ] `docker run --rm hello-world` passes; storage driver is `overlay2` or
      `fuse-overlayfs`, not `vfs`
- [ ] Non-root `tradingapp` user with sudo and the docker group
- [ ] Repository cloned to `/opt/tradingapp`
- [ ] `./tradingapp.sh install --external-db` (or `install`) finished with all
      checks passed
- [ ] Encryption key saved off the host (`./tradingapp.sh backup-key`)
- [ ] Login password chosen on the first-run screen (`./tradingapp.sh setup-code`)
- [ ] Brokers added under Settings > Connections as paper, each tested
- [ ] Getting started checklist on the Settings page complete
- [ ] Charts render in a browser
- [ ] nginx and TLS in front (production); Settings > Network set to the
      public origin

**Database container (120)**

- [ ] Data directory on its own mount point, `backup=1` confirmed
- [ ] PostgreSQL and TimescaleDB installed; `timescaledb-tune` sized against
      the container's limit, not the host's RAM
- [ ] `tradingapp` role and database created, password recorded
- [ ] `timescaledb` extension created
- [ ] `listen_addresses` and `pg_hba.conf` scoped to CT 110 only
- [ ] `pg_dump` cron installed and one restore tested

**IB Gateway container (130)**

- [ ] IB Gateway installed, logged in to the **paper** account
- [ ] API enabled, socket port set, CT 110 in Trusted IPs
- [ ] IBC configured; `ibgateway.service` enabled and surviving a restart
- [ ] VNC not exposed to the LAN (SSH tunnel only)
- [ ] Port 4001/4002 restricted to CT 110

**Operations**

- [ ] Proxmox firewall on 110 drops 3000, 6379 and 8000 from the LAN, checked
      with `nc` from another machine
- [ ] `--onboot` and `--startup order` set on every guest; host reboot tested
- [ ] vzdump schedule covering 110, 120 and 130; storage supports mode
      `snapshot` (not falling back to `suspend`)
- [ ] Baseline snapshots taken after the first green deploy
- [ ] Prometheus scraping both services; alert rules loaded and checked
- [ ] Heartbeat URL points at a monitor off this Proxmox host, and stopping
      the backend container pages you
- [ ] Grafana dashboard imported
- [ ] Optional subsystems (backfill, executions sync, systematic) turned on
      one at a time, each checked before the next
- [ ] Rebuild procedure (§8.6) understood: CT 120 kept, key saved

---

**Related documentation:** [`DEPLOYMENT.md`](DEPLOYMENT.md) (application
deployment reference), [`AGENT_INSTALL_RUNBOOK.md`](AGENT_INSTALL_RUNBOOK.md)
(unattended install), [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md),
[`backend/src/database/README.md`](backend/src/database/README.md) (schema
detail), [`FEATURES.md`](FEATURES.md) (what the deployed system does).
