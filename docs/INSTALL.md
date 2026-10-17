# Installing TradingApp on Proxmox VE

This guide builds TradingApp on a Proxmox VE host, one server at a time. The
database comes first, complete with everything it needs, then the app, then
the servers around it. Each server is created with a
[Proxmox VE community script](https://community-scripts.org), so most of the
work is answering a few prompts.

Do the steps in order. Each one ends with a check, and later steps assume the
earlier ones passed.

| Step | Server | Built with | Needed? |
|---|---|---|---|
| [1. Database](#1-database-server-ct-100) | CT 100 `tradingapp-db` | PostgreSQL script | Yes |
| [2. App](#2-app-server-ct-110) | CT 110 `tradingapp-app` | Docker script | Yes |
| [3. Sign in](#3-sign-in-and-secure-the-app) | | the browser | Yes |
| [4. Brokers](#4-brokers) | VM 120 `mt5-bridge`, CT 130 `ib-gateway` | Ubuntu VM and Docker scripts | Only for the brokers you use |
| [5. Market data](#5-market-data) | | the browser | Yes |
| [6. Alerts](#6-alerts-and-safety-nets) | | the browser | Strongly recommended |
| [7. Reverse proxy](#7-reverse-proxy-and-tls-ct-140) | CT 140 `tradingapp-proxy` | Nginx Proxy Manager script | Recommended |
| [8. Firewall](#8-firewall) | every guest | the Proxmox UI | Recommended |
| [9. Monitoring](#9-monitoring-ct-150-and-ct-160) | CT 150 `prometheus`, CT 160 `grafana` | Prometheus and Grafana scripts | Optional |
| [10. Backups and boot](#10-backups-snapshots-and-boot-order) | every guest | the Proxmox UI | Yes |
| [11. Verify](#11-verify) | | | Yes |

To try the app before building all of this, one container is enough:
[Appendix B](#appendix-b-one-container-for-evaluation). Without Proxmox, see
[Appendix C](#appendix-c-without-proxmox). Running, upgrading and
troubleshooting an installed app are in [OPERATIONS.md](OPERATIONS.md).

> **Paper first.** Everything in this guide keeps to paper: every broker
> connection is a paper or demo account and live trading stays off. Going
> live is a separate, deliberate step
> ([OPERATIONS.md § Going live](OPERATIONS.md#going-live)).

---

## Before you start

### What this guide assumes

- A Proxmox VE 8 or 9 host that is installed, updated and on your network,
  with its clock synchronised (containers read the host's clock and cannot
  set their own).
- Storage that holds container disks and supports snapshots, such as
  `local-lvm` or a ZFS pool.
- A network bridge (usually `vmbr0`) with outbound internet access, for the
  community scripts, Docker images, GitHub and the cloud brokers.

### Plan the addresses

The servers talk to each other by address, so each one needs an address that
does not change. Pick one for each server you will build, on your LAN, before
you start: you enter it as a static address when you create the server, or
reserve it for the server on your DHCP server.

This guide writes them as placeholders. Wherever you see one, use the address
you picked:

| Placeholder | Server |
|---|---|
| `<db-address>` | CT 100, the database |
| `<app-address>` | CT 110, the app |
| `<mt5-address>` | VM 120, the MetaTrader 5 bridge |
| `<ib-address>` | CT 130, IB Gateway |
| `<proxy-address>` | CT 140, the reverse proxy |
| `<prometheus-address>` | CT 150, Prometheus |
| `<grafana-address>` | CT 160, Grafana |

> **One range to avoid.** The app's own Docker network uses
> `172.20.0.0/16`. If your LAN, a VPN or another bridge uses any part of
> that range, the app server loses its routes to it. Use a different range
> for your servers.

### Running a community script

Every server in this guide starts the same way:

1. Find the script on [community-scripts.org](https://community-scripts.org)
   (the name is given in each step) and copy its install command. It looks
   like this:

   ```bash
   bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/postgresql.sh)"
   ```

2. In the Proxmox web UI, select the node, open **Shell**, paste the command
   and press Enter.
3. Choose **Advanced Install**. It walks through the container's settings
   one screen at a time. Set the ones each step lists, and keep the default
   for everything else.
4. Answer the questions the script asks about the application, then wait for
   `Completed successfully`.

To work inside a container afterwards, select it in the Proxmox UI and open
**Console**. Unless you set a root password in Advanced Install, it logs you
in as root.

The settings each step asks you to enter:

| Setting | What to enter |
|---|---|
| Container type | **Unprivileged** |
| Container ID | the ID in the step (100, 110, ...) |
| Hostname | the name in the step |
| Disk size, CPU cores, RAM | the sizes in the step (RAM is in MiB) |
| IPv4 | **Static**, with the address you planned and your gateway; or DHCP with a reservation |
| Nesting, Keyctl | only where the step says so |

---

## 1. Database server (CT 100)

The database is the first dependency. Settings, logins, broker connections,
market data, orders and the audit log all live in it, and the app does not
serve until it can reach it. This step builds it completely: PostgreSQL,
TimescaleDB, the app's role and database, access for the app server only,
and nightly dumps.

### 1.1 Create the container

Script: **PostgreSQL**. In Advanced Install:

| Setting | Value |
|---|---|
| Container ID | `100` |
| Hostname | `tradingapp-db` |
| Disk size | `100` GB (market data grows; you can enlarge it later) |
| CPU cores | `4` |
| RAM | `8192` MiB |
| IPv4 | `<db-address>` |

If the script asks for the container OS, choose **Debian**. When it asks
for the PostgreSQL version, enter **17**. Answer **No** to Adminer.

### 1.2 Add TimescaleDB

The app stores bars and ticks in TimescaleDB, a PostgreSQL extension the
script does not install. In CT 100's **Console**:

```bash
apt install -y gnupg curl
mkdir -p /etc/apt/keyrings
curl -fsSL https://packagecloud.io/timescale/timescaledb/gpgkey \
  | gpg --dearmor -o /etc/apt/keyrings/timescaledb.gpg
echo "deb [signed-by=/etc/apt/keyrings/timescaledb.gpg] https://packagecloud.io/timescale/timescaledb/debian/ $(. /etc/os-release && echo "$VERSION_CODENAME") main" \
  > /etc/apt/sources.list.d/timescaledb.list
apt update
apt install -y timescaledb-2-postgresql-17 timescaledb-tools
timescaledb-tune --quiet --yes
systemctl restart postgresql
```

If `apt install` finds no TimescaleDB package, Timescale has not yet
published for this Debian release: replace the release name in
`/etc/apt/sources.list.d/timescaledb.list` with `bookworm` and run the last
four lines again.

`timescaledb-tune` sizes PostgreSQL's memory from what the container has.
Run `free -h` first: it should show the container's 8 GB. If it shows the
host's total instead, add `--memory 8GB` to the `timescaledb-tune` line.

### 1.3 Create the app's role, database and extension

Make a password for the app and keep it; step 2 needs it:

```bash
tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32; echo
```

Then create the role, its database and the extension, with that password in
place of `PASTE-THE-PASSWORD`:

```bash
runuser -u postgres -- psql <<'SQL'
CREATE ROLE tradingapp WITH LOGIN PASSWORD 'PASTE-THE-PASSWORD';
CREATE DATABASE tradingapp OWNER tradingapp;
\c tradingapp
CREATE EXTENSION IF NOT EXISTS timescaledb;
SQL
```

The role owns its database, so the app can create and update its own tables
when it starts. There is never any SQL to apply by hand after this. The role
is not a superuser, which is why the extension is created here.

### 1.4 Let in the app server, and nothing else

The community script lets every address on the network log in with a
password. Replace that with one line for the app server:

```bash
HBA=/etc/postgresql/17/main/pg_hba.conf
sed -i '/0\.0\.0\.0/d' "$HBA"
echo "host  tradingapp  tradingapp  <app-address>/32  scram-sha-256" >> "$HBA"
systemctl reload postgresql
```

The firewall in [step 8](#8-firewall) closes port 5432 to everything else as
well.

Encryption on the wire is optional while both servers sit on the same
Proxmox bridge, and the app connects without it by default. If the database
is anywhere else, give PostgreSQL a real certificate, change `host` to
`hostssl` in that line, and add `POSTGRES_SSL=true` in step 2.2.

### 1.5 Nightly dumps

A Proxmox backup of this container ([step 10](#10-backups-snapshots-and-boot-order))
restores like a machine that lost power. A dump is a clean copy of the data.
Create `/usr/local/bin/backup-tradingapp.sh`:

```bash
cat > /usr/local/bin/backup-tradingapp.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
BACKUP_DIR=/var/backups/tradingapp
mkdir -p "$BACKUP_DIR"
chown postgres "$BACKUP_DIR"
runuser -u postgres -- pg_dump -Fc tradingapp \
  > "$BACKUP_DIR/tradingapp_$(date -u +%Y%m%d_%H%M%S).dump"
find "$BACKUP_DIR" -name 'tradingapp_*.dump' -mtime +14 -delete
EOF
chmod +x /usr/local/bin/backup-tradingapp.sh
echo '10 2 * * * root /usr/local/bin/backup-tradingapp.sh' > /etc/cron.d/tradingapp-backup
```

Copy the dumps off the host as well. Restoring one is in
[OPERATIONS.md § Backups and restore](OPERATIONS.md#backups-and-restore).

### 1.6 Check

```bash
runuser -u postgres -- psql -d tradingapp -c '\dx'       # lists timescaledb
runuser -u postgres -- psql -c 'SHOW shared_preload_libraries;'   # includes timescaledb
/usr/local/bin/backup-tradingapp.sh && ls /var/backups/tradingapp
```

Then take a snapshot, so you can return to a clean database: CT 100 >
**Snapshots** > **Take Snapshot**, named `db-ready`.

---

## 2. App server (CT 110)

The app runs as a Docker stack: the web frontend, the backend that owns the
database, the broker service that talks to brokers, and Redis.

### 2.1 Create the container

Script: **Docker**. In Advanced Install:

| Setting | Value |
|---|---|
| Container ID | `110` |
| Hostname | `tradingapp-app` |
| Disk size | `60` GB |
| CPU cores | `4` |
| RAM | `8192` MiB (the app's first build needs at least 4096) |
| IPv4 | `<app-address>` |
| Nesting | **Yes** (Docker needs it) |
| Keyctl | **Yes** (Docker needs it) |

If the script asks for the container OS, choose **Debian**. Answer **No** to
exposing the Docker TCP socket, and **Yes** if it offers Docker Compose.

**Check,** in CT 110's **Console**:

```bash
docker run --rm hello-world
docker info | grep 'Storage Driver'     # overlay2 or fuse-overlayfs
```

If `hello-world` fails or the driver is `vfs`, fix that first:
[OPERATIONS.md § Proxmox containers](OPERATIONS.md#proxmox-containers).

### 2.2 Tell the installer about the database

The installer reads its answers from a file. Create it:

```bash
mkdir -p -m 700 /etc/tradingapp
nano /etc/tradingapp/install.answers
```

and enter three lines, with your database address and the password from
step 1.3:

```ini
INSTALL_DB_MODE=external
POSTGRES_HOST=<db-address>
POSTGRES_PASSWORD=the-password-from-step-1.3
```

Save (Ctrl+O, Enter) and exit (Ctrl+X), then make it private, as the
installer insists:

```bash
chmod 600 /etc/tradingapp/install.answers
```

Every other answer is optional. The full list, with what each one does, is
in [`install/install.answers.example`](../install/install.answers.example).
Do not put broker details here: brokers are added in the app (step 4), and
the installer refuses them.

### 2.3 Run the installer

```bash
curl -fsSL https://raw.githubusercontent.com/41agent41/tradingapp/master/install/install.sh -o /root/install.sh
bash /root/install.sh all
```

It creates a `tradingapp` user, checks out the app into `/opt/tradingapp`,
writes its `.env`, builds and starts the stack, waits until the backend has
reached the database, created its tables and checked its encryption key,
runs its checks, and installs a service that starts the app at boot. The
first build takes several minutes.

To install your own fork, download `install.sh` from your fork instead and
add `INSTALL_REPO_URL=https://github.com/<you>/tradingapp.git` to the
answers.

**Check:** the last lines read `result: PASS` and `done: preflight docker
user repo env schema deploy verify service`. If it stops, the message names
the phase and the cause; fix it and run the same command again (it is safe
to re-run). [Appendix A](#appendix-a-the-installer-in-detail) lists each
phase and check.

### 2.4 Save the encryption key

The app encrypts every secret it stores (broker credentials, alert tokens,
the MFA secret) with a key generated on this server. Any rebuild that keeps
the database needs it. Print it and store it somewhere off this host, such
as a password manager:

```bash
cd /opt/tradingapp
runuser -u tradingapp -- ./tradingapp.sh backup-key
```

Commands in [OPERATIONS.md](OPERATIONS.md) run the same way, as the
`tradingapp` user in `/opt/tradingapp`; `su - tradingapp` then
`cd /opt/tradingapp` gives you a shell for that.

---

## 3. Sign in and secure the app

1. Read the setup code in CT 110's Console:

   ```bash
   cd /opt/tradingapp && runuser -u tradingapp -- ./tradingapp.sh setup-code
   ```

2. Open `http://<app-address>:3000`, enter the setup code and choose the
   login password.
3. Open **Settings**. The **Getting started** checklist at the top ticks
   itself off as you work through the rest of this guide.
4. On **Settings > Security**:
   - enrol **order MFA**: scan the QR code with an authenticator app and
     enter a code;
   - make a **trading token** and keep it (it is shown once).

   Placing orders, and any change that loosens a gate or raises a cap, needs
   both.
5. For scripts, make an **API token** on the same tab. Scripts send it as
   `Authorization: Bearer <token>`.

**Check:** the checklist shows the login password, order MFA and trading
token steps done.

---

## 4. Brokers

The app asks brokers in this order of priority, and this step adds them in
the same order. Add only the ones you use.

| Priority | Broker | Server | What you need from the broker |
|---|---|---|---|
| 1 | OANDA (FX, CFDs) | none, a cloud API | A practice account: API token and account id |
| 2 | MetaTrader 5 | VM 120 | A demo account: login, password, server, and the server's time zone |
| 3 | Interactive Brokers | CT 130 | A paper account: username and password |
| 4 | Alpaca (US stocks, options) | none, a cloud API | A paper API key and secret |

Every broker is added the same way, on **Settings > Connections**: choose the
broker, fill in the form, and save. The app tests the connection as it saves
it, shows the result, and keeps checking it on a timer
(`BROKER_PROBE_INTERVAL_SECONDS` on Settings > Schedulers and data). Secrets
are stored encrypted with the key from step 2.4.

Every form has these fields:

| Field | Meaning |
|---|---|
| Name | The account's name in the app: lower-case letters, digits, `-` and `_`, such as `oanda-practice`. |
| Mode | `paper` or `live`. It is binding: a live order to a paper connection is refused. Use **paper** throughout this guide. |
| Currency | The account currency, such as `USD`. |
| Default | The connection used for this broker when a request names no account. |
| Limits, prop rules | Optional per-account risk limits; see [step 6](#6-alerts-and-safety-nets). |

Add one broker at a time and check it before the next, so a failure has one
cause.

### 4.1 OANDA

A cloud API, with no server to build.

1. In OANDA's account portal, generate an API token for your practice
   account and note its account id.
2. On Settings > Connections, add **OANDA**, Mode **paper**, with the
   **Account ID** and **API token**. Paper connections use OANDA's practice
   environment.

**If the test fails:** the token or account id is wrong, the token belongs to
a live account, or the app server has no outbound HTTPS.

### 4.2 MetaTrader 5 (VM 120)

MT5 needs a terminal that stays logged in, and the `MetaTrader5` Python
package that drives it only runs on Windows Python. So each MT5 account gets
a terminal and a small HTTP service next to it, the **sidecar**
(`mt5_sidecar/`). They need a virtual machine: a container shares the host's
Linux kernel and cannot run them. Linux running the terminal under Wine is
the scripted route; a Windows VM is the alternative.

One sidecar serves one terminal logged in to one account. A second account
gets a second terminal and sidecar, on another port, in the same VM.

#### Create the VM

Script: **Ubuntu VM**. Choose Ubuntu **24.04**, answer **Yes** to
Cloud-Init, and **No** to the default settings, then:

| Setting | Value |
|---|---|
| Virtual Machine ID | `120` |
| Disk size | `40` GiB |
| Hostname | `mt5-bridge` |
| CPU cores | `2` |
| RAM | `4096` MiB |
| Start VM when completed | **No** |

When the script finishes, open VM 120 > **Cloud-Init** in the Proxmox UI, set
a user and password (or an SSH key), set **IP Config** to `<mt5-address>`
with your gateway, click **Regenerate Image**, and start the VM. Log in on its
**Console** and run `sudo -i` for a root shell.

#### Install the terminal and sidecar

[`install/mt5-sidecar-wine.sh`](../install/mt5-sidecar-wine.sh) installs
Wine, Windows Python, the MT5 terminal and the sidecar, with one systemd
service per account. Download it and give it the demo account's details
through the environment (it never takes secrets as arguments):

```bash
curl -fsSL https://raw.githubusercontent.com/41agent41/tradingapp/master/install/mt5-sidecar-wine.sh -o /root/mt5-sidecar-wine.sh
export MT5_BRIDGE_SECRET="$(openssl rand -hex 32)"
read -rp 'MT5 login: ' MT5_LOGIN
read -rsp 'MT5 password: ' MT5_PASSWORD; echo
read -rp 'MT5 server: ' MT5_SERVER
export MT5_LOGIN MT5_PASSWORD MT5_SERVER
bash /root/mt5-sidecar-wine.sh install --instance demo-a --port 9100 --server-tz Europe/Athens
unset MT5_BRIDGE_SECRET MT5_PASSWORD
```

Use your broker's server time zone for `--server-tz`, and add
`--installer-url <url>` to install your broker's own MT5 build. The secret
is generated once and saved in `/etc/mt5-sidecar/demo-a.env`; anything that
reaches the sidecar with it can trade the account. The script keeps the
sidecar to demo accounts (`MT5_ALLOW_REAL=false`).

**Exit 0** ends with `check: PASS (demo account ...)`.

**Exit 4** means the terminal needs a person, to log in or to turn on
**Algo Trading**. Run `bash /root/mt5-sidecar-wine.sh vnc --instance demo-a`,
open an SSH tunnel to the VM from your computer
(`ssh -L 5900:localhost:5900 <user>@<mt5-address>`), connect a VNC viewer to
`localhost:5900`, and do it there. Then
`bash /root/mt5-sidecar-wine.sh check --instance demo-a`.

For a second account, run the install again with another `--instance` name
and `--port 9101`.

<details>
<summary><b>Alternative: a Windows VM</b></summary>

There is no community script for Windows. Create the VM in the Proxmox UI
with **Create VM**: ID `120`, a Windows 11 ISO and the
[VirtIO driver ISO](https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso),
2 cores, 4096 MiB, a 64 GB disk. When the Windows installer finds no disk,
load the VirtIO SCSI driver from the second CD. Give it the address
`<mt5-address>`.

Then:

1. Install the MT5 terminal from your broker. For two accounts, install it
   twice into two folders and set `MT5_PORTABLE=true`.
2. Install 64-bit Python 3.11 from python.org, and put the repository (or
   just `mt5_sidecar/`) on the VM, for example at `C:\tradingapp`.
3. Install the sidecar and try it:

   ```powershell
   cd C:\tradingapp\mt5_sidecar
   python -m pip install -r requirements.txt
   copy sidecar.env.example sidecar.env    # then edit it: the settings below
   python server.py
   ```

4. Run it at logon with Task Scheduler and automatic logon (the terminal
   needs a desktop, so not a Windows service):

   ```powershell
   $action  = New-ScheduledTaskAction -Execute "powershell.exe" `
     -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\tradingapp\mt5_sidecar\deploy\run-sidecar.ps1"
   $trigger = New-ScheduledTaskTrigger -AtLogOn
   $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
     -ExecutionTimeLimit ([TimeSpan]::Zero)
   Register-ScheduledTask -TaskName "MT5 sidecar A" -Action $action -Trigger $trigger -Settings $settings
   ```

5. In Windows Firewall, allow the sidecar's port from `<app-address>` only.
6. In the terminal, turn on **Algo Trading**.

</details>

#### Sidecar settings

The script writes these to `/etc/mt5-sidecar/<instance>.env`; on Windows they
go in `sidecar.env` next to `server.py`
([`mt5_sidecar/sidecar.env.example`](../mt5_sidecar/sidecar.env.example)).

| Variable | Default | Meaning |
|---|---|---|
| `MT5_BRIDGE_SECRET` | none | The shared secret; the sidecar refuses to listen beyond loopback without one of at least 24 characters |
| `MT5_SIDECAR_HOST` / `MT5_SIDECAR_PORT` | `127.0.0.1` / `9100` | Listen address (the script sets `0.0.0.0`) |
| `MT5_TERMINAL_PATH` | none | `terminal64.exe` to attach to, and relaunch if it exits |
| `MT5_PORTABLE` | `false` | Start the terminal in portable mode (one install folder per account) |
| `MT5_LOGIN` / `MT5_PASSWORD` / `MT5_SERVER` | none | Log the terminal in on start. With `MT5_LOGIN` set, a terminal logged in to another account is refused. |
| `MT5_SERVER_TZ` | `UTC` | The trade server's time zone, such as `Europe/Athens` |
| `MT5_MAGIC` | `61000` | Magic number on every order this sidecar sends |
| `MT5_DEVIATION_POINTS` | `20` | Slippage accepted on market orders |
| `MT5_ALLOW_REAL` | `false` | Allow orders on a real-money account. Leave it `false`. |

For long chart histories, raise **Tools > Options > Charts > Max bars in
chart** in the terminal.

#### Check it from the app server

In CT 110's Console, so the network path is tested too, with the secret from
`/etc/mt5-sidecar/demo-a.env` on VM 120:

```bash
SECRET=paste-the-secret
H="X-MT5-Bridge-Secret: $SECRET"
curl -H "$H" http://<mt5-address>:9100/health          # status ok, account_type demo
curl http://<mt5-address>:9100/health                  # refused: 401
curl -H "$H" "http://<mt5-address>:9100/symbols?query=EURUSD&limit=20"
curl -H "$H" "http://<mt5-address>:9100/quote?symbol=EURUSD"
date -u +%s                                            # compare with the quote's time
```

While the market is open, the quote's `time` is within a few seconds of
`date -u +%s`. If it is off by whole hours, the server time zone is wrong.
Note the exact symbol names `/symbols` returns (`EURUSD`, `EURUSD.a`,
`EURUSDm`); you may need them for a symbol map ([4.6](#46-not-yet-on-the-form-symbol-maps-and-account-info-from)).

#### Add the connection

On Settings > Connections, add **MetaTrader 5**, Mode **paper**:

- **Bridge URL**: `http://<mt5-address>:9100`
- **Bridge secret**: the sidecar's `MT5_BRIDGE_SECRET`
- **Server timezone** (optional): the trade server's zone

For a second account, add a second connection with port 9101.

**If the test fails:** check the URL and port, that the secret is the same
on both sides, and the firewall (step 8).

### 4.3 Interactive Brokers (CT 130)

IB Gateway is a Java application that must stay logged in. CT 130 runs it in
Docker with the [`ib-gateway`](https://github.com/gnzsnz/ib-gateway-docker)
image, which bundles IBC to log in, accept the API settings and restart it
daily without a person.

#### Create the container

Script: **Docker**. In Advanced Install:

| Setting | Value |
|---|---|
| Container ID | `130` |
| Hostname | `ib-gateway` |
| Disk size | `16` GB |
| CPU cores | `2` |
| RAM | `4096` MiB |
| IPv4 | `<ib-address>` |
| Nesting | **Yes** |
| Keyctl | **Yes** |

Answer **No** to exposing the Docker TCP socket.

#### Run IB Gateway

In CT 130's Console, create a folder with two files:

```bash
mkdir -p /opt/ib-gateway && cd /opt/ib-gateway
nano .env
```

`.env`, with your **paper** account's login:

```ini
TWS_USERID=your-ib-username
TWS_PASSWORD=your-ib-password
TRADING_MODE=paper
READ_ONLY_API=no
TIME_ZONE=Etc/UTC
AUTO_RESTART_TIME=11:59 PM
TWOFA_TIMEOUT_ACTION=restart
RELOGIN_AFTER_TWOFA_TIMEOUT=yes
```

```bash
chmod 600 .env
nano docker-compose.yml
```

`docker-compose.yml`:

```yaml
services:
  ib-gateway:
    image: ghcr.io/gnzsnz/ib-gateway:stable
    restart: always
    env_file: .env
    ports:
      - "4002:4004"
```

Then start it:

```bash
docker compose up -d
docker compose logs -f      # wait for the login to finish, then Ctrl+C
```

`READ_ONLY_API=no` lets the app place orders (paper ones included). Inside
the container the API answers on its loopback, which IB Gateway always
trusts, so there is no Trusted IPs list to keep: the firewall in step 8 is
what limits port 4002 to the app server. The IB API has no authentication of
its own, so do not skip that step.

To see the Gateway's screen (for example when IB asks for a second factor),
add `VNC_SERVER_PASSWORD=...` to `.env` and `- "127.0.0.1:5900:5900"` under
`ports`, run `docker compose up -d`, and reach it through an SSH tunnel to
CT 130. Never publish VNC to the network.

**Check,** in CT 110's Console:

```bash
nc -vz <ib-address> 4002
```

#### Add the connection

On Settings > Connections, add **Interactive Brokers**, Mode **paper**:
**Gateway host** `<ib-address>`, **Port** `4002`, and a **Client ID** that no
other program uses on that Gateway (`1` if nothing else connects).

**If the test fails:** the Gateway has not finished logging in
(`docker compose logs` in CT 130), the port or client id is wrong, or a
firewall blocks the port.

A logged-out Gateway looks like a quiet market: data just stops. The
connection check on Settings > Connections shows it, and so do the alerts in
step 6.

### 4.4 Alpaca

A cloud API, with no server to build.

1. In Alpaca's paper dashboard, generate an API key and secret.
2. On Settings > Connections, add **Alpaca**, Mode **paper**, with the
   **API key** and **API secret**. Paper connections use Alpaca's paper
   endpoint.

**If the test fails:** the key is wrong or belongs to a live account, or the
app server has no outbound HTTPS.

### 4.5 Priority and the default broker

A request that names no broker goes to the highest-priority one that has a
connection: OANDA, then MT5, then IB, then Alpaca. Change the order on the
Connections tab, or pin one with `DEFAULT_BROKER` on Settings > Trading. A
broker with no connection answers 501.

**Check:** each connection shows as connected on Settings > Connections, the
header's health badge agrees, and the Getting started checklist shows the
broker step done.

### 4.6 Not yet on the form: symbol maps and "account info from"

Two MT5 options cannot be entered on the Connections form yet:

- **Symbol map.** When a broker lists several tiers of a pair
  (`EURUSD`, `EURUSD.a`, `EURUSD.pro`), symbol resolution reports it as
  ambiguous and needs a map such as `{"EURUSD": "EURUSD.a"}`.
- **Account info from.** An MT5 account at OANDA can read its balance and
  positions from the matching OANDA connection while orders still go through
  the sidecar.

Until the form has them there are two workarounds, each with a catch:

1. **SQL, on a connection added in the app.** The app passes every key of a
   connection's stored settings to the broker service, so in CT 100:

   ```bash
   runuser -u postgres -- psql -d tradingapp <<'SQL'
   UPDATE broker_connections
      SET settings = settings || '{"symbol_map": {"EURUSD": "EURUSD.a"}}'::jsonb
    WHERE platform = 'mt5' AND account = 'demo-a';
   SQL
   ```

   then restart the app (`runuser -u tradingapp -- ./tradingapp.sh restart`
   in `/opt/tradingapp` on CT 110). The catch: saving that connection on the
   form again rebuilds its settings from the form's fields and drops the map,
   so run the update again after every edit.
2. **A `BROKER_CONNECTIONS` manifest in `.env`.** A JSON list of connections
   that may carry `symbol_map` and `account_info_from` (the format is at the
   top of [`broker_service/connections.py`](../broker_service/connections.py)).
   The catch: for a broker it names, `.env` replaces every connection added in
   the app (they show as overridden), so all of that broker's accounts must
   then live in the manifest, with their secrets in further `.env` lines.

---

## 5. Market data

On **Settings > Schedulers and data**:

1. In the data collection table, add an entry per instrument and timeframe:
   the broker, the symbol, the timeframe, how often to collect, and how many
   days of bars to keep.
2. For backtests, set **History from** on an entry, up to two years back. The
   scheduler then also walks back to that date, 20,000 bars at a time and up
   to five chunks per entry per pass, so a year of 5-minute bars arrives in
   two passes. The History column shows how far it has got. Bars from the
   history start on are kept whatever the entry's retention.
3. Turn on the backfill scheduler (`BACKFILL_ENABLED`). It is off by default
   because it calls brokers on a timer. It starts without a restart.

**Check:** the Getting started checklist shows the market data step done, and
a chart of a collected instrument shows bars.

---

## 6. Alerts and safety nets

Set these before anything runs unattended. All are on the Settings page.

1. **Telegram** (Settings > Alerts and safety): create a bot with
   @BotFather, send it a message, read the chat id from
   `https://api.telegram.org/bot<TOKEN>/getUpdates`, and set
   `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
2. **Dead-man's switch** (same tab): create a check on a monitor **off this
   Proxmox host**, such as healthchecks.io with a 1-minute period and
   5-minute grace. Set `HEARTBEAT_URL`, and `HEARTBEAT_FAIL_URL` (the check's
   `/fail` URL). The backend pings it every minute, and the fail URL when the
   broker service is unreachable. If the whole host goes down, this is what
   tells you.
3. **Kill switch**: leave `KILL_SWITCH_ACTION` at `notify` until the paper
   runbook has shown what its alerts look like.
4. **Risk limits** (Settings > Risk): set `TRADING_DAY_TIMEZONE` to your
   broker's (or prop firm's) server zone, and the fleet-wide caps you want.
   Per-account limits and prop-firm rules go on each connection's form; a
   connection's own value wins over the fleet-wide one.

**Check:** `curl -s http://<app-address>:4000/api/health | jq .services.heartbeat`
shows `last_result: ok`, the monitor's check turns green, and the Getting
started checklist is complete.

---

## 7. Reverse proxy and TLS (CT 140)

The app serves plain HTTP on port 3000. Anywhere beyond an isolated lab
network, put TLS in front of it. Nginx Proxy Manager does that from a web
page, including the Let's Encrypt certificate. The app's frontend forwards
`/api` and `/socket.io` to the backend itself, so one proxy host covers
everything.

You need a domain name, such as `trading.example.com`, pointing at the
address where Nginx Proxy Manager is reachable.

### 7.1 Create the container

Script: **Nginx Proxy Manager**. In Advanced Install: ID `140`, hostname
`tradingapp-proxy`, IPv4 `<proxy-address>`; keep the default sizes.

### 7.2 Add the proxy host

1. Open `http://<proxy-address>:81` and sign in. The script's page on
   community-scripts.org gives the first login; you are asked to change it.
2. **Hosts > Proxy Hosts > Add Proxy Host**:
   - **Domain Names**: `trading.example.com`
   - **Scheme** `http`, **Forward Hostname / IP** `<app-address>`,
     **Forward Port** `3000`
   - tick **Websockets Support** and **Block Common Exploits**
3. On the **SSL** tab: **Request a new SSL Certificate**, tick **Force SSL**
   and **HTTP/2 Support**, agree to the terms, and save.

### 7.3 Tell the app about the proxy

On **Settings > Network** in the app:

- **Allowed browser origins** (`CORS_ORIGINS`): `https://trading.example.com`
- **Trusted reverse proxies** (`TRUST_PROXY`): `<proxy-address>`. Login
  lockout and the settings history then record the visitor's address instead
  of the proxy's.

Both apply at once. The session cookie is marked secure from the proxy's
`X-Forwarded-Proto` header, so `COOKIE_SECURE` on Settings > Security is only
for a proxy that does not send it.

**Check:** `https://trading.example.com` loads and signs in.

---

## 8. Firewall

Docker publishes the app's ports by writing its own firewall rules, which run
before anything inside the container, so a firewall inside CT 110 cannot
close them. The Proxmox firewall filters each guest's traffic on the host,
before it reaches the guest, and nothing inside a guest can get around it.
Every rule below is set in the Proxmox web UI.

### 8.1 Name the servers

**Datacenter > Firewall > Alias > Add**, one per server you built:

| Name | IP/CIDR |
|---|---|
| `tradingapp_db` | `<db-address>` |
| `tradingapp_app` | `<app-address>` |
| `mt5_bridge` | `<mt5-address>` |
| `ib_gateway` | `<ib-address>` |
| `tradingapp_proxy` | `<proxy-address>` |
| `prometheus` | `<prometheus-address>` |

Rules then refer to these names instead of addresses.

### 8.2 Turn the firewall on for each guest's network

The community scripts do not do this. For each container: select it >
**Network** > `net0` > **Edit** > tick **Firewall** > **OK**. For VM 120:
**Hardware** > **Network Device** > **Edit** > tick **Firewall**. Without
it, the rules below do nothing for that guest.

### 8.3 Rules per guest

For each guest, add its rules under *guest* > **Firewall** > **Add**
(Direction `in`, Action `ACCEPT`, Protocol `tcp`), then under *guest* >
**Firewall** > **Options** set **Firewall** to **Yes** and **Input Policy**
to **DROP**.

| Guest | Allow | From (Source) |
|---|---|---|
| CT 100 database | port `5432` | `tradingapp_app` |
| CT 110 app | port `3000` | `tradingapp_proxy` (without step 7: your LAN) |
| CT 110 app | port `4000` | `prometheus` (only with step 9) |
| VM 120 MT5 | ports `9100-9101` | `tradingapp_app` |
| CT 130 IB Gateway | port `4002` | `tradingapp_app` |
| CT 140 proxy | ports `80`, `443` | anywhere (leave Source empty) |
| CT 140 proxy | port `81` | your own computer or LAN only |
| every guest | port `22` | your LAN, if you use SSH |

The Proxmox console keeps working with every guest's firewall on: it does not
go over the guest's network.

The datacenter-level switch (**Datacenter > Firewall > Options > Firewall**)
must also be on for any of this to apply. If it is off on your host, turn it
on only after adding rules at **Datacenter > Firewall** that let your
computer reach the host's web UI (`8006`) and SSH (`22`); turning it on
applies a default-drop policy to the host itself, and a mistake there needs
the physical console to undo.

**Check,** from your own computer: `https://trading.example.com` works, and
`http://<app-address>:3000` and port `5432` on `<db-address>` do not answer.

> The broker service (port 8000) and Redis are not published beyond the app
> server's own loopback, so they need no rule.

---

## 9. Monitoring (CT 150 and CT 160)

Optional. Prometheus collects the backend's metrics and evaluates the alert
rules shipped with the app; Grafana shows the dashboard.

### 9.1 Prometheus (CT 150)

Script: **Prometheus**. In Advanced Install: ID `150`, hostname
`prometheus`, IPv4 `<prometheus-address>`, disk `16` GB.

In CT 150's Console, fetch the alert rules and add the app as a target:

```bash
curl -fsSL https://raw.githubusercontent.com/41agent41/tradingapp/master/ops/prometheus/alerts.yml \
  -o /etc/prometheus/alerts.yml
nano /etc/prometheus/prometheus.yml
```

Add to `prometheus.yml` (keep what is there; `rule_files` is a top-level key,
the job goes under the existing `scrape_configs:`):

```yaml
rule_files:
  - /etc/prometheus/alerts.yml

scrape_configs:
  - job_name: tradingapp-backend
    metrics_path: /metrics
    static_configs:
      - targets: ['<app-address>:4000']
```

```bash
promtool check config /etc/prometheus/prometheus.yml
systemctl restart prometheus
```

**Check:** `http://<prometheus-address>:9090/targets` shows
`tradingapp-backend` up. Port 4000 on CT 110 must allow `prometheus`
(step 8.3).

### 9.2 Grafana (CT 160)

Script: **Grafana**. In Advanced Install: ID `160`, hostname `grafana`.

1. Open `http://<grafana-address>:3000` and sign in (`admin` / `admin`, then
   change it).
2. **Connections > Data sources > Add > Prometheus**, URL
   `http://<prometheus-address>:9090`, **Save & test**.
3. **Dashboards > New > Import**, upload
   [`ops/grafana/tradingapp-dashboard.json`](../ops/grafana/tradingapp-dashboard.json)
   and pick the Prometheus data source.

What the rules and dashboard cover is in
[OPERATIONS.md § Prometheus and Grafana](OPERATIONS.md#prometheus-and-grafana).
The community-scripts **Prometheus Proxmox VE Exporter** adds per-guest CPU,
memory and disk pressure, which on a busy host shows up as app latency with
no sign inside the containers.

Monitoring on the same host goes down with it, so it does not replace the
dead-man's switch in step 6.

---

## 10. Backups, snapshots and boot order

### 10.1 Backup job

**Datacenter > Backup > Add**:

- **Selection**: 100, 110, 130 and 120 (and 140 to 160 if you built them)
- **Storage**: a backup storage, ideally a Proxmox Backup Server or a share
  off this host
- **Schedule**: daily, outside market hours
- **Mode**: **Snapshot**
- **Notification**: on failure

A backup of CT 100 restores the server, but its data only as of a power
cut. The nightly dumps from step 1.5 are the clean copy of the data; keep
both.

### 10.2 What the backups do not hold

- **The encryption key** (step 2.4). Keep it in a password manager. Without
  it a restored database opens everything except the stored secrets.
- **Broker logins** in `/opt/ib-gateway/.env` on CT 130 and
  `/etc/mt5-sidecar/` on VM 120 are in the guest backups, but keep your own
  record of them too.
- Docker images, Redis and the app's internal secrets are rebuilt or
  regenerated; nothing to keep.

### 10.3 Before an upgrade

Snapshot the app and the database together, since an upgrade can change the
database: CT 110 and CT 100 > **Snapshots** > **Take Snapshot**. Roll both
back to the same point if the upgrade goes wrong, and delete old snapshots:
they take real space on LVM-thin and ZFS. Upgrading is in
[OPERATIONS.md § Upgrade](OPERATIONS.md#upgrade-in-place).

### 10.4 Boot order

The community scripts set every guest to start at boot. Set the order under
*guest* > **Options** > **Start/Shutdown order**:

| Guest | Order | Startup delay |
|---|---|---|
| CT 100 database | 1 | 30 |
| VM 120 MT5, CT 130 IB Gateway | 2 | 30 |
| CT 110 app | 3 | |
| CT 140 proxy, CT 150, CT 160 | 4 | |

The backend waits for its database however long it takes, so a slow
database start delays the app but does not break it. Inside CT 110 the
installer's service starts the stack.

**Check:** reboot the Proxmox host outside market hours. Afterwards, every
guest is running, the app signs in and the connections show connected.

---

## 11. Verify

In CT 110:

```bash
cd /opt/tradingapp
runuser -u tradingapp -- ./tradingapp.sh status     # every container up
runuser -u tradingapp -- ./tradingapp.sh test       # frontend, backend, broker service, readiness
runuser -u tradingapp -- ./tradingapp.sh doctor     # database, schema, key, brokers, and what .env holds
bash /root/install.sh verify                        # the installer's checks again
```

- [ ] `doctor` shows `state: ready`, and `.env` holds only the seven database
      and key lines
- [ ] Encryption key stored off the host
- [ ] Getting started checklist complete on the Settings page
- [ ] Each broker connection is paper and connected
- [ ] A chart renders with data for a collected instrument
- [ ] The heartbeat check is green on its monitor
- [ ] The app is reached through TLS, and the guests' ports are closed to
      everything but the servers that need them
- [ ] A dump exists in CT 100, the backup job has run once, and a host
      reboot brings everything back

Next: take a strategy through paper trading with
[PAPER_TRADING.md](PAPER_TRADING.md). Day-to-day running, upgrades and
troubleshooting are in [OPERATIONS.md](OPERATIONS.md).

---

## Appendix A: The installer in detail

[`install/install.sh`](../install/install.sh) is what step 2 runs. It does
what needs root (packages, Docker, the `tradingapp` user, the checkout, the
boot service) and runs `./tradingapp.sh install` as that user for the app
itself. It installs in **paper mode** only. Every phase is safe to re-run: it
checks what is in place and does only what is missing, so the same command
also upgrades and repairs.

```bash
bash /root/install.sh all                              # every phase
bash /root/install.sh deploy verify service            # from a failed phase on
bash /root/install.sh repo env deploy verify           # upgrade to the latest version
```

### A.1 Phases

| Phase | Does |
|---|---|
| `preflight` | OS, root, packages, memory, disk, network, the `172.20.0.0/16` check |
| `docker` | Uses Docker if it works (it does after the Docker script); otherwise installs it. `hello-world` must pass |
| `user` | Creates the `tradingapp` user, in the docker group |
| `repo` | Clones or fast-forwards `/opt/tradingapp`; refuses if tracked files were changed |
| `env` | Writes `.env`: the database lines and the encryption key, nothing else |
| `schema` | Nothing: the backend creates and migrates its tables when it starts |
| `deploy` | Builds and starts the stack, waits until ready, stores app settings from the answers |
| `verify` | The checks below, written to `/var/log/tradingapp-install/report.txt` |
| `service` | The systemd service that starts the stack at boot |

The full log is `/var/log/tradingapp-install/install.log`.

To create CT 110 without the community script's prompts (for automation),
[`install/proxmox-create-ct.sh`](../install/proxmox-create-ct.sh) does the
same from the Proxmox shell.

| Phase | Typical failure | Fix |
|---|---|---|
| preflight | address in `172.20.0.0/16`; disk; GitHub unreachable | [Plan the addresses](#plan-the-addresses); the container's network |
| docker | daemon will not start; `hello-world` fails; `vfs` driver | [OPERATIONS.md § Proxmox containers](OPERATIONS.md#proxmox-containers) |
| repo | local changes in `/opt/tradingapp` | look at them (`git -C /opt/tradingapp status`) before discarding |
| env | exit 2 naming a key; exit 3 | supply the key; for 3, rule 1 below |
| deploy | `waiting_for_database` until the timeout | step 1: the address, `pg_hba.conf`, the password, the extension, the firewall |
| deploy | `migration_failed`, `key_mismatch`, `refusing to start` | [OPERATIONS.md § Troubleshooting](OPERATIONS.md#troubleshooting) |

### A.2 Answers

`/etc/tradingapp/install.answers`, mode 600, `KEY=VALUE` lines. Every key is
documented in [`install/install.answers.example`](../install/install.answers.example).
There are three kinds:

- `INSTALL_*`: the installer itself. `INSTALL_DIR` (default `/opt/tradingapp`),
  `INSTALL_USER` (`tradingapp`), `INSTALL_REPO_URL`, `INSTALL_REF` (`master`),
  `INSTALL_DB_MODE` (`bundled` or `external`), `INSTALL_HEALTH_TIMEOUT` (900
  seconds).
- `POSTGRES_*` and `SETTINGS_ENCRYPTION_KEY`: written to `.env`.
  `POSTGRES_HOST` and `POSTGRES_PASSWORD` for an external database;
  `POSTGRES_SSL=true` if it needs TLS; `SETTINGS_ENCRYPTION_KEY` only when
  rebuilding against a database that already holds data.
- Anything else is an app setting, such as `TELEGRAM_BOT_TOKEN` or
  `HEARTBEAT_URL`. It is stored in the app's database after deploy, not left
  in `.env`.

Broker keys (`IB_HOST`, `BROKER_CONNECTIONS`, `OANDA_*`, `ALPACA_*`, `MT5_*`)
are refused with exit 2. `LIVE_TRADING_ENABLED` or
`SYSTEMATIC_EXECUTION_ENABLED` set to anything but `false` is refused with
exit 3.

### A.3 Checks

The report has one line per check, `CHECK <id> PASS|FAIL|SKIP <detail>`, and
ends with `result: PASS` or `result: FAIL`.

| Check | Proves | On FAIL |
|---|---|---|
| V1 | every container is running | `./tradingapp.sh status`, `logs` |
| V2 | `/api/health` is healthy | the detail names the failing side |
| V3 | the database answers the backend | step 1 |
| V4 | the broker service answers `/health` | `./tradingapp.sh logs` |
| V5 | the frontend serves | `install.sh deploy` |
| V6 | the API refuses an unauthenticated call | someone changed the auth setup |
| V7 | the broker service refuses calls without its token | "token not found": the internal secrets volume is missing; `install.sh deploy` |
| V8 | the broker service is on loopback only | someone changed `docker-compose.yml` |
| V9 | the schema is up to date and the key matches | the deploy rows above |
| V10 | no startup refusals in the backend log | the log line names the key |
| V11 | live trading is off in `.env` and in the app | rule 1: stop and report |
| V12 | `.env` is mode 600, owned by `tradingapp` | `install.sh env` |
| V13 | every broker connection is paper | a live one: rule 1, stop and report |
| V16 | the dead-man's switch is pinging | wait a minute, run `install.sh verify` again |

SKIP is not a failure: V13 is SKIP until a broker is added and V16 until a
heartbeat URL is set. There is no V14 or V15; the app checks brokers itself.

Exit codes: `0` done; `1` a step failed (read the output); `2` an input is
missing or invalid; `3` refused for safety. `mt5-sidecar-wine.sh` adds `4`:
a person must act on the terminal's screen.

### A.4 Rebuilding the app server

When CT 110 is lost or broken, the database in CT 100 is untouched and the
app can be rebuilt around it. You need the key from step 2.4.

1. Remove the old CT 110, or stop it and give the new one another ID.
2. Do step 2 again, adding `SETTINGS_ENCRYPTION_KEY=<the saved key>` to the
   answers.

The backend adopts the existing tables, applies only pending migrations,
checks the key and comes up configured: no setup screen, and your login,
brokers and settings are already there. Then redo step 8.3's rules if the
address changed. If it stops with `key_mismatch`, the key is wrong; see
[OPERATIONS.md § Lost encryption key](OPERATIONS.md#lost-encryption-key).

### A.5 Rules for an agent running the install

The installer is written so that an agent can drive it. Each rule exists
because breaking it can lose money or lock the operator out.

1. **Paper only.** Never turn on `LIVE_TRADING_ENABLED` or
   `SYSTEMATIC_EXECUTION_ENABLED` (answers, `.env` or the Settings page).
   Never add a live connection, set `TRADING_MODE=live` for IB Gateway, or
   set `MT5_ALLOW_REAL=true`. Do not work around exit code 3.
2. **Never invent an operator input.** Broker logins, API keys, Telegram
   tokens, heartbeat URLs, addresses and the database password come from the
   operator. The scripts generate the internal secrets (encryption key,
   broker service token, Redis password); do not choose them. Generate an MT5
   sidecar secret with `openssl`, never type one. The login password is
   chosen by the operator in the browser.
3. **Never print a secret** into chat, a ticket, a commit or a kept log. Say
   where it is instead (for example `/opt/tradingapp/.env`, key
   `SETTINGS_ENCRYPTION_KEY`). The setup code counts: tell the operator how to
   read it, not the code.
4. **Stop on a FAIL.** Fix only what the linked section describes and re-run
   the phase. If it still fails, stop and report.
5. **Re-running is safe; editing by hand is not.** Do not edit `.env` unless
   the operator asks.
6. **Do not open ports to the internet** or change firewalls unless asked.
7. **Never clear data on your own.** `./tradingapp.sh forget-secrets` and
   `clean --include-database` destroy data. Only on the operator's word.

Report to the operator: the outcome (`PASS`, or the phase that stopped and its
exit code), `/var/log/tradingapp-install/report.txt` (it holds no secrets),
the address and that the first visit asks for the setup code, a reminder to
save the encryption key, what was skipped and the input it needs, and what
only the operator can do next (broker logins, TLS, firewall, backups).

---

## Appendix B: One container for evaluation

To try the app, one Docker container can hold the app and its own database.
The data then shares a disk and a backup with the app, so move it to a
database server ([OPERATIONS.md § Move to an external database](OPERATIONS.md#move-from-the-bundled-to-an-external-database))
before you collect history worth keeping.

1. Create CT 110 as in [step 2.1](#21-create-the-container), with a `100` GB
   disk and `12288` MiB of RAM.
2. In its Console, with no answers to give:

   ```bash
   mkdir -p -m 700 /etc/tradingapp
   install -m 600 /dev/null /etc/tradingapp/install.answers
   curl -fsSL https://raw.githubusercontent.com/41agent41/tradingapp/master/install/install.sh -o /root/install.sh
   bash /root/install.sh all
   ```

   Without `INSTALL_DB_MODE=external`, the installer runs TimescaleDB as a
   container next to the app and generates its password. Its data lives in
   the `tradingapp_pgdata` Docker volume (Docker shows it as
   `tradingapp_tradingapp_pgdata`).
3. Continue with [step 2.4](#24-save-the-encryption-key).

## Appendix C: Without Proxmox

The app runs on any Ubuntu 22.04+ or Debian 12+ machine with 4 GB of memory
and 15 GB of free disk. The servers in this guide map onto it directly:

- **Database:** any PostgreSQL 15, 16 or 17 with TimescaleDB, prepared as in
  steps 1.2 to 1.4 (on another machine, or a managed service that offers the
  extension). Or let the app run its own, as in Appendix B.
- **App:** as root, steps 2.2 and 2.3 unchanged. Or, as a user with sudo
  rights (not root), from a clone of the repository:

  ```bash
  git clone https://github.com/41agent41/tradingapp.git ~/tradingapp
  cd ~/tradingapp
  ./tradingapp.sh install                  # with its own database
  ./tradingapp.sh install --external-db    # with yours: asks for its address and password
  ./tradingapp.sh backup-key
  ```

  `./tradingapp.sh install` installs Docker if it is missing and accepts
  `--answers FILE` and `--non-interactive`.
- **Brokers:** the MT5 sidecar needs a Linux machine for the Wine script or a
  Windows machine (step 4.2). IB Gateway runs anywhere Docker does, with the
  same two files as step 4.3.
- **TLS:** any reverse proxy that forwards to port 3000 with WebSocket
  support and sends `X-Forwarded-Proto`; set `CORS_ORIGINS` and
  `TRUST_PROXY` as in step 7.3 (for a proxy on the app server itself,
  `TRUST_PROXY` is `172.20.0.1`, the Docker network's gateway). Docker's published ports bypass `ufw`, so
  close 3000 and 4000 at a firewall Docker does not control.
