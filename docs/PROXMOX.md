# TradingApp on Proxmox VE

This guide builds the infrastructure for TradingApp on a machine with only
Proxmox VE installed: the hypervisor settings, a database container, the app
container, the broker hosts, the hypervisor firewall, monitoring, backups and
boot order.

It follows the same order as [INSTALL.md](INSTALL.md): database, then app,
then brokers. Wherever the work inside a guest is the same as on any host,
this guide points back to INSTALL.md instead of repeating it.

Guests are LXC containers wherever the workload allows.
[§1.2](#12-why-lxc-and-the-two-places-it-costs-you) says what that needs,
and names the one component that cannot be a container. For evaluation, one
container is enough: [Appendix A](#appendix-a-single-container-quickstart).

> **Paper only.** Every step here keeps to paper: live trading stays off and
> every broker connection is a paper or demo account.

---

## Contents

1. [Target topology](#1-target-topology)
2. [Plan the deployment](#2-plan-the-deployment)
3. [Proxmox host post-install](#3-proxmox-host-post-install)
4. [Create the database container](#4-create-the-database-container)
5. [Create the app container](#5-create-the-app-container)
6. [Create the IB Gateway container](#6-create-the-ib-gateway-container)
7. [Create the MT5 sidecar VM](#7-create-the-mt5-sidecar-vm)
8. [Firewall at the hypervisor](#8-firewall-at-the-hypervisor)
9. [Optional: monitoring container](#9-optional-monitoring-container)
10. [Backups and snapshots](#10-backups-and-snapshots)
11. [Boot order](#11-boot-order)
12. [Proxmox troubleshooting](#12-proxmox-troubleshooting)
13. [Appendix A: single-container quickstart](#appendix-a-single-container-quickstart)
14. [Appendix B: checklist](#appendix-b-checklist)

---

## 1. Target topology

### 1.1 The shape of it

The Docker stack is Linux. IB Gateway and MetaTrader 5 are logged-in GUI
sessions that cannot live inside it, so each gets its own guest. Every guest
is an LXC container except MT5:

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

OANDA and Alpaca need no guest: they are cloud APIs the broker service calls
over HTTPS.

### 1.2 Why LXC, and the two places it costs you

Containers share the host kernel. They boot in seconds, carry no guest-OS
memory overhead, and `pct enter` is faster than a console. For four
long-lived Linux services on one hypervisor, that is a real gain.

It costs you in two places.

**1. MT5 runs Windows code.** An LXC guest always runs the host's Linux
kernel. The `MetaTrader5` Python package needs Windows Python and a live
terminal, so this guide puts the MT5 sidecar in a Windows VM (§7). It can also
run under Wine on Linux, in a VM or a privileged LXC
([INSTALL.md § 5.2](INSTALL.md#52-metatrader-5)). If you don't trade MT5,
every guest is an LXC.

**2. Docker-in-LXC needs specific container features,** set at create time:

| Requirement | Why |
|---|---|
| `--features nesting=1` | Lets the container run its own container runtime and systemd |
| `--features keyctl=1` | containerd uses the kernel keyring; without it Docker fails to start |
| `--unprivileged 1` | Keep it. A privileged container with nesting is close to root on the hypervisor |
| Storage driver | `overlay2` works on LVM-thin or ext4-backed rootfs. On ZFS it does not: add `fuse=1` and use `fuse-overlayfs` (§5.2) |

Check which case you are in before you create anything:

```bash
pvesm status        # the Type column: lvmthin or dir is fine; zfspool needs §5.2's extra step
```

An unprivileged LXC is a solid boundary, but it shares the kernel: a host
kernel update reboots every container at once. If that is not acceptable for
the app, make that one guest a VM; nothing else here changes.

---

## 2. Plan the deployment

Fill in this table first. Later steps refer back to it.

| ID | Name | Type | Purpose | Cores | RAM | Disk | IP |
|---|---|---|---|---|---|---|---|
| 120 | `tradingapp-db` | **LXC** | PostgreSQL + TimescaleDB | 4 | 8 GB | 32 GB + 200 GB mp | `10.7.3.21` |
| 110 | `tradingapp-app` | **LXC** | Docker stack + nginx | 4 | 8 GB | 60 GB | `10.7.3.20` |
| 130 | `ib-gateway` | **LXC** | IB Gateway session (headless X) | 2 | 4 GB | 40 GB | `10.7.3.22` |
| 140 | `mt5-bridge` *(opt)* | **VM** | Windows + MT5 + sidecar | 2 | 4 GB | 80 GB | `10.7.3.23` |
| 150 | `monitoring` *(opt)* | **LXC** | Prometheus + Grafana | 2 | 2 GB | 40 GB | `10.7.3.24` |

Also decide:

- **Gateway and DNS**, for example `10.7.3.1` for both.
- **Domain** for TLS, for example `trading.example.com` → `10.7.3.20`.
- **Database size.** Bars and ticks are TimescaleDB hypertables kept for 2
  years and 30 days. The database gets its own mount point (§4.1) on a pool
  you can grow; tick data across many symbols grows fast.
- **LXC memory is a hard cgroup limit**, not a balloon. Go over it and the
  kernel kills a process inside the container. Size generously and keep swap
  small.

> **Subnet collision.** The Compose stack creates a bridge network on
> `172.20.0.0/16` with fixed addresses (`docker-compose.yml`). If your LAN,
> VPN or another Proxmox bridge uses any part of it, the app container loses
> its routes there. Pick a different LAN range, or change the
> `networks.tradingapp-network.ipam` block and every `172.20.0.x` address in
> `docker-compose.yml` and `docker-compose.db.yml` together.

---

## 3. Proxmox host post-install

In the web UI shell (`https://<pve-ip>:8006` → node → **Shell**) or over SSH
as root.

### 3.1 Confirm the install

```bash
pveversion -v | head -3
ip -br addr        # vmbr0 holds the host's LAN address
pvesm status       # note the Type column (§1.2)
```

### 3.2 Switch to the no-subscription repository

A fresh install points at the enterprise repository, which answers 401
without a subscription key and blocks all updates.

<details>
<summary><b>Proxmox VE 9.x</b></summary>

```bash
sed -i 's/^Enabled: true/Enabled: false/' /etc/apt/sources.list.d/pve-enterprise.sources
sed -i 's/^Enabled: true/Enabled: false/' /etc/apt/sources.list.d/ceph.sources 2>/dev/null || true

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
sed -i 's/^deb/#deb/' /etc/apt/sources.list.d/pve-enterprise.list
sed -i 's/^deb/#deb/' /etc/apt/sources.list.d/ceph.list 2>/dev/null || true
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

Every container shares this kernel, so a host kernel upgrade restarts the
whole deployment. Do it during a market close.

### 3.3 Time synchronisation (host only)

Every bar, tick and fill is timestamped, the stack runs in UTC, and IB
mislabels data when the client clock drifts. LXC guests read the host's
clock and cannot set their own, so fix it once, here. Do not install chrony
or NTP inside the containers.

```bash
timedatectl set-timezone UTC
systemctl enable --now chrony
chronyc tracking | grep -E 'Reference ID|System time|Leap status'
```

Only the Windows MT5 VM (§7) needs its own time source.

### 3.4 Fetch the container template

```bash
pveam update
pveam available --section system | grep ubuntu-24
pveam download local ubuntu-24.04-standard_24.04-2_amd64.tar.zst
```

Use the filename `pveam available` lists today; the point release moves. For
the MT5 VM, also upload a Windows ISO and the VirtIO driver ISO
(<https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso>)
under **Datacenter → local → ISO Images → Upload**.

### 3.5 An SSH key for the guests

On your workstation:

```bash
ssh-keygen -t ed25519 -C "tradingapp"
ssh-copy-id root@<pve-ip>
scp ~/.ssh/id_ed25519.pub root@<pve-ip>:/root/tradingapp.pub
```

`pct create --ssh-public-keys` puts this key on each container's root
account.

---

## 4. Create the database container

The database gets its own container, so its disk, snapshots and restore path
are separate from the app's, and the app container can be rebuilt without
touching your data (§5.5). This is [INSTALL.md step 2B](INSTALL.md#2b-external-database).

To use the bundled database instead, skip this section and run `install`
without `--external-db` in §5.4. That suits evaluation; for anything longer,
the data then shares a disk and a backup window with the app.

### 4.1 Create it, with a separate data volume

No nesting or keyctl: PostgreSQL runs directly in the container.

```bash
CTID=120
STORAGE=local-lvm      # pvesm status; ZFS installs usually have local-zfs

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
before PostgreSQL is installed so its data lands there from the start.
`backup=1` includes it in vzdump runs. Grow it later with
`pct resize 120 mp0 +100G`.

### 4.2 Install and configure PostgreSQL + TimescaleDB

```bash
pct enter 120
apt update && apt full-upgrade -y
ln -sf /usr/share/zoneinfo/UTC /etc/localtime
apt install -y sudo
```

Then follow [INSTALL.md § 2B](INSTALL.md#2b-external-database) steps 1 to 3
inside the container, with the database host `10.7.3.21` and the app host
`10.7.3.20`. Two Proxmox notes:

- **Before `timescaledb-tune`**, run `free -h`. It must show the container's
  limit (8 GB), which Proxmox's lxcfs provides. If it shows the host's total,
  pass `--memory 8GB` to `timescaledb-tune`, or it sizes PostgreSQL for
  memory the container cannot have.
- **ufw inside an unprivileged LXC** depends on the host's netfilter modules
  and the container's AppArmor profile. If `ufw enable` errors, skip it: the
  hypervisor firewall (§8) covers the same ground and cannot be bypassed from
  inside the guest.

`POSTGRES_SSL=false` is fine here: both containers sit on one hypervisor
bridge.

---

## 5. Create the app container

CT 110 runs the Docker Compose stack and nginx.
[`install/proxmox-create-ct.sh`](../install/proxmox-create-ct.sh) does §5.1 as
a script (and adds `fuse=1` itself on ZFS).

### 5.1 Create it

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

On ZFS-backed storage add `fuse=1`:
`pct set $CTID --features nesting=1,keyctl=1,fuse=1`.

Three flags fail much later and confusingly if wrong: `nesting=1` (Docker
won't start), `keyctl=1` (containerd needs the keyring) and `firewall=1` on
`net0` (without it the firewall in §8 does nothing for this guest).

### 5.2 Install Docker

```bash
pct enter 110
apt update && apt full-upgrade -y
apt install -y git curl ca-certificates openssl sudo
ln -sf /usr/share/zoneinfo/UTC /etc/localtime
```

**On ZFS storage**, install the fuse-overlayfs driver before Docker first
starts. Otherwise Docker picks a driver that does not work and remembers it:

```bash
apt install -y fuse-overlayfs
mkdir -p /etc/docker
echo '{ "storage-driver": "fuse-overlayfs" }' > /etc/docker/daemon.json
```

Then:

```bash
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
docker info | grep -E 'Storage Driver|Cgroup'
docker run --rm hello-world
```

`hello-world` is the real test of the LXC setup. If it fails, fix it here
(§12); do not debug it through the app. `./tradingapp.sh install` would
install Docker itself, but it does not know about ZFS, which is why it is
done by hand here.

### 5.3 Create the deploy user

```bash
adduser --disabled-password --gecos "" tradingapp
usermod -aG sudo,docker tradingapp
echo 'tradingapp ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/tradingapp
chmod 440 /etc/sudoers.d/tradingapp
mkdir -p /home/tradingapp/.ssh /opt/tradingapp
cp /root/.ssh/authorized_keys /home/tradingapp/.ssh/
chown -R tradingapp:tradingapp /home/tradingapp/.ssh /opt/tradingapp
chmod 700 /home/tradingapp/.ssh && chmod 600 /home/tradingapp/.ssh/authorized_keys
exit
```

From your workstation, check the path you will use: `ssh tradingapp@10.7.3.20`
then `docker ps`, which must work without sudo.

### 5.4 Install the app

As `tradingapp` in CT 110:

```bash
git clone https://github.com/41agent41/tradingapp.git /opt/tradingapp
cd /opt/tradingapp
./tradingapp.sh install --external-db      # host 10.7.3.21 and the password from §4.2
./tradingapp.sh backup-key                 # store the key off this host
```

With the bundled database instead, run `./tradingapp.sh install` with no
flag. To skip the questions, put `POSTGRES_HOST` and `POSTGRES_PASSWORD` in an
answers file (mode 600) and add `--answers <file> --non-interactive`.

Then continue with [INSTALL.md step 4](INSTALL.md#4-sign-in-and-secure-the-app)
at `http://10.7.3.20:3000`. Brokers on their own guests come from §6 and §7
here.

Snapshot the guests once the install passes. LXC snapshots are near-instant
on LVM-thin and ZFS (directory storage cannot snapshot):

```bash
pct snapshot 120 clean-install --description "TimescaleDB, role and extension"
pct snapshot 110 clean-deploy  --description "First green install"
```

### 5.5 Rebuild this container

When CT 110 is lost or broken. CT 120 stays as it is; you need the key you
saved with `backup-key`.

1. Destroy or set aside the old CT 110. Do not touch CT 120.
2. Do §5.1 to §5.3 again.
3. Install with the saved key:

   ```bash
   git clone https://github.com/41agent41/tradingapp.git /opt/tradingapp && cd /opt/tradingapp
   umask 077
   cat > ~/install.answers <<'EOF'
   POSTGRES_HOST=10.7.3.21
   POSTGRES_PASSWORD=<the database password>
   SETTINGS_ENCRYPTION_KEY=<the key from backup-key>
   EOF
   ./tradingapp.sh install --external-db --answers ~/install.answers --non-interactive
   rm ~/install.answers
   ```

The backend adopts the existing schema, applies only pending migrations,
checks the key and comes up configured: no setup screen, and your login,
brokers and settings are already there. Redo nginx (INSTALL.md step 8). If it
stops with `key_mismatch`, the key is wrong; see
[OPERATIONS.md § Lost encryption key](OPERATIONS.md#lost-encryption-key).

---

## 6. Create the IB Gateway container

The broker service connects out to IB Gateway's socket API. IB Gateway is a
Java GUI that must stay logged in, and it is the most fragile part of the
deployment, so it gets its own guest and its own snapshots. It runs well in an
LXC: you drive the GUI through a virtual framebuffer and VNC once, and IBC
(<https://github.com/IbcAlpha/IBC>) handles login and daily restarts after
that.

### 6.1 Create it

```bash
pct create 130 local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst \
  --hostname ib-gateway \
  --cores 2 --memory 4096 --swap 1024 \
  --rootfs local-lvm:40 \
  --net0 name=eth0,bridge=vmbr0,firewall=1,ip=10.7.3.22/24,gw=10.7.3.1 \
  --nameserver 10.7.3.1 --searchdomain lan \
  --features nesting=1 \
  --unprivileged 1 \
  --ssh-public-keys /root/tradingapp.pub \
  --onboot 1 --startup order=1,up=30 \
  --start 1
```

`nesting=1` here is for systemd, not Docker.

### 6.2 Install IB Gateway and IBC

```bash
pct enter 130
apt update && apt full-upgrade -y
ln -sf /usr/share/zoneinfo/UTC /etc/localtime
apt install -y wget unzip xvfb x11vnc xterm libxtst6 libxrender1 libxi6 fontconfig

wget -O /tmp/ibgw.sh \
  https://download2.interactivebrokers.com/installers/ibgateway/stable-standalone/ibgateway-stable-standalone-linux-x64.sh
chmod +x /tmp/ibgw.sh && /tmp/ibgw.sh -q     # installs to ~/Jts

# IBC: check https://github.com/IbcAlpha/IBC/releases for the current version.
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
# On your workstation; then point a VNC client at localhost:5900
ssh -L 5900:localhost:5900 root@10.7.3.22
```

Log in to your **paper** account and set the API options as in
[INSTALL.md § 5.3](INSTALL.md#53-interactive-brokers) step 2, with Trusted
IPs `10.7.3.20` and socket port `4002`. They are saved in `~/Jts`, so you do
this once. Then stop the temporary processes
(`pkill x11vnc; pkill -f ibgateway; pkill Xvfb`).

### 6.4 Run it as a service under IBC

Put your credentials and `TradingMode=paper` in `/opt/ibc/config.ini`, then:

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

`xvfb-run` owns the framebuffer as one supervised process. Do not start
`Xvfb` from `ExecStartPre`: it must finish before `ExecStart` runs, so a
long-running `Xvfb` there hangs the unit.

```bash
systemctl daemon-reload && systemctl enable --now ibgateway
ss -ltnp | grep 4002        # the API socket is listening
```

### 6.5 Firewall and connect

```bash
ufw allow from 10.7.3.0/24 to any port 22 proto tcp
ufw allow from 10.7.3.20 to any port 4002 proto tcp
ufw --force enable
```

Back it with a hypervisor rule (§8). Then add the connection in the app:
[INSTALL.md § 5.3](INSTALL.md#53-interactive-brokers) step 5, host
`10.7.3.22`, port `4002`.

A logged-out IB Gateway looks like a quiet market: data just stops. The app's
connection check shows it on Settings > Connections; IBC's restarts and the
Prometheus rules (§9) help. Keep a copy of `/opt/ibc/config.ini`; it holds
your IB credentials.

---

## 7. Create the MT5 sidecar VM

Skip this unless you trade MetaTrader 5. Containers can only run Linux, and
the `MetaTrader5` package needs Windows Python and a live terminal, so this
guide uses a Windows VM. Linux under Wine in a VM or a privileged LXC also
works ([INSTALL.md § 5.2](INSTALL.md#52-metatrader-5), option 2).

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

When the Windows installer finds no disk, load the VirtIO SCSI driver from
the second CD, and install `qemu-guest-agent` from it afterwards. Give the VM
its own NTP source; unlike the containers it does not use the host clock.
Give it the address `10.7.3.23`.

Then set up the terminal and sidecar as in
[INSTALL.md § 5.2](INSTALL.md#52-metatrader-5), option 1, scope the Windows
Firewall rule for port 9100 to `10.7.3.20`, and add the connection with the
URL `http://10.7.3.23:9100`.

---

## 8. Firewall at the hypervisor

Docker publishes ports by writing its own iptables rules, which run before
ufw's, so ports 3000 and 4000 stay reachable from the LAN even with ufw on
inside CT 110. In an unprivileged container ufw may not load at all. Filter
at the hypervisor instead: Proxmox filters at each guest's interface, on the
host, before packets reach Docker, and nothing inside the guest can bypass it.
It works only on interfaces with `firewall=1`:

```bash
pct config 110 | grep net0    # must contain firewall=1
```

Enable the firewall at **Datacenter → Firewall**, then per guest at
**CT → Firewall → Options → Firewall: Yes**. From the shell:

```bash
# /etc/pve/firewall/cluster.fw: datacenter-wide. Write it whole on a fresh
# install; if one exists, merge by hand (a second [OPTIONS] or [RULES]
# section is a parse error).
cat > /etc/pve/firewall/cluster.fw <<'EOF'
[OPTIONS]
enable: 1

[RULES]
IN ACCEPT -source 10.7.3.0/24 -p tcp -dport 8006 -log nolog   # Proxmox UI
IN ACCEPT -source 10.7.3.0/24 -p tcp -dport 22   -log nolog   # SSH
EOF
```

Enabling the datacenter firewall applies a default-DROP input policy to the
host itself. The two rules keep the web UI and SSH reachable; write them in
the same edit that sets `enable: 1`, never after.

```bash
# /etc/pve/firewall/110.fw: the app container publishes only 80 and 443
cat > /etc/pve/firewall/110.fw <<'EOF'
[OPTIONS]
enable: 1
policy_in: DROP

[RULES]
IN ACCEPT -source 10.7.3.0/24 -p tcp -dport 22 -log nolog
IN ACCEPT -p tcp -dport 80  -log nolog
IN ACCEPT -p tcp -dport 443 -log nolog
# Prometheus scraping the backend from the monitoring container (§9)
IN ACCEPT -source 10.7.3.24 -p tcp -dport 4000 -log nolog
EOF
```

Give CT 120 (5432 from 10.7.3.20), CT 130 (4002 from 10.7.3.20) and VM 140
(9100 from 10.7.3.20) the same pattern in their own `<ID>.fw` files. Then
check from another machine:

```bash
nc -vz 10.7.3.20 443     # succeeds
nc -vz 10.7.3.20 3000    # must fail
nc -vz 10.7.3.21 5432    # must fail (not from the app host)
```

**Check you still have UI and SSH access before you log out.** A wrong rule
here locks you out of the hypervisor, and recovery needs the physical or IPMI
console.

> **Binding ports to localhost in Compose instead?** Not with an override
> file: `tradingapp.sh` always passes `-f docker-compose.yml`, which stops
> Docker reading `docker-compose.override.yml`. Edit the `ports:` entries in
> `docker-compose.yml` itself (for example `"127.0.0.1:4000:4000"`), expect
> `git pull` to conflict there, and keep the firewall as well.

---

## 9. Optional: monitoring container

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

Prometheus is in Ubuntu's `universe`; Grafana needs its own repository:

```bash
apt update && apt install -y prometheus apt-transport-https software-properties-common wget
mkdir -p /etc/apt/keyrings
wget -q -O - https://apt.grafana.com/gpg.key | gpg --dearmor > /etc/apt/keyrings/grafana.gpg
echo "deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main" \
  > /etc/apt/sources.list.d/grafana.list
apt update && apt install -y grafana
```

Point Prometheus at `10.7.3.20:4000`, load the alert rules and import the
dashboard as described in
[OPERATIONS.md § Prometheus and Grafana](OPERATIONS.md#prometheus-and-grafana),
then:

```bash
promtool check rules /etc/prometheus/alerts.yml
systemctl restart prometheus && systemctl enable --now grafana-server
```

Scrape the hypervisor too: `apt install prometheus-pve-exporter` on the
Proxmox host shows per-guest CPU, memory and disk pressure. On an all-LXC host
the containers share one kernel's page cache and I/O queues, so host pressure
shows up as app latency with no sign inside the container.

---

## 10. Backups and snapshots

Three layers, each covering what the others miss.

### 10.1 Guest backups (vzdump)

**Datacenter → Backup → Add**: select 110, 120 and 130 (and 140 if present),
storage `local` (or a Proxmox Backup Server or NFS share), schedule nightly,
mode **Snapshot**, compression `zstd`. CLI equivalent:

```bash
vzdump 110 120 130 --mode snapshot --compress zstd --storage local
```

Set failure notifications under **Datacenter → Notifications**.

- Mode `snapshot` needs snapshot-capable storage (LVM-thin, ZFS, btrfs,
  Ceph). On directory storage vzdump falls back to `suspend`, which pauses
  the container during the copy: an outage in market hours.
- CT 120's `mp0` is included because §4.1 set `backup=1`
  (`pct config 120 | grep mp0`). A mount point marked `backup=0` is skipped
  without warning.

**A vzdump of the database container is not a database backup.** It is
crash-consistent at best: it restores like a machine that lost power. That
recovers the infrastructure, not yesterday's data cleanly.

### 10.2 Database dumps

In CT 120, `/usr/local/bin/backup-tradingapp.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
BACKUP_DIR=/var/backups/tradingapp
mkdir -p "$BACKUP_DIR"
sudo -u postgres pg_dump -Fc tradingapp > "$BACKUP_DIR/tradingapp_$(date -u +%Y%m%d_%H%M%S).dump"
find "$BACKUP_DIR" -name 'tradingapp_*.dump' -mtime +14 -delete
```

```bash
chmod +x /usr/local/bin/backup-tradingapp.sh
echo '10 2 * * * root /usr/local/bin/backup-tradingapp.sh' > /etc/cron.d/tradingapp-backup
```

`/var/backups` is on the container's root volume, not `mp0`, so losing the
data volume does not take the dumps with it. Better still, copy them off the
host. Restore and the encryption key:
[OPERATIONS.md § Backups](OPERATIONS.md#backups-and-restore).

### 10.3 Pre-change snapshots

Before every app upgrade or IB Gateway upgrade:

```bash
pct snapshot 110 pre-update-$(date -u +%Y%m%d)
pct snapshot 120 pre-update-$(date -u +%Y%m%d)
```

Snapshot CT 120 too: an upgrade can apply migrations. Roll back with
`pct rollback 110 <snapname>` (and 120 to the same point). Prune old
snapshots: on LVM-thin and ZFS they take real space and eventually stall
writes.

### 10.4 What is not in these backups

- **`SETTINGS_ENCRYPTION_KEY`** (`./tradingapp.sh backup-key`): keep it in a
  password manager. Without it a rebuild cannot read the stored secrets.
- **IBC's `config.ini`** in CT 130: your IB credentials.
- **Redis** and the **internal secrets volume** are regenerated; nothing to
  keep. **Docker images** rebuild from the repository.

---

## 11. Boot order

```bash
pct set 120 --onboot 1 --startup order=1,up=60     # database first, then wait 60s
pct set 130 --onboot 1 --startup order=1,up=30     # IB Gateway
qm  set 140 --onboot 1 --startup order=1           # MT5 VM, if present
pct set 110 --onboot 1 --startup order=2,up=30     # app
pct set 150 --onboot 1 --startup order=3           # monitoring
```

The backend waits for its database however long it takes, so a slow database
start delays the app but does not break it. Inside CT 110 the containers
restart on their own (`restart: unless-stopped`); for an explicit unit see
[INSTALL.md step 9](INSTALL.md#9-backups-and-start-on-boot) (with
`/opt/tradingapp`), or `install/install.sh service`.

Test the chain with a real host reboot during a market close, then
`./tradingapp.sh test`. On containers every kernel update tests it for you.

---

## 12. Proxmox troubleshooting

App states (`waiting_for_database`, `key_mismatch` and the rest) and broker
problems are in [OPERATIONS.md § Troubleshooting](OPERATIONS.md#troubleshooting).

### Docker-in-LXC

| Symptom | Cause and fix |
|---|---|
| `docker: failed to start daemon`, or containerd exits at once | `keyctl=1` missing. `pct set 110 --features nesting=1,keyctl=1` and restart the container. |
| Docker starts but every `run` fails with an overlay or mount error | `nesting=1` missing, or ZFS storage with `overlay2`. Add `fuse=1`, install `fuse-overlayfs`, set it in `/etc/docker/daemon.json`, then `rm -rf /var/lib/docker` and restart Docker. This discards the images; `./tradingapp.sh install` rebuilds them. |
| `docker info` shows storage driver `vfs` | Docker fell back to the slow, space-hungry driver. Same fix. |
| Docker warns about `/dev/kmsg` | Harmless in LXC. |
| Docker works only after making the container privileged | Don't ship that. Go back to `--unprivileged 1` and add the feature flag that was missing (`nesting`, `keyctl` or `fuse`). |
| AppArmor denials in the host's `dmesg` | Last resort: `lxc.apparmor.profile: unconfined` in `/etc/pve/lxc/110.conf`. This removes much of the boundary around the host that holds your broker credentials; find the missing feature flag instead if you can. |

### Containers and the host

| Symptom | Cause and fix |
|---|---|
| `pct create`: "storage does not support container images" | An ISO-only storage. Use `local-lvm` or `local-zfs`, or enable *Container* content on it. |
| `pct snapshot` fails | Directory storage has no snapshots. Move the container to LVM-thin or ZFS, or rely on vzdump. |
| `free -h` in a container shows the host's total RAM | lxcfs is not mounted for it. Restart the container. |
| A process is killed well below the host's free memory | LXC memory is a hard limit. Raise it: `pct set 110 --memory 12288`. |
| Time is wrong in a container | Fix the host clock (§3.3). Containers cannot set time. |
| `ufw enable` fails in an unprivileged container | Expected on some kernels and profiles. Use the hypervisor firewall (§8). |
| Firewall rules have no effect on a container | The interface lacks `firewall=1`: `pct set 110 --net0 name=eth0,bridge=vmbr0,firewall=1,ip=10.7.3.20/24,gw=10.7.3.1`. |
| Everything unreachable after enabling the firewall | From the physical or IPMI console: `pvefw-stop`, fix `/etc/pve/firewall/cluster.fw`, restart. |
| Host storage full, containers stuck | LVM-thin pool full, usually from snapshots or backups on `local`. Delete old ones, then restart the containers. |
| Routes to part of the LAN vanish on CT 110 only | Docker's `172.20.0.0/16` collides with a real subnet (§2). |
| `waiting_for_database` on CT 110 | From CT 110: `nc -vz 10.7.3.21 5432`; then `listen_addresses`, the `pg_hba.conf` line, the password in `.env`, and the firewall (§4.2, §8). |
| IB Gateway logged out, no data, no error | `systemctl status ibgateway` in CT 130, and log in again over the VNC tunnel (§6.3). |

---

## Appendix A: single-container quickstart

For evaluation or a small hypervisor: one LXC runs the app and the bundled
database, and IB Gateway lives wherever it already lives.
`install/proxmox-create-ct.sh --bundled-db` does step 1, and
[INSTALL.md Appendix A](INSTALL.md#appendix-a-unattended-install) can do the
rest unattended.

1. On the Proxmox host:

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
   ```

2. Inside it, §5.2 (Docker) and §5.3 (deploy user).
3. As `tradingapp`:

   ```bash
   git clone https://github.com/41agent41/tradingapp.git /opt/tradingapp
   cd /opt/tradingapp
   ./tradingapp.sh install
   ./tradingapp.sh backup-key
   ```

4. Continue with [INSTALL.md step 4](INSTALL.md#4-sign-in-and-secure-the-app).

The data lives in the `tradingapp_pgdata` volume (Docker shows it as
`tradingapp_tradingapp_pgdata`). Plan the move to a database container
([OPERATIONS.md](OPERATIONS.md#move-from-the-bundled-to-an-external-database))
before you collect history worth keeping.

---

## Appendix B: checklist

**Hypervisor**

- [ ] No-subscription repository on, host updated
- [ ] Host in UTC, chrony synchronised (containers use it)
- [ ] Storage type known: LVM-thin or dir, or ZFS (§1.2)
- [ ] LAN does not overlap `172.20.0.0/16`
- [ ] Datacenter firewall on, UI and SSH checked before logout

**Database (120)**

- [ ] Data directory on its own mount point, `backup=1`
- [ ] PostgreSQL and TimescaleDB installed; tuned to the container's limit
- [ ] Role, database and `timescaledb` extension created
- [ ] `listen_addresses` and `pg_hba.conf` scoped to CT 110
- [ ] Daily `pg_dump`, and one restore tested

**App (110)**

- [ ] Unprivileged with `nesting=1,keyctl=1` (plus `fuse=1` on ZFS), `firewall=1`
- [ ] `hello-world` passes; storage driver `overlay2` or `fuse-overlayfs`
- [ ] `tradingapp` user with sudo and docker
- [ ] `./tradingapp.sh install --external-db` passed; key saved off the host
- [ ] [INSTALL.md](INSTALL.md) steps 4 to 10 done

**IB Gateway (130)**

- [ ] Logged in to the paper account; API on, port 4002, CT 110 trusted
- [ ] `ibgateway.service` enabled and surviving a restart
- [ ] VNC only through an SSH tunnel; 4002 open to CT 110 only

**Operations**

- [ ] Hypervisor firewall drops 3000, 4000 and 8000 from the LAN (checked with `nc`)
- [ ] `--onboot` and `--startup order` on every guest; host reboot tested
- [ ] vzdump covering 110, 120 and 130 in `snapshot` mode
- [ ] Baseline snapshots taken
- [ ] Heartbeat monitor off this host pages you when the backend stops
