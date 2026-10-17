# Installing TradingApp

This guide takes you from an empty host to a working install trading on
paper. Do the steps in order. Each one ends with a check, and later steps
assume the earlier ones passed.

| Step | What you do | Where |
|---|---|---|
| [0. Plan](#0-plan) | Decide the database, the brokers and the hosts | on paper |
| [1. Host](#1-prepare-the-host) | A Linux host with a sudo user | the app host |
| [2. Database](#2-database) | The bundled database, or your own PostgreSQL + TimescaleDB | the database host |
| [3. App](#3-install-the-app) | `./tradingapp.sh install` | the app host |
| [4. Sign in](#4-sign-in-and-secure-the-app) | Login password, order MFA, trading token | the browser |
| [5. Brokers](#5-add-brokers) | OANDA, then MT5, then IB, then Alpaca, as you need them | broker hosts, then the browser |
| [6. Market data](#6-choose-the-market-data-to-collect) | Instruments, timeframes, history | the browser |
| [7. Alerts](#7-alerts-and-safety-nets) | Telegram, heartbeat, risk limits | the browser |
| [8. Network](#8-reverse-proxy-tls-and-firewall) | nginx, TLS, firewall | the app host |
| [9. Backups](#9-backups-and-start-on-boot) | Encryption key, database dumps, boot unit | the app and database hosts |
| [10. Verify](#10-verify) | Everything above, checked once more | the app host |

On Proxmox, build the guests with [PROXMOX.md](PROXMOX.md) as you reach
steps 1, 2 and 5; it points back here for everything inside them. To run
the whole install from a script or an agent, see
[Appendix A](#appendix-a-unattended-install). Running, upgrading and
troubleshooting an installed app are in [OPERATIONS.md](OPERATIONS.md).

> **Paper first.** Everything in this guide keeps to paper: every broker
> connection is a paper or demo account and live trading stays off. Going
> live is a separate, deliberate step
> ([OPERATIONS.md § Going live](OPERATIONS.md#going-live)).

---

## 0. Plan

Decide three things before you start.

**The database.** Settings, logins, broker connections and market data all
live in the database, so it comes first.

| Choice | Use it when | Step 2 |
|---|---|---|
| **Bundled** (default) | Evaluation, or one host for everything. TimescaleDB runs as a container on the app host, with its data in a Docker volume there. | Nothing to do |
| **External** | Anything you want to keep. The data gets its own disk, backups and restore path, and the app host can be rebuilt without touching it. | [2B](#2b-external-database) |

You can move from bundled to external later, but it is a data migration
([OPERATIONS.md § Move to an external database](OPERATIONS.md#move-from-the-bundled-to-an-external-database)).

**The brokers.** The app asks brokers in this order of priority, and this
guide adds them in the same order:

| Priority | Broker | Needs a host of its own? | What you need from the broker |
|---|---|---|---|
| 1 | OANDA (FX, CFDs) | No, it is a cloud API | A practice account: API token and account id |
| 2 | MetaTrader 5 | Yes: Windows, or Linux under Wine | A demo account: login, password, server, and the server's time zone |
| 3 | Interactive Brokers | Yes: IB Gateway, logged in | A paper account |
| 4 | Alpaca (US stocks, options) | No, it is a cloud API | A paper API key and secret |

None is required to install. Without a broker the app runs, but charts,
quotes and orders need at least one.

**The hosts and addresses.** Write down the app host's address, and the
address of each database, IB Gateway and MT5 host. The app's Docker network
uses `172.20.0.0/16`; if your LAN or VPN uses any part of that range, see
[PROXMOX.md § Plan](PROXMOX.md#2-plan-the-deployment) before you go on.

---

## 1. Prepare the host

The app host needs:

- Ubuntu 22.04+ or Debian 12+: a VM, a Proxmox LXC
  ([PROXMOX.md § 5](PROXMOX.md#5-create-the-app-container)) or bare metal.
- 4 GB of memory (the frontend build needs it) and 15 GB of free disk, more
  with the bundled database and a lot of history.
- Outbound HTTPS, for Docker images, GitHub and the cloud brokers.
- A normal user with sudo rights. `./tradingapp.sh` refuses to run as root.

As root, once:

```bash
apt update && apt install -y sudo git curl openssl
adduser tradingapp
usermod -aG sudo tradingapp
su - tradingapp
```

As that user, clone the repository into its home directory (not `/root`,
which other users cannot read):

```bash
git clone https://github.com/41agent41/tradingapp.git ~/tradingapp
cd ~/tradingapp
```

To use `/opt/tradingapp` instead, run
`sudo mkdir -p /opt/tradingapp && sudo chown tradingapp: /opt/tradingapp`
first and clone there.

Docker is installed by step 3 if it is missing. On a Proxmox LXC on ZFS
storage, install it by hand first
([PROXMOX.md § 5.2](PROXMOX.md#52-install-docker)), because the storage
driver has to be chosen before Docker first starts.

**Check:** `whoami` prints `tradingapp`, and `ls ~/tradingapp/tradingapp.sh`
finds the script.

---

## 2. Database

The app needs PostgreSQL with the TimescaleDB extension. It creates and
updates its own schema when it starts, so there is never any SQL to apply by
hand.

### 2A. Bundled database

Nothing to do now. Step 3 starts TimescaleDB as a container on the app host
(`docker-compose.db.yml`, image `timescale/timescaledb:2.17.2-pg15`, address
`172.20.0.20`, published on the host's loopback only) and generates its
password. Go to [step 3](#3-install-the-app).

### 2B. External database

Any PostgreSQL 15, 16 or 17 with TimescaleDB will do: a VM or container of
your own, or a managed service with the extension available (Timescale
Cloud, or a cloud Postgres that offers it). On Proxmox,
[PROXMOX.md § 4](PROXMOX.md#4-create-the-database-container) builds one.

1. **Install PostgreSQL and TimescaleDB** on the database host (Ubuntu shown;
   see Timescale's own install guide for others):

   ```bash
   apt update && apt install -y gnupg postgresql-common apt-transport-https lsb-release wget
   /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
   echo "deb https://packagecloud.io/timescale/timescaledb/ubuntu/ $(lsb_release -cs) main" \
     > /etc/apt/sources.list.d/timescaledb.list
   wget --quiet -O - https://packagecloud.io/timescale/timescaledb/gpgkey \
     | gpg --dearmor > /etc/apt/trusted.gpg.d/timescaledb.gpg
   apt update && apt install -y timescaledb-2-postgresql-17 postgresql-client-17
   timescaledb-tune --quiet --yes
   systemctl restart postgresql
   ```

   If `apt update` finds no TimescaleDB packages, packagecloud has not
   published for your release yet: use the previous LTS codename (`jammy`
   for `noble`) in `timescaledb.list`.

2. **Create the role, the database and the extension.** Make a password and
   keep it; step 3 asks for it.

   ```bash
   openssl rand -base64 24
   sudo -u postgres psql <<'SQL'
   CREATE ROLE tradingapp WITH LOGIN PASSWORD 'REPLACE_WITH_THE_PASSWORD';
   CREATE DATABASE tradingapp OWNER tradingapp;
   SQL
   sudo -u postgres psql -d tradingapp -c 'CREATE EXTENSION IF NOT EXISTS timescaledb;'
   ```

   The role must own the database, so the app can create and alter its
   tables. It does not need to be a superuser, which is why the extension is
   created here.

3. **Let the app host in, and only the app host.** With PostgreSQL 17 and an
   app host at `10.7.3.20`, a database host at `10.7.3.21`:

   ```bash
   sed -i "s/^#\?listen_addresses.*/listen_addresses = '10.7.3.21'/" \
     /etc/postgresql/17/main/postgresql.conf
   echo "host    tradingapp    tradingapp    10.7.3.20/32    scram-sha-256" \
     >> /etc/postgresql/17/main/pg_hba.conf
   systemctl restart postgresql
   ```

   Firewall port 5432 to the app host as well (`ufw allow from 10.7.3.20 to
   any port 5432 proto tcp`, or the hypervisor's firewall).

4. **TLS.** On a private bridge or LAN you can leave it off. If the database
   is anywhere else, give PostgreSQL a certificate, set `ssl = on`, make the
   `pg_hba.conf` line `hostssl`, and answer yes to the TLS question in
   step 3 (`POSTGRES_SSL=true`).

**Check,** from the app host:

```bash
nc -vz 10.7.3.21 5432
```

---

## 3. Install the app

On the app host, as the deploy user, in the checkout:

```bash
./tradingapp.sh install                  # bundled database (2A)
./tradingapp.sh install --external-db    # your own database (2B): asks for its host and password
```

What it does, in order:

1. Checks for `curl` and `openssl`. Installs Docker and its compose plugin if
   missing, and adds you to the `docker` group. It carries on under
   `sg docker`, so you do not need to log out.
2. Writes `.env` (mode 600) with seven keys and nothing else:
   `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`,
   `POSTGRES_DB`, `POSTGRES_SSL` and `SETTINGS_ENCRYPTION_KEY`. It generates
   the encryption key, and with the bundled database also the database
   password. It never replaces a password or key that is already there.
   With `--external-db` it asks whether the database needs TLS, and for the
   encryption key of an earlier install if the database already holds data.
3. Builds the images and starts the stack. The first build takes several
   minutes.
4. Waits, up to 900 seconds, until the backend reports ready: database
   reached, schema created or migrated, encryption key checked. It prints
   what it is waiting for, and stops early if the backend reports
   `migration_failed` or `key_mismatch`.
5. Checks that the frontend, backend and broker service answer. It does not
   test brokers; the app does that, and a broker that is down never fails an
   install.
6. Prints the address and, on a new install, the setup code.

The broker service token and the Redis password are not in `.env`. A
one-shot container generates them into the `internal_secrets` Docker volume
on first start.

Flags:

| Flag | Effect |
|---|---|
| `--external-db` | Use your own database (step 2B). Asks for its host and password, or reads them from `.env` or `--answers`. |
| `--answers FILE` | Read `KEY=VALUE` answers instead of asking (format in [`install/install.answers.example`](../install/install.answers.example)). The file must be mode 600. Broker keys are refused. |
| `--non-interactive` | Never prompt. |
| `--env-only` | Write `.env` and stop. |

`INSTALL_TIMEOUT=1800 ./tradingapp.sh install` waits longer on a slow host.

**Save the encryption key now,** somewhere off this host such as a password
manager:

```bash
./tradingapp.sh backup-key
```

It opens every secret the app stores in the database: broker credentials,
alert tokens, the MFA secret. Any rebuild that keeps the database needs it.

**Check:** install ends with `All checks passed` and the address.
`./tradingapp.sh doctor` shows `state: ready`. If it stops instead, the
message names the state; see
[OPERATIONS.md § Readiness states](OPERATIONS.md#the-page-says-it-is-waiting-for-the-database-or-a-key-mismatch).

---

## 4. Sign in and secure the app

1. Open `http://<app-host>:3000`.
2. Enter the setup code. If you missed it, `./tradingapp.sh setup-code`
   shows it again.
3. Choose the login password.
4. Open **Settings**. The **Getting started** checklist at the top ticks
   itself off as you complete each step of this guide.
5. On **Settings > Security**:
   - enrol **order MFA**: scan the QR code with an authenticator app and
     enter a code;
   - make a **trading token** and keep it (it is shown once).

   Placing orders, and any change that loosens a gate or raises a cap, needs
   both.
6. For scripts, make an **API token** on the same tab. Scripts send it as
   `Authorization: Bearer <token>`.

**Check:** the checklist shows the login password and the order MFA and
trading token steps done.

---

## 5. Add brokers

Every broker is added the same way, on **Settings > Connections**: choose
the broker, fill in the form, and save. The app tests the connection as it
saves it, shows the result, and keeps checking it on a timer
(`BROKER_PROBE_INTERVAL_SECONDS` on Settings > Schedulers and data; 0 pauses
it). Secrets are stored in the database, encrypted with the key from step 3.

Every form has these fields:

| Field | Meaning |
|---|---|
| Name | The account's name in the app: lower-case letters, digits, `-` and `_`, such as `oanda-practice`. Requests address it as `broker=<broker>&account=<name>`. |
| Mode | `paper` or `live`. It is binding: a live order to a paper connection is refused. Use **paper** throughout this guide. |
| Currency | The account currency, such as `USD`. |
| Default | The connection used for this broker when a request names no account. |
| Limits, prop rules | Optional per-account risk limits; set them in [step 7](#7-alerts-and-safety-nets). |

Add one broker at a time and check it before the next, so a failure has one
cause. Do not put brokers in `.env` or in an answers file: install refuses
them there.

### 5.1 OANDA

A cloud API; there is no host to prepare.

1. In OANDA's account portal, generate an API token for your practice
   account and note its account id (`101-001-1234567-001` style).
2. On Settings > Connections, add **OANDA**, Mode **paper**, with the
   **Account ID** and **API token**. Paper connections use OANDA's practice
   environment.

**If the test fails:** the token or account id is wrong, the token belongs
to a live account, or the app host has no outbound HTTPS.

### 5.2 MetaTrader 5

MT5 needs a terminal that stays logged in, and the `MetaTrader5` Python
package that drives it only runs on Windows Python. So each account gets a
terminal and a small HTTP service next to it, the **sidecar**
(`mt5_sidecar/`), on a host of its own: Windows, or Linux under Wine. Not the
app host (its LXC is unprivileged and its stack is Linux-only).

One sidecar serves one terminal logged in to one account. Two accounts need
two terminals and two sidecars on two ports.

#### Make the shared secret

The app and the sidecar share a secret that the sidecar demands on every
request. Anything that reaches the sidecar with it can trade the account.
Make it on the MT5 host and keep it for the app's form:

```bash
openssl rand -hex 32
```

It goes in the sidecar's own settings as `MT5_BRIDGE_SECRET` (never in the
app's `.env`). The sidecar refuses to listen on anything but loopback without
a secret of at least 24 characters.

#### Sidecar settings

The sidecar reads `sidecar.env` next to `server.py` (Windows), or
`/etc/mt5-sidecar/<instance>.env` (Linux), copied from
[`mt5_sidecar/sidecar.env.example`](../mt5_sidecar/sidecar.env.example).
Variables in the process environment win over the file.

| Variable | Default | Meaning |
|---|---|---|
| `MT5_BRIDGE_SECRET` | none | The shared secret above |
| `MT5_SIDECAR_HOST` / `MT5_SIDECAR_PORT` | `127.0.0.1` / `9100` | Listen address; set the host to the address the app host reaches |
| `MT5_TERMINAL_PATH` | none | `terminal64.exe` to attach to, and relaunch if it exits |
| `MT5_PORTABLE` | `false` | Start the terminal in portable mode (one install folder per account) |
| `MT5_LOGIN` / `MT5_PASSWORD` / `MT5_SERVER` | none | Log the terminal in on start. With `MT5_LOGIN` set, a terminal logged in to another account is refused. |
| `MT5_SERVER_TZ` | `UTC` | The trade server's time zone, such as `Europe/Athens` |
| `MT5_MAGIC` | `61000` | Magic number on every order this sidecar sends |
| `MT5_DEVIATION_POINTS` | `20` | Slippage accepted on market orders |
| `MT5_ALLOW_REAL` | `false` | Allow orders on a real-money account. Leave it `false`. |

In the terminal, turn **Algo Trading** on (`/health` reports
`trading_disabled` while it is off), and raise **Tools > Options > Charts >
Max bars in chart** if you need long histories.

#### Option 1: Windows

1. Install the MT5 terminal from your broker. For two accounts, install it
   twice into two folders, such as `C:\MT5-A` and `C:\MT5-B`, and set
   `MT5_PORTABLE=true`.
2. Install 64-bit Python 3.11 from python.org, and put the repository (or
   just `mt5_sidecar/`) on the host, for example at `C:\tradingapp`.
3. Install and try the sidecar in the foreground:

   ```powershell
   cd C:\tradingapp\mt5_sidecar
   python -m pip install -r requirements.txt
   copy sidecar.env.example sidecar.env    # then edit it
   python server.py
   ```

4. Run it at logon. The terminal needs an interactive desktop, so use Task
   Scheduler with automatic logon, not a Windows service:

   ```powershell
   $action  = New-ScheduledTaskAction -Execute "powershell.exe" `
     -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\tradingapp\mt5_sidecar\deploy\run-sidecar.ps1"
   $trigger = New-ScheduledTaskTrigger -AtLogOn
   $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
     -ExecutionTimeLimit ([TimeSpan]::Zero)
   Register-ScheduledTask -TaskName "MT5 sidecar A" -Action $action -Trigger $trigger -Settings $settings
   ```

   `run-sidecar.ps1` restarts the sidecar if it exits and logs to
   `sidecar.log`. For a second account, copy the folder, give it its own
   `sidecar.env` (another port and terminal path) and register a second
   task.
5. Allow the port through Windows Firewall from the app host only, and give
   the VM its own time source.

#### Option 2: Linux under Wine (scripted)

The terminal and Windows Python run under Wine, headless on Xvfb, in a VM or
a privileged LXC. [`install/mt5-sidecar-wine.sh`](../install/mt5-sidecar-wine.sh)
does all of it, one Wine prefix, env file and systemd unit per account. As
root on the MT5 host, with the demo account's details passed through the
environment, not the command line:

```bash
export MT5_BRIDGE_SECRET="$(openssl rand -hex 32)"
export MT5_LOGIN=... MT5_PASSWORD=... MT5_SERVER=...
./mt5-sidecar-wine.sh install --instance broker-a --port 9100 --server-tz Europe/Athens
unset MT5_BRIDGE_SECRET MT5_PASSWORD
```

It saves the secret in `/etc/mt5-sidecar/broker-a.env` with
`MT5_ALLOW_REAL=false`; a re-run without `MT5_BRIDGE_SECRET` keeps the saved
one. `--installer-url` takes your broker's own MT5 installer. Exit 0 ends
with `check: PASS (demo account ...)`.

Exit 4 means the terminal needs a person: run
`./mt5-sidecar-wine.sh vnc --instance broker-a`, tunnel to it
(`ssh -L 5900:localhost:5900 root@<mt5-host>`), connect a VNC viewer to
`localhost:5900`, log in if asked and turn Algo Trading on. Then
`./mt5-sidecar-wine.sh check --instance broker-a`.

By hand instead, the script's steps are:

```bash
sudo apt install wine64 xvfb winbind
sudo useradd -m -d /var/lib/mt5 mt5
sudo -u mt5 -i
export WINEPREFIX=/var/lib/mt5/broker-a WINEDEBUG=-all
wget https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe
xvfb-run wine python-3.11.9-amd64.exe /quiet InstallAllUsers=0 PrependPath=1
wget https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe
xvfb-run wine mt5setup.exe /auto
wine python -m pip install -r /opt/tradingapp/mt5_sidecar/requirements.txt
```

Log in once by hand (VNC on the Xvfb display) and turn Algo Trading on, put
the settings in `/etc/mt5-sidecar/broker-a.env` with
`MT5_TERMINAL_PATH=C:\Program Files\MetaTrader 5\terminal64.exe`, then:

```bash
sudo cp /opt/tradingapp/mt5_sidecar/deploy/mt5-sidecar@.service /etc/systemd/system/
sudo systemctl enable --now mt5-sidecar@broker-a
```

Firewall the port to the app host only (`ufw` or the hypervisor's
firewall).

#### Check the sidecar from the app host

From the app host, so the network path is tested too:

```bash
SECRET=...    # the sidecar's MT5_BRIDGE_SECRET
H="X-MT5-Bridge-Secret: $SECRET"
curl -H "$H" http://<mt5-host>:9100/health         # status ok, account_type demo
curl http://<mt5-host>:9100/health                 # must be refused (401)
curl -H "$H" "http://<mt5-host>:9100/symbols?query=EURUSD&limit=20"
curl -H "$H" "http://<mt5-host>:9100/quote?symbol=EURUSD"
date -u +%s                                        # compare with the quote's time
```

While the market is open, the quote's `time` is within a few seconds of
`date -u +%s`. If it is off by whole hours, `MT5_SERVER_TZ` is wrong. Note
the exact symbol names `/symbols` returns (`EURUSD`, `EURUSD.a`, `EURUSDm`);
you may need them for a symbol map below.

#### Add the connection

On Settings > Connections, add **MetaTrader 5**, Mode **paper**:

- **Bridge URL**: the sidecar as the app host sees it, such as
  `http://10.7.3.23:9100`.
- **Bridge secret**: the sidecar's `MT5_BRIDGE_SECRET`.
- **Server timezone** (optional): the trade server's zone.

For a second account, add a second connection pointing at the second
sidecar.

**If the test fails:** check the URL and port, that the secret is the same
on both sides, and the firewall rule.

#### Not yet on the form: symbol maps and "account info from"

Two MT5 options cannot be entered on the Connections form yet:

- **Symbol map.** When a broker lists several tiers of a pair
  (`EURUSD`, `EURUSD.a`, `EURUSD.pro`), symbol resolution reports it as
  ambiguous and needs a map such as `{"EURUSD": "EURUSD.a"}`.
- **Account info from.** An MT5 account at OANDA can read its balance and
  positions from the matching OANDA connection while orders still go through
  the sidecar.

Until the form has them there are two workarounds, each with a catch:

1. **SQL, on a connection added in the app.** The backend passes every key
   of a connection's stored settings to the broker service, so:

   ```sql
   UPDATE broker_connections
      SET settings = settings || '{"symbol_map": {"EURUSD": "EURUSD.a"}}'::jsonb
    WHERE platform = 'mt5' AND account = 'broker-a-demo';
   ```

   then `./tradingapp.sh restart`. The catch: saving that connection on the
   form again rebuilds its settings from the form's fields and drops the map,
   so re-run the update after every edit.
2. **A `BROKER_CONNECTIONS` manifest in `.env`.** A JSON list of connections
   that may carry `symbol_map` and `account_info_from` (the format is at the
   top of [`broker_service/connections.py`](../broker_service/connections.py)).
   The catch: for a broker it names, `.env` replaces every connection added
   in the app (they show as overridden), so all of that broker's accounts
   must then live in the manifest, with secrets in further `.env` lines it
   refers to by name.

### 5.3 Interactive Brokers

IB Gateway (or TWS) is a Java GUI that must stay logged in. Give it a host of
its own; on Proxmox, [PROXMOX.md § 6](PROXMOX.md#6-create-the-ib-gateway-container)
runs it headless in an LXC with IBC for automatic login and daily restarts.

1. Install IB Gateway (stable, standalone) and log in to your **paper**
   account.
2. In `Configure > Settings > API > Settings` (TWS: `File > Global
   Configuration > API > Settings`):
   - turn on **Enable ActiveX and Socket Clients**;
   - set the **Socket port**: `4002` for paper (`4001` is live);
   - add the app host's address to **Trusted IPs**;
   - untick **Read-Only API** if the app will place orders, paper ones
     included.
3. Run the Gateway host in UTC. The broker service reads IB's times in
   `IB_TIMEZONE`, which defaults to UTC.
4. Firewall the socket port to the app host only. The IB API has no
   authentication beyond the trusted-IP list.
5. On Settings > Connections, add **Interactive Brokers**, Mode **paper**:
   **Gateway host**, **Port** `4002`, and a **Client ID** no other program
   uses on that Gateway (`1` if nothing else connects).

**Check,** from the app host: `nc -vz <gateway-host> 4002`.

**If the test fails:** the Gateway is not logged in, the app host is not in
its Trusted IPs, the port or client id is wrong, or a firewall blocks the
port.

### 5.4 Alpaca

A cloud API; there is no host to prepare.

1. In Alpaca's paper dashboard, generate an API key and secret.
2. On Settings > Connections, add **Alpaca**, Mode **paper**, with the
   **API key** and **API secret**. Paper connections use Alpaca's paper
   endpoint.

**If the test fails:** the key is wrong or belongs to a live account, or the
app host has no outbound HTTPS.

### 5.5 Priority and the default broker

A request that names no broker goes to the highest-priority one that has a
connection: OANDA, then MT5, then IB, then Alpaca. Change the order on the
Connections tab, or pin one with `DEFAULT_BROKER` on Settings > Trading. A
broker with no connection answers 501.

**Check:** each connection shows as connected on Settings > Connections, the
header's health badge agrees, and the Getting started checklist shows the
broker step done.

---

## 6. Choose the market data to collect

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

## 7. Alerts and safety nets

Set these before anything runs unattended. All are on the Settings page.

1. **Telegram** (Settings > Alerts and safety): create a bot with
   @BotFather, send it a message, read the chat id from
   `https://api.telegram.org/bot<TOKEN>/getUpdates`, and set
   `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
2. **Dead-man's switch** (same tab): create a check on a monitor **off this
   host**, such as healthchecks.io with a 1-minute period and 5-minute grace.
   Set `HEARTBEAT_URL`, and `HEARTBEAT_FAIL_URL` (the check's `/fail` URL).
   The backend pings it every minute, and the fail URL when the broker
   service is unreachable.
3. **Kill switch**: leave `KILL_SWITCH_ACTION` at `notify` until the paper
   runbook has shown what its alerts look like.
4. **Risk limits** (Settings > Risk): set `TRADING_DAY_TIMEZONE` to your
   broker's (or prop firm's) server zone, and the fleet-wide caps you want.
   Per-account limits and prop-firm rules go on each connection's form; a
   connection's own value wins over the fleet-wide one.

**Check:** `curl -s http://<app-host>:4000/api/health | jq .services.heartbeat`
shows `last_result: ok`, the monitor's check turns green, and the Getting
started checklist is complete.

---

## 8. Reverse proxy, TLS and firewall

The app serves plain HTTP on port 3000. Anywhere beyond an isolated lab
network, put TLS in front. The frontend forwards `/api` and `/socket.io` to
the backend itself, so one proxy location covers everything.

1. Install nginx and certbot:

   ```bash
   sudo apt install -y nginx certbot python3-certbot-nginx
   ```

2. Create `/etc/nginx/sites-available/tradingapp`:

   ```nginx
   map $http_upgrade $connection_upgrade {
       default upgrade;
       ''      close;
   }

   server {
       listen 80;
       server_name trading.example.com;

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

3. Enable it, then let certbot add the certificate and the HTTPS redirect:

   ```bash
   sudo ln -s /etc/nginx/sites-available/tradingapp /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d trading.example.com --redirect
   ```

4. On **Settings > Network**, set **Allowed browser origins**
   (`CORS_ORIGINS`) to `https://trading.example.com`, and **Trusted reverse
   proxies** (`TRUST_PROXY`) to `172.20.0.1`, the Docker network gateway
   nginx reaches the frontend from. Login lockout and the settings history
   then record the visitor's address instead of nginx's. Both apply at once.
   (The session cookie is marked secure from nginx's `X-Forwarded-Proto`;
   `COOKIE_SECURE` on Settings > Security is only for a proxy that does not
   send it.)

5. Firewall:

   ```bash
   sudo ufw allow OpenSSH
   sudo ufw allow 'Nginx Full'
   sudo ufw enable
   ```

   Docker writes its own iptables rules ahead of ufw's, so ports 3000 and
   4000 stay reachable from the LAN even with ufw on. Filter them where
   Docker cannot reach: the hypervisor's firewall
   ([PROXMOX.md § 8](PROXMOX.md#8-firewall-at-the-hypervisor)) or the
   network's. The broker service (8000) and the bundled database (5432) are
   published on loopback only, and Redis not at all. Never publish the broker
   service: it can place orders.

**Check:** `https://trading.example.com` loads and signs in, and from another
machine `nc -vz <app-host> 8000` fails.

---

## 9. Backups and start on boot

1. **The encryption key.** Confirm it is stored off the host (step 3). A
   database backup without it restores everything except the stored secrets.
2. **Database dumps.** For the bundled database, a daily cron job on the app
   host:

   ```bash
   #!/usr/bin/env bash
   # /usr/local/bin/backup-tradingapp.sh
   set -euo pipefail
   cd /home/tradingapp/tradingapp
   BACKUP_DIR=/var/backups/tradingapp
   mkdir -p "$BACKUP_DIR"
   docker compose -f docker-compose.yml -f docker-compose.db.yml exec -T postgres \
     pg_dump -U tradingapp -Fc tradingapp > "$BACKUP_DIR/tradingapp_$(date -u +%Y%m%d_%H%M%S).dump"
   find "$BACKUP_DIR" -name 'tradingapp_*.dump' -mtime +14 -delete
   ```

   ```bash
   sudo chmod +x /usr/local/bin/backup-tradingapp.sh
   echo '10 2 * * * root /usr/local/bin/backup-tradingapp.sh' | sudo tee /etc/cron.d/tradingapp-backup
   ```

   For an external database, run `pg_dump -Fc` on the database host or use
   the service's own backups. Copy dumps off the host. Restoring is in
   [OPERATIONS.md § Backups](OPERATIONS.md#backups-and-restore).
3. **Start on boot.** The containers use `restart: unless-stopped`, so they
   come back after a reboot unless you stopped them. For an explicit unit
   (and after `./tradingapp.sh stop`), use the script, never a bare
   `docker compose up`, which would leave out the bundled database:

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
   WorkingDirectory=/home/tradingapp/tradingapp
   ExecStart=/bin/bash /home/tradingapp/tradingapp/tradingapp.sh start
   ExecStop=/bin/bash /home/tradingapp/tradingapp/tradingapp.sh stop
   User=tradingapp

   [Install]
   WantedBy=multi-user.target
   ```

   ```bash
   sudo systemctl daemon-reload && sudo systemctl enable --now tradingapp
   ```

   `install/install.sh service` writes the same unit for `/opt/tradingapp`.

**Check:** a dump file exists, and after a reboot (outside market hours)
`./tradingapp.sh test` passes with nothing else done.

---

## 10. Verify

```bash
./tradingapp.sh status     # every container up
./tradingapp.sh test       # frontend, backend, broker service, readiness
./tradingapp.sh doctor     # database, schema, key, brokers, and what .env holds
```

- [ ] `doctor` shows `state: ready` and `.env` holds only the seven keys
- [ ] Encryption key stored off the host
- [ ] Getting started checklist complete on the Settings page
- [ ] Each broker connection is paper and connected
- [ ] A chart renders with data for a collected instrument
- [ ] The heartbeat check is green on its monitor
- [ ] TLS in front, and the broker service unreachable from the LAN
- [ ] A database backup exists, and a reboot brings everything back

Next: take a strategy through paper trading with
[PAPER_TRADING.md](PAPER_TRADING.md). Day-to-day running, upgrades and
troubleshooting are in [OPERATIONS.md](OPERATIONS.md).

---

## Appendix A: Unattended install

[`install/install.sh`](../install/install.sh) runs steps 1 to 3, the boot
unit and a machine-checked verification from an answers file. It is written
to be driven by an agent (or a person) top to bottom, and installs in
**paper mode** only. It does what needs root (packages, Docker, the deploy
user, the checkout, the boot unit) and then runs `./tradingapp.sh install` as
the deploy user, so an unattended install and a hand install end up the
same. Brokers are not part of it: they are added in the app (step 5).

| Script | Runs on | Does |
|---|---|---|
| [`install/proxmox-create-ct.sh`](../install/proxmox-create-ct.sh) | Proxmox VE host | Creates the app LXC with the Docker-in-LXC features ([PROXMOX.md § 5.1](PROXMOX.md#51-create-it)) |
| [`install/install.sh`](../install/install.sh) | App host | Steps 1 to 3, verification, boot unit |
| [`install/mt5-sidecar-wine.sh`](../install/mt5-sidecar-wine.sh) | MT5 host | Step 5.2 option 2 |

### A.1 Rules for an agent

Each rule exists because breaking it can lose money or lock the operator out.

1. **Paper only.** Never turn on `LIVE_TRADING_ENABLED` or
   `SYSTEMATIC_EXECUTION_ENABLED` (answers, `.env` or the Settings page).
   Never add a live connection, use an IB live port (4001 or 7496), or set
   `MT5_ALLOW_REAL=true`. `install.sh` refuses the two switches with exit
   code 3; do not work around it.
2. **Never invent an operator input.** Broker logins, API keys, Telegram
   tokens, heartbeat URLs, addresses and an external database's password come
   from the operator. The scripts generate the internal secrets (encryption
   key, bundled database password, broker service token, Redis password); do
   not choose these. Generate an MT5 sidecar secret with `openssl`, never type
   one. The login password is chosen by the operator in the browser.
3. **Never print a secret** into chat, a ticket, a commit or a kept log. Say
   where it is instead (for example `/opt/tradingapp/.env`, key
   `SETTINGS_ENCRYPTION_KEY`). The setup code counts: tell the operator how
   to read it, not the code.
4. **Stop on a FAIL.** Fix only what the linked section describes and re-run
   the step. If it still fails, stop and report (A.7).
5. **Re-running is safe; editing by hand is not.** Do not edit `.env` unless
   the operator asks.
6. **Do not open ports to the internet** or change firewalls unless asked.
7. **Never clear data on your own.** `./tradingapp.sh forget-secrets` and
   `clean --include-database` destroy data. Only on the operator's word.
8. **Exit codes:** `0` done; `1` a step failed (read the output); `2` an input
   is missing or invalid (ask the operator); `3` refused for safety (stop and
   report); `4` (MT5 script) the operator must act on the terminal's screen.

### A.2 Inputs

| Input | Needed for | Notes |
|---|---|---|
| Target: a Proxmox host, or an Ubuntu 22.04+/Debian 12+ host | everything | Root SSH (or `pct exec`) |
| App host address, gateway, bridge, CT id, storage | Proxmox only | Not in `172.20.0.0/16` |
| Database: bundled or external | `INSTALL_DB_MODE` | Default bundled. External needs step 2B done, its host and password |
| Saved encryption key | a rebuild that keeps a database | From `./tradingapp.sh backup-key` on the old host |
| Broker accounts, hosts and credentials | step 5, optional | Entered in the app, never in the answers |
| Telegram bot token and chat id, heartbeat URLs | step 7, recommended | Settings page, or the answers |

With none of the optional inputs the result is a working app with no broker.

### A.3 Proxmox container (skip on an existing host)

On the Proxmox host (`pveversion` 8 or later, and `chronyc tracking` showing
leap status `Normal`):

```bash
mkdir -p /root/tradingapp-install && cd /root/tradingapp-install
for f in proxmox-create-ct.sh install.sh install.answers.example mt5-sidecar-wine.sh; do
  curl -fsSLO "https://raw.githubusercontent.com/41agent41/tradingapp/master/install/$f"
done
chmod +x *.sh

# One container with the bundled database; drop --bundled-db for an external one.
./proxmox-create-ct.sh --ctid 110 --ip 10.7.3.20/24 --gw 10.7.3.1 \
  --storage local-lvm --bundled-db

pct exec 110 -- mkdir -p -m 700 /etc/tradingapp
pct push 110 install.sh /root/install.sh --perms 0755
pct push 110 install.answers.example /etc/tradingapp/install.answers --perms 0600
```

**Pass:** exit 0 and `container 110 is up ... and resolves names`. The script
adds `fuse=1` itself on ZFS storage. From here everything runs inside the
container as root (`pct enter 110`).

### A.4 Answers

On an existing host, fetch `install.sh` and the example as above, then:

```bash
install -d -m 700 /etc/tradingapp
install -m 600 install.answers.example /etc/tradingapp/install.answers
```

A fresh install with the bundled database needs nothing in it. The example
documents every key. There are three kinds:

- `INSTALL_*`: the installer itself (`INSTALL_DIR`, default `/opt/tradingapp`;
  `INSTALL_USER`, `tradingapp`; `INSTALL_REF`, `master`; `INSTALL_DB_MODE`,
  `bundled`; `INSTALL_HEALTH_TIMEOUT`, 900).
- `POSTGRES_*` and `SETTINGS_ENCRYPTION_KEY`: go to `.env`. External database:
  `INSTALL_DB_MODE=external`, `POSTGRES_HOST`, `POSTGRES_PASSWORD`, and
  `POSTGRES_SSL=true` if it needs TLS. A rebuild that keeps a database: also
  `SETTINGS_ENCRYPTION_KEY`.
- Anything else is an app setting (for example `TELEGRAM_BOT_TOKEN`,
  `HEARTBEAT_URL`), stored in the app's database after deploy and not left in
  `.env`.

Broker keys (`IB_HOST`, `BROKER_CONNECTIONS`, `OANDA_*`, `ALPACA_*`, `MT5_*`)
are refused with exit 2.

**Pass:** `stat -c %a /etc/tradingapp/install.answers` prints `600`.

### A.5 Run it

```bash
/root/install.sh all
```

| Phase | Does |
|---|---|
| `preflight` | OS, root, packages, disk, network, the `172.20.0.0/16` check |
| `docker` | Installs Docker (fuse-overlayfs first on ZFS); `hello-world` must pass |
| `user` | Creates the deploy user, in the docker group |
| `repo` | Clones or fast-forwards the checkout; refuses if tracked files were changed |
| `env` | `tradingapp.sh install --env-only` as the deploy user |
| `schema` | Nothing: the backend migrates its database at startup |
| `deploy` | `tradingapp.sh install` as the deploy user: build, start, wait until ready, store app settings from the answers |
| `verify` | The checks below, written to `/var/log/tradingapp-install/report.txt` |
| `service` | The systemd unit that starts the stack on boot |

**Pass:** exit 0, and the last lines read `result: PASS` and
`done: preflight docker user repo env schema deploy verify service`. The full
log is `/var/log/tradingapp-install/install.log`. After a failure, fix the
cause and re-run from the failed phase, for example
`/root/install.sh deploy verify service`.

| Phase | Typical failure | Fix |
|---|---|---|
| preflight | address in `172.20.0.0/16`; disk; GitHub unreachable | [PROXMOX.md § 2](PROXMOX.md#2-plan-the-deployment); network |
| docker | daemon will not start; `hello-world` fails; `vfs` driver | [PROXMOX.md § 12](PROXMOX.md#12-proxmox-troubleshooting) (`nesting`, `keyctl`, `fuse` on ZFS) |
| repo | local changes in the checkout | ask the operator before discarding |
| env | exit 2 naming a key; exit 3 | ask for the key; for 3, rule 1 |
| deploy | `waiting_for_database` until the timeout | step 2B (address, `pg_hba.conf`, password, extension) |
| deploy | `migration_failed`, `key_mismatch`, `refusing to start` | [OPERATIONS.md § Troubleshooting](OPERATIONS.md#troubleshooting) |

The report has one line per check, `CHECK <id> PASS|FAIL|SKIP <detail>`:

| Check | Proves | On FAIL |
|---|---|---|
| V1 | every container is running | `./tradingapp.sh status`, `logs` |
| V2 | `/api/health` is healthy | the detail names the failing side |
| V3 | the database answers the backend (`/api/database/health`) | step 2B |
| V4 | the broker service answers `/health` | `./tradingapp.sh logs` |
| V5 | the frontend serves | `install.sh deploy` |
| V6 | the API refuses an unauthenticated call | someone changed the auth setup |
| V7 | the broker service refuses calls without its token | "token not found": the internal secrets volume is missing; `install.sh deploy` |
| V8 | the broker service is on loopback only | someone changed `docker-compose.yml` |
| V9 | `/api/health/ready`: schema up to date, key matches | the deploy rows above |
| V10 | no startup refusals in the backend log | the log line names the key |
| V11 | live trading off in `.env` and in the app | rule 1: stop and report |
| V12 | `.env` mode 600, owned by the deploy user | `install.sh env` |
| V13 | broker connections, all paper | a live one: rule 1, stop and report |
| V16 | the dead-man's switch is pinging | wait a minute, re-run `install.sh verify` |

SKIP is not a failure: V13 is SKIP until a broker is added and V16 until a
heartbeat URL is set. There is no V14 or V15; the app checks brokers itself.

### A.6 After the script

The operator then:

1. Opens `http://<app-host>:3000` and signs in (step 4). Tell them how to read
   the setup code (`runuser -u tradingapp -- ./tradingapp.sh setup-code` in
   `/opt/tradingapp`), not the code. A rebuild that kept its database has no
   setup screen.
2. Runs `./tradingapp.sh backup-key` and stores the key. Do not run it for
   them.
3. Adds the brokers (step 5). The agent may prepare the broker hosts (IB
   Gateway packages, the MT5 script) but the logins and the form are the
   operator's.
4. Sets alerts (step 7), on the Settings page or in the answers followed by
   `/root/install.sh deploy`, then `/root/install.sh verify` for V16.

On Proxmox, snapshot the container once it passes:
`pct snapshot 110 clean-install --description "install.sh all: PASS"`. Test
a reboot outside market hours (`pct reboot 110`, then `/root/install.sh
verify`).

Upgrade with the same script and answers: `/root/install.sh repo env deploy
verify`. A rebuild that keeps an external database is a fresh `all` with
`INSTALL_DB_MODE=external`, `POSTGRES_HOST`, `POSTGRES_PASSWORD` and the saved
`SETTINGS_ENCRYPTION_KEY`; it passes with V9 confirming the key and V13
listing the existing connections. A host that runs the bundled database
cannot be switched to an external one by the installer: that is a data move
([OPERATIONS.md](OPERATIONS.md#move-from-the-bundled-to-an-external-database)).

### A.7 Report to the operator

1. The outcome: `PASS`, or the phase that stopped and its exit code.
2. `/var/log/tradingapp-install/report.txt` (it holds no secrets).
3. The address, and that the first visit asks for the setup code.
4. A reminder to save the encryption key, if not confirmed.
5. What was skipped and the input it needs.
6. What only the operator can do next: broker logins, TLS (step 8), firewall
   rules, backups (step 9).
