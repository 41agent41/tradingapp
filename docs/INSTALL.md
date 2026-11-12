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

## How each step is written

Every step has the same six parts, in the same order, so neither a person
nor an agent has to guess:

| Part | What it tells you |
|---|---|
| **Where** | The machine and shell, or the page, the step is done in. |
| **Before** | What must already be true, with the command or sight that proves it. |
| **Do** | The exact commands or clicks. |
| **Expected** | The output, or the lines in it to look for. |
| **If it fails** | Each known failure, with its cause and its fix. |
| **Done when** | One check that proves the step is finished. |

Three rules apply to every step:

- **Placeholders.** Anything in angle brackets, such as `<db-address>`, is
  a value from the [values sheet](#values-sheet) or a secret from
  [the list below it](#secrets-and-where-each-one-lives). Nothing else in a
  command needs changing. Replace the brackets too.
- **A failure that is not listed.** Stop. Do not improvise a fix. Report the
  step number, the command, its output, and the log the step names.
- **Do not go on** until **Done when** holds.

**Where** uses these names:

| Name | How to get there | You are |
|---|---|---|
| Proxmox shell | Proxmox web UI > the node > **Shell** | root on the host |
| Proxmox UI | Proxmox web UI, at the place the step names | |
| CT *nnn* console | Proxmox web UI > the container > **Console** | root in that container |
| VM 120 console | Proxmox web UI > VM 120 > **Console**, log in, then `sudo -i` | root in the VM |
| The app | A browser at `http://<app-address>:3000` (after step 7, `https://<domain>`), signed in | the operator |
| Your computer | A terminal or browser on the computer at `<admin-address>` | |

Commands for the app itself run in the CT 110 console as
`runuser -u tradingapp -- ./tradingapp.sh ...` from `/opt/tradingapp`. They
are written out in full each time.

---

## Values sheet

Decide every value here before step 1, and write it down. The steps refer to
them by placeholder. A blank copy is in
[`install/site-values.example.md`](../install/site-values.example.md);
[step 2.5](#25-keep-the-values-sheet-on-the-app-server) puts the filled copy
on the app server. The sheet holds **no secrets**.

### Values you choose

| Placeholder | Meaning | Example | Used in |
|---|---|---|---|
| `<gateway>` | Your LAN's gateway, entered when each guest is created | `192.168.1.1` | 1.1, 2.1, 4.2, 4.3, 7.1, 9 |
| `<lan-range>` | Your LAN, in CIDR form | `192.168.1.0/24` | 8.3 |
| `<admin-address>` | The computer you manage the app from and sign in to IBKR from | `192.168.1.20` | 4.10, 8.3 |
| `<db-address>` | CT 100, the database | `192.168.1.100` | 1.1, 1.4, 2.2, 8 |
| `<app-address>` | CT 110, the app | `192.168.1.110` | 1.4, 2.1, 3 to 9 |
| `<mt5-address>` | VM 120, the MetaTrader 5 bridge | `192.168.1.120` | 4.2, 8 |
| `<ib-address>` | CT 130, IB Gateway and the Client Portal Gateway | `192.168.1.130` | 4.3, 4.10, 8 |
| `<proxy-address>` | CT 140, the reverse proxy | `192.168.1.140` | 7, 8 |
| `<prometheus-address>` | CT 150, Prometheus | `192.168.1.150` | 8, 9 |
| `<grafana-address>` | CT 160, Grafana | `192.168.1.160` | 9.2 |
| `<domain>` | The name the app is reached by through the proxy | `trading.example.com` | 7, 8.3 |
| `<mt5-user>` | The login user you set on VM 120 | `trader` | 4.2 |
| `<mt5-server-tz>` | Your MT5 broker's server time zone (ask the broker) | `Europe/Athens` | 4.2 |
| `<mt5-fingerprint>` | The sidecar certificate's SHA-256 fingerprint, printed in step 4.2 | `AB:CD:…` (32 pairs) | 4.2 |
| `<paper-account-id>` | Your IBKR paper account id | `DU1234567` | 4.10 |

Leave out the rows for servers you will not build.

### Values that are fixed

These are the same on every install. Change one only if it clashes with
something you already run, and then change it everywhere it is used.

| Value | Is |
|---|---|
| Guest IDs and hostnames | `100` `tradingapp-db`, `110` `tradingapp-app`, `120` `mt5-bridge`, `130` `ib-gateway`, `140` `tradingapp-proxy`, `150` `prometheus`, `160` `grafana` |
| App directory and user | `/opt/tradingapp`, user `tradingapp` |
| Database name and role | `tradingapp` and `tradingapp`, on port `5432` |
| App ports on CT 110 | `3000` the web pages, `4000` the backend (metrics for Prometheus) |
| MT5 sidecar | first account: instance `demo-a` on port `9100`; second: `demo-b` on `9101` |
| IB Gateway API | port `4002` (paper) |
| Client Portal Gateway | port `5000` |
| Proxy | `80` and `443` for visitors, `81` for its admin page |
| Prometheus, Grafana | `9090`, `3000` |
| The app's own Docker network | `172.20.0.0/16` (see the warning under [Plan the addresses](#plan-the-addresses)) |

### Secrets, and where each one lives

Secrets are never written on the values sheet, in chat, in a ticket or in a
commit. Where a command needs one, the step says where to read it.

| Placeholder or name | Made | Lives |
|---|---|---|
| `<db-password>` | Generated in step 1.3 | `/root/tradingapp-db-password` on CT 100; `/etc/tradingapp/install.answers` and `/opt/tradingapp/.env` on CT 110 |
| Encryption key | Generated by the installer in step 2.3 | `/opt/tradingapp/.env` on CT 110, and your password manager (step 2.4) |
| Setup code | Generated by the app at first start | The backend's log; step 3 reads it |
| Login password, order MFA, trading token, API tokens | Chosen or made by you in step 3 | Your password manager and authenticator app |
| `<mt5-secret>` | Generated in step 4.2 | `/etc/mt5-sidecar/demo-a.env` on VM 120, key `MT5_BRIDGE_SECRET` |
| MT5 demo login, password, server | From your broker | `/etc/mt5-sidecar/demo-a.env` on VM 120 |
| IB paper username and password | From Interactive Brokers | `/opt/ib-gateway/.env` on CT 130 |
| Broker API keys and tokens | From each broker's portal | Encrypted in the app's database, entered on Settings > Connections |
| Telegram bot token, heartbeat URLs | From Telegram and your monitor | Encrypted in the app's database, entered on Settings > Alerts and safety |

---

## Decisions to make first

Answer each question before you start. Each answer names the step to do, or
to skip.

**1. Are you trying the app out, or building it to keep?**

| Answer | Do |
|---|---|
| Trying it out, on Proxmox | [Appendix B](#appendix-b-one-container-for-evaluation), then steps 3 to 6 |
| Building it to keep, on Proxmox | Steps 1 to 11 in order |
| No Proxmox | [Appendix C](#appendix-c-without-proxmox) |

**2. Which firm holds each account you will connect?** Each firm connects
one way only. Find the firm, then do that step and no other for it.

| Your account is with | Do | Server to build |
|---|---|---|
| OANDA | [4.1](#41-oanda) | none |
| IG | [4.5](#45-ig) | none |
| IC Markets, Pepperstone, FP Markets, Fusion Markets or another cTrader firm | [4.6](#46-ctrader-ic-markets-pepperstone-fp-markets-fusion-and-others), with a cTrader account at the firm | none |
| Alpaca | [4.4](#44-alpaca) | none |
| Interactive Brokers | See question 3 | CT 130 |
| Axi, Eightcap, Vantage, a prop firm, or any firm with no web API | [4.2](#42-metatrader-5-vm-120) | VM 120 |
| A firm above, but your account there is an MT5 account | It cannot be added. Open the account type the row above names. | |

**3. Interactive Brokers: Web API or IB Gateway?**

| Answer | Do |
|---|---|
| A new connection, or any market beyond US stocks (ASX, FX, futures, options), or more than one account | Web API: create CT 130 as in [4.3](#43-interactive-brokers-ct-130) "Create the container", then [4.10](#410-interactive-brokers-web-api-client-portal-gateway). A person must sign in to it each day. |
| US stocks on one account, and it must log in with no person present | IB Gateway: all of [4.3](#43-interactive-brokers-ct-130) |
| You want Claude to read the account | That is separate from the app: [4.11](#411-ibkrs-mcp-server-for-claude) |

**4. MetaTrader 5: which kind of VM?** (Only if question 2 sent you to 4.2.)

| Answer | Do |
|---|---|
| No preference, or you want it scripted | Ubuntu with Wine: [4.2](#42-metatrader-5-vm-120) as written |
| Your broker's terminal does not run under Wine, or you already have a Windows licence and VM | "Alternative: a Windows VM" inside 4.2 |

**5. Will anyone reach the app from outside this LAN, or by a name with HTTPS?**

| Answer | Do |
|---|---|
| Yes | [Step 7](#7-reverse-proxy-and-tls-ct-140). You need `<domain>`. |
| No, only from this LAN by address | Skip step 7. In step 8.3 use the "without step 7" source for port 3000. |

**6. Do you want graphs and alert rules beyond the app's own alerts?**

| Answer | Do |
|---|---|
| Yes | [Step 9](#9-monitoring-ct-150-and-ct-160) |
| No | Skip step 9, and leave port 4000 closed in step 8.3 |

**7. Who is running the install?**

| Answer | Do |
|---|---|
| A person | Carry on. |
| An agent | Read [A.5](#a5-rules-for-an-agent-running-the-install) first. Its rules win over anything else here. The operator supplies every value and secret on the lists above. |

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

To prove all three, in the Proxmox shell:

```bash
pveversion                       # pve-manager/8.x or 9.x
timedatectl | grep synchronized  # System clock synchronized: yes
pvesm status                     # a storage with content rootdir/images, active
curl -fsSI https://github.com >/dev/null && echo internet ok
```

### Plan the addresses

The servers talk to each other by address, so each one needs an address that
does not change. Pick one for each server you will build, on your LAN, before
you start: you enter it as a static address when you create the server, or
reserve it for the server on your DHCP server. Write each one on the
[values sheet](#values-sheet).

> **One range to avoid.** The app's own Docker network uses
> `172.20.0.0/16`. If your LAN, a VPN or another bridge uses any part of
> that range, the app server loses its routes to it. Use a different range
> for your servers.

### Running a community script

Every server in this guide starts the same way. The steps below call this
"run the *name* script".

**Where:** Proxmox shell.

**Before:** the guest ID the step names is free: `pct status <id>` (or
`qm status <id>` for a VM) says it does not exist.

**Do:**
1. Find the script on [community-scripts.org](https://community-scripts.org)
   by the name in the step and copy its install command. It looks like
   this:

   ```bash
   bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/postgresql.sh)"
   ```

2. Paste it into the Proxmox shell and press Enter.
3. Choose **Advanced Install**. It walks through the container's settings
   one screen at a time. Set the ones the step lists, and keep the default
   for everything else:

   | Setting | What to enter |
   |---|---|
   | Container type | **Unprivileged** |
   | Container ID | the ID in the step (100, 110, ...) |
   | Hostname | the name in the step |
   | Disk size, CPU cores, RAM | the sizes in the step (RAM is in MiB) |
   | IPv4 | **Static**, with the address from the values sheet and `<gateway>`; or DHCP with a reservation |
   | Nesting, Keyctl | only where the step says so |

4. Answer the questions the script asks about the application, as the step
   says.

**Expected:** the script ends with `Completed successfully`.

**If it fails:**
- *The script stops while downloading:* the host has no outbound internet
  or DNS. Fix that and run it again.
- *The script says the ID is already in use:* select that guest in the
  Proxmox UI and check what it is before removing anything.
- *Anything else:* stop and report the script's last screen.

**Done when:** `pct status <id>` says `status: running`.

To work inside a container afterwards, select it in the Proxmox UI and open
**Console**. Unless you set a root password in Advanced Install, it logs you
in as root.

---

## 1. Database server (CT 100)

The database is the first dependency. Settings, logins, broker connections,
market data, orders and the audit log all live in it, and the app does not
serve until it can reach it. This step builds it completely: PostgreSQL,
TimescaleDB, the app's role and database, access for the app server only,
and nightly dumps.

### 1.1 Create the container

**Where:** Proxmox shell.

**Before:** `pct status 100` says the container does not exist, and
`<db-address>` is on the values sheet.

**Do:** [run the **PostgreSQL** script](#running-a-community-script). In
Advanced Install:

| Setting | Value |
|---|---|
| Container ID | `100` |
| Hostname | `tradingapp-db` |
| Disk size | `100` GB (market data grows; you can enlarge it later) |
| CPU cores | `4` |
| RAM | `8192` MiB |
| IPv4 | `<db-address>`, gateway `<gateway>` |

If the script asks for the container OS, choose **Debian**. When it asks
for the PostgreSQL version, enter **17**. Answer **No** to Adminer.

**Expected:** `Completed successfully`.

**If it fails:** see [Running a community script](#running-a-community-script).

**Done when:** in the CT 100 console,
`runuser -u postgres -- psql -Atc 'SHOW server_version'` prints a version
that starts with `17`.

### 1.2 Add TimescaleDB

The app stores bars and ticks in TimescaleDB, a PostgreSQL extension the
script does not install.

**Where:** CT 100 console.

**Before:** step 1.1 is done, and `free -h` shows about 8 GB in the
`Mem: total` column. If it shows the host's total instead, add
`--memory 8GB` to the `timescaledb-tune` line below.

**Do:**

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

**Expected:** no line that starts with `E:`. `timescaledb-tune` sizes
PostgreSQL's memory from what the container has and prints nothing with
`--quiet`.

**If it fails:**
- *`apt install` finds no TimescaleDB package* (`Unable to locate
  package`): Timescale has not yet published for this Debian release.
  Replace the release name in `/etc/apt/sources.list.d/timescaledb.list`
  with `bookworm` and run the last four lines again.
- *`systemctl restart postgresql` fails:* read
  `journalctl -u postgresql@17-main -n 50`, then stop and report it.

**Done when:**
`runuser -u postgres -- psql -Atc 'SHOW shared_preload_libraries'` prints a
line that includes `timescaledb`.

### 1.3 Create the app's role, database and extension

**Where:** CT 100 console.

**Before:** step 1.2 is done, and the role does not exist yet:
`runuser -u postgres -- psql -Atc "SELECT count(*) FROM pg_roles WHERE rolname='tradingapp'"`
prints `0`. If it prints `1`, this step was already done: go to **Done
when**.

**Do:** make a password, keep it in a root-only file, and create the role,
its database and the extension with it:

```bash
install -m 600 /dev/null /root/tradingapp-db-password
tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32 > /root/tradingapp-db-password
runuser -u postgres -- psql -v pw="$(cat /root/tradingapp-db-password)" <<'SQL'
CREATE ROLE tradingapp WITH LOGIN PASSWORD :'pw';
CREATE DATABASE tradingapp OWNER tradingapp;
\c tradingapp
CREATE EXTENSION IF NOT EXISTS timescaledb;
SQL
```

The password never appears on screen. Step 2.2 reads it from that file; it
is `<db-password>` in this guide.

**Expected:** these lines, in this order:

```
CREATE ROLE
CREATE DATABASE
You are now connected to database "tradingapp" as user "postgres".
CREATE EXTENSION
```

**If it fails:**
- *`role "tradingapp" already exists`:* the step was run before. To set
  the role's password to the one in the file:
  `runuser -u postgres -- psql -v pw="$(cat /root/tradingapp-db-password)" <<<"ALTER ROLE tradingapp PASSWORD :'pw';"`
- *`could not open extension control file`:* step 1.2 did not finish. Do
  it again.

**Done when:**
`runuser -u postgres -- psql -d tradingapp -Atc "SELECT extname FROM pg_extension WHERE extname='timescaledb'"`
prints `timescaledb`.

The role owns its database, so the app can create and update its own tables
when it starts. There is never any SQL to apply by hand after this. The role
is not a superuser, which is why the extension is created here.

### 1.4 Let in the app server, and nothing else

The community script lets every address on the network log in with a
password. This step replaces that with one line for the app server.

**Where:** CT 100 console.

**Before:** step 1.3 is done, and `<app-address>` is on the values sheet.

**Do:**

```bash
HBA=/etc/postgresql/17/main/pg_hba.conf
sed -i '/0\.0\.0\.0/d' "$HBA"
echo "host  tradingapp  tradingapp  <app-address>/32  scram-sha-256" >> "$HBA"
systemctl reload postgresql
```

**Expected:** no output.

**If it fails:**
- *`No such file or directory`:* PostgreSQL is not version 17. Find the
  file with `runuser -u postgres -- psql -Atc 'SHOW hba_file'` and use that
  path.
- *The app cannot connect later, in step 2.3:* the address in this line is
  not the address CT 110 really has. Correct the line and reload.

**Done when:** `grep -c tradingapp /etc/postgresql/17/main/pg_hba.conf`
prints `1` (if it prints `2`, the line was added twice: delete one with
`nano` and reload), and `grep -c '0\.0\.0\.0' /etc/postgresql/17/main/pg_hba.conf`
prints `0`.

The firewall in [step 8](#8-firewall) closes port 5432 to everything else as
well.

Encryption on the wire is optional while both servers sit on the same
Proxmox bridge, and the app connects without it by default. If the database
is anywhere else, give PostgreSQL a real certificate, change `host` to
`hostssl` in that line, and add `POSTGRES_SSL=true` in step 2.2.

### 1.5 Nightly dumps

A Proxmox backup of this container ([step 10](#10-backups-snapshots-and-boot-order))
restores like a machine that lost power. A dump is a clean copy of the data.

**Where:** CT 100 console.

**Before:** step 1.3 is done.

**Do:**

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
/usr/local/bin/backup-tradingapp.sh && ls /var/backups/tradingapp
```

**Expected:** one file name, `tradingapp_<date>_<time>.dump`.

**If it fails:** *`pg_dump: error: connection to server ... failed`:*
PostgreSQL is not running. `systemctl status postgresql`.

**Done when:** `ls /var/backups/tradingapp` lists a `.dump` file.

Copy the dumps off the host as well. Restoring one is in
[OPERATIONS.md § Backups and restore](OPERATIONS.md#backups-and-restore).

### 1.6 Check

**Where:** CT 100 console, then the Proxmox UI.

**Before:** steps 1.1 to 1.5 are done.

**Do:**

```bash
runuser -u postgres -- psql -d tradingapp -c '\dx'
runuser -u postgres -- psql -c 'SHOW shared_preload_libraries;'
ls /var/backups/tradingapp
```

Then take a snapshot, so you can return to a clean database: CT 100 >
**Snapshots** > **Take Snapshot**, named `db-ready`.

**Expected:** `\dx` lists a row named `timescaledb`; the second command
includes `timescaledb`; the third lists a dump.

**If it fails:** go back to the step that made the missing item (1.3, 1.2
or 1.5).

**Done when:** the snapshot `db-ready` shows under CT 100 > **Snapshots**.

---

## 2. App server (CT 110)

The app runs as a Docker stack: the web frontend, the backend that owns the
database, the broker service that talks to brokers, and Redis.

### 2.1 Create the container

**Where:** Proxmox shell, then the CT 110 console.

**Before:** step 1 is done, `pct status 110` says the container does not
exist, and `<app-address>` is the address you wrote into `pg_hba.conf` in
step 1.4.

**Do:** [run the **Docker** script](#running-a-community-script). In
Advanced Install:

| Setting | Value |
|---|---|
| Container ID | `110` |
| Hostname | `tradingapp-app` |
| Disk size | `60` GB |
| CPU cores | `4` |
| RAM | `8192` MiB (the app's first build needs at least 4096) |
| IPv4 | `<app-address>`, gateway `<gateway>` |
| Nesting | **Yes** (Docker needs it) |
| Keyctl | **Yes** (Docker needs it) |

If the script asks for the container OS, choose **Debian**. Answer **No** to
exposing the Docker TCP socket, and **Yes** if it offers Docker Compose.

Then, in the CT 110 console:

```bash
docker run --rm hello-world
docker info | grep 'Storage Driver'
```

**Expected:** a line `Hello from Docker!`, and
`Storage Driver: overlay2` or `Storage Driver: fuse-overlayfs`.

**If it fails:** *`hello-world` fails, or the driver is `vfs`:* fix that
first, with
[OPERATIONS.md § Proxmox containers](OPERATIONS.md#proxmox-containers).

**Done when:** both expected lines show.

### 2.2 Tell the installer about the database

The installer reads its answers from a file of three lines.

**Where:** Proxmox shell. (By hand instead: the CT 110 console, below.)

**Before:** step 2.1 is done, and `/root/tradingapp-db-password` exists on
CT 100 (step 1.3).

**Do:** build the file on the host from the password on CT 100, and put it
in CT 110, without showing the password:

```bash
umask 077
pct pull 100 /root/tradingapp-db-password /root/.tradingapp-db-password
{
  echo INSTALL_DB_MODE=external
  echo POSTGRES_HOST=<db-address>
  echo "POSTGRES_PASSWORD=$(cat /root/.tradingapp-db-password)"
} > /root/.tradingapp-answers
pct exec 110 -- mkdir -p -m 700 /etc/tradingapp
pct push 110 /root/.tradingapp-answers /etc/tradingapp/install.answers --perms 600
rm -f /root/.tradingapp-db-password /root/.tradingapp-answers
```

*By hand instead,* in the CT 110 console: run
`mkdir -p -m 700 /etc/tradingapp` and `nano /etc/tradingapp/install.answers`,
enter the three lines below with the password read from
`/root/tradingapp-db-password` on CT 100, save (Ctrl+O, Enter), exit
(Ctrl+X), and run `chmod 600 /etc/tradingapp/install.answers`.

```ini
INSTALL_DB_MODE=external
POSTGRES_HOST=<db-address>
POSTGRES_PASSWORD=<db-password>
```

**Expected:** no output.

**If it fails:** *`pct pull` or `pct push` reports an error:* use the "by
hand" route.

**Done when:** in the CT 110 console,
`stat -c '%a %U' /etc/tradingapp/install.answers` prints `600 root`, and
`grep -c . /etc/tradingapp/install.answers` prints `3`.

Every other answer is optional. The full list, with what each one does, is
in [`install/install.answers.example`](../install/install.answers.example).
Do not put broker details here: brokers are added in the app (step 4), and
the installer refuses them.

### 2.3 Run the installer

**Where:** CT 110 console.

**Before:** step 2.2 is done, and the database answers from here:
`timeout 3 bash -c '</dev/tcp/<db-address>/5432' && echo reachable` prints
`reachable`.

**Do:**

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
answers, where `<you>` is your GitHub account.

**Expected:** the last lines include `result: PASS` and
`done: preflight docker user repo env schema deploy verify service`.

**If it fails:** the message names the phase and the cause. Fix it with
the table in [A.1](#a1-phases), then run the same command again (it is safe
to re-run). The most common:
- *`waiting_for_database` until the timeout:* step 1. Check the address,
  the `pg_hba.conf` line (1.4), the password (1.3), and the extension.
- *`result: FAIL (n)`:* each failing check is a `CHECK ... FAIL` line;
  [A.3](#a3-checks) says what to do for each.
- *Anything else:* stop and report
  `/var/log/tradingapp-install/install.log` (it holds no secrets).

**Done when:** `tail -1 /var/log/tradingapp-install/report.txt` prints
`result: PASS`.

### 2.4 Save the encryption key

The app encrypts every secret it stores (broker credentials, alert tokens,
the MFA secret) with a key generated on this server. Any rebuild that keeps
the database needs it.

**Where:** CT 110 console. A person does this step: the key is shown on
screen, and an agent must not read it out
([A.5](#a5-rules-for-an-agent-running-the-install) rule 3).

**Before:** step 2.3 ended with `result: PASS`.

**Do:**

```bash
cd /opt/tradingapp
runuser -u tradingapp -- ./tradingapp.sh backup-key
```

Copy the line into a password manager, or somewhere else off this host.

**Expected:** one line `SETTINGS_ENCRYPTION_KEY=...`, then a reminder to
store it off this host.

**If it fails:** *`No SETTINGS_ENCRYPTION_KEY in .env`:* step 2.3 did not
finish. Run it again.

**Done when:** the key is in your password manager. Step 11's checklist
asks again.

### 2.5 Keep the values sheet on the app server

A filled copy of the [values sheet](#values-sheet) on the app server tells
the next person, or an agent, what this site looks like.

**Where:** CT 110 console.

**Before:** step 2.3 is done.

**Do:**

```bash
cd /opt/tradingapp
runuser -u tradingapp -- cp -n install/site-values.example.md site-values.md
runuser -u tradingapp -- nano site-values.md
```

Replace each `FILL-IN` in the **Value** column from your sheet, and write
`not built` for a server you did not build. Save (Ctrl+O, Enter) and exit
(Ctrl+X). Put no secret in it. Upgrades leave this file alone.

**Expected:** no output from `cp`.

**If it fails:** *`cp: cannot stat`:* the checkout is older than this
guide. Run `bash /root/install.sh repo` and try again.

**Done when:** `grep -c FILL-IN /opt/tradingapp/site-values.md` prints
`0`.

Commands in [OPERATIONS.md](OPERATIONS.md) run the same way as the ones
above, as the `tradingapp` user in `/opt/tradingapp`; `su - tradingapp` then
`cd /opt/tradingapp` gives you a shell for that.

---

## 3. Sign in and secure the app

**Where:** CT 110 console for the setup code, then the app in a browser. A
person does this step: it chooses the login password and enrols a phone.

**Before:** step 2 is done:
`curl -s http://127.0.0.1:4000/api/health/ready` in the CT 110 console
includes `"state":"ready"`.

**Do:**
1. Read the setup code in the CT 110 console:

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

   Placing orders, and any change that loosens a gate or raises a cap,
   needs both.
5. For scripts, make an **API token** on the same tab. Scripts send it as
   `Authorization: Bearer <token>`, where `<token>` is that API token.

**Expected:** `setup-code` prints one code. After item 2 the browser shows
the app, signed in.

**If it fails:**
- *The page asks for a password, not a setup code:* a login password is
  already set. Sign in with it; if it is lost, see
  [OPERATIONS.md § Sign-in](OPERATIONS.md#sign-in).
- *The page does not load:* `runuser -u tradingapp -- ./tradingapp.sh status`
  in `/opt/tradingapp`; every container must be up.
- *The MFA code is refused:* the phone's clock is wrong. Set it to
  automatic time and scan again.

**Done when:** the Getting started checklist shows the login password,
order MFA and trading token steps done.

---

## 4. Brokers

The app asks brokers in this order of priority. Add only the ones you use
([Decisions, question 2](#decisions-to-make-first)).

| Priority | Broker | Server | What you need from the broker |
|---|---|---|---|
| 1 | OANDA (FX, CFDs) | none, a cloud API | A practice account: API token and account id |
| 2 | IG (CFDs) | none, a cloud API | A demo login and an API key |
| 3 | cTrader (IC Markets, Pepperstone, FP Markets, Fusion and other cTrader brokers) | none, a cloud API | A demo cTrader account, a cTrader Open API application and an access token |
| 4 | Interactive Brokers, Web API (stocks, ETFs, FX, futures, options on most exchanges, ASX included) | CT 130 | A paper account id (`DU…`) and its login |
| 5 | Alpaca (US stocks, options) | none, a cloud API | A paper API key and secret |
| 6 | MetaTrader 5 (Axi, Eightcap, Vantage and other firms with no web API) | VM 120 | A demo account: login, password, server, and the server's time zone |
| 7 | Interactive Brokers, IB Gateway (US stocks) | CT 130 | A paper account: username and password |

Each firm connects one way only: through its web API when it has one, through
MT5 when it does not, and through IB Gateway only for Interactive Brokers
([4.7](#47-which-platform-for-which-firm) lists them). The app refuses any
other pairing, so an OANDA or IC Markets MT5 account cannot be added.

### Adding a connection

Every broker is added the same way. The steps below call this "add a
connection" and give only the fields that differ.

**Where:** the app, **Settings > Connections**.

**Before:** step 3 is done, and you have the broker's details the step
lists. They come from the operator, never from a guess.

**Do:** press **Add connection**, choose the **Firm** (this sets the
broker), fill in the form, and press **Save**. Every form has these
fields:

| Field | Meaning |
|---|---|
| Name | The account's name in the app: lower-case letters, digits, `-` and `_`, such as `oanda-practice`. |
| Mode | `paper` or `live`. It is binding: a live order to a paper connection is refused. Use **paper** throughout this guide. |
| Currency | The account currency, such as `USD`. |
| Default | The connection used for this broker when a request names no account. |
| Limits, prop rules | Optional per-account risk limits; see [step 6](#6-alerts-and-safety-nets). |

**Firm** is required: the **Save** button stays greyed out until one is
chosen.

**Expected:** the app tests the connection as it saves it and shows the
result. The connection's row then shows as connected. The app keeps
checking it on a timer (`BROKER_PROBE_INTERVAL_SECONDS` on Settings >
Schedulers and data). Secrets are stored encrypted with the key from step
2.4.

**If it fails:** the form shows the broker's reason. Each broker's step
lists what it usually means. If the form refuses the firm and broker
pairing, see [4.7](#47-which-platform-for-which-firm).

**Done when:** the row shows as connected, and in the CT 110 console
`cd /opt/tradingapp && runuser -u tradingapp -- ./tradingapp.sh doctor`
lists the connection as `(connected)` under `=== Brokers (checked inside the
app) ===`.

Add one broker at a time and check it before the next, so a failure has one
cause.

### 4.1 OANDA

A cloud API, with no server to build.

**Where:** OANDA's account portal, then the app.

**Before:** you have an OANDA **practice** account.

**Do:**
1. In OANDA's account portal, generate an API token for your practice
   account and note its account id.
2. [Add a connection](#adding-a-connection) with Firm **OANDA**, Mode
   **paper**, the **Account ID** and the **API token**. Paper connections
   use OANDA's practice environment.

**Expected:** the test passes and the row shows as connected.

**If it fails:** the token or account id is wrong, the token belongs to
a live account, or the app server has no outbound HTTPS
(`curl -sI https://api-fxpractice.oanda.com` in the CT 110 console must
answer).

**Done when:** as in [Adding a connection](#adding-a-connection).

### 4.2 MetaTrader 5 (VM 120)

MT5 needs a terminal that stays logged in, and the `MetaTrader5` Python
package that drives it only runs on Windows Python. So each MT5 account gets
a terminal and a small HTTP service next to it, the **sidecar**
(`mt5_sidecar/`). They need a virtual machine: a container shares the host's
Linux kernel and cannot run them. Linux running the terminal under Wine is
the scripted route; a Windows VM is the alternative
([Decisions, question 4](#decisions-to-make-first)).

One sidecar serves one terminal logged in to one account. A second account
gets a second terminal and sidecar, on another port, in the same VM.

#### Create the VM

**Where:** Proxmox shell, then the Proxmox UI.

**Before:** `qm status 120` says the VM does not exist, and
`<mt5-address>` and `<mt5-user>` are on the values sheet.

**Do:** [run the **Ubuntu VM** script](#running-a-community-script).
Choose Ubuntu **24.04**, answer **Yes** to Cloud-Init, and **No** to the
default settings, then:

| Setting | Value |
|---|---|
| Virtual Machine ID | `120` |
| Disk size | `40` GiB |
| Hostname | `mt5-bridge` |
| CPU cores | `2` |
| RAM | `4096` MiB |
| Start VM when completed | **No** |

When the script finishes, open VM 120 > **Cloud-Init** in the Proxmox UI,
set the user `<mt5-user>` and a password (or an SSH key), set **IP
Config** to `<mt5-address>` with gateway `<gateway>`, click **Regenerate
Image**, and start the VM. Log in on its **Console** and run `sudo -i` for
a root shell.

**Expected:** a root prompt on `mt5-bridge`.

**If it fails:** *the login is refused:* Cloud-Init was changed after the
first boot. Stop the VM, press **Regenerate Image** again, and start it.

**Done when:** in the VM 120 console, `hostname -I` prints
`<mt5-address>`, and `curl -fsSI https://github.com >/dev/null && echo ok`
prints `ok`.

#### Install the terminal and sidecar

[`install/mt5-sidecar-wine.sh`](../install/mt5-sidecar-wine.sh) installs
Wine, Windows Python, the MT5 terminal and the sidecar, with one systemd
service per account.

**Where:** VM 120 console. A person types the demo account's login,
password and server when asked.

**Before:** the VM is created, and you have the **demo** account's login,
password and server name from the broker, and `<mt5-server-tz>`.

**Do:** download the script and give it the demo account's details
through the environment (it never takes secrets as arguments):

```bash
curl -fsSL https://raw.githubusercontent.com/41agent41/tradingapp/master/install/mt5-sidecar-wine.sh -o /root/mt5-sidecar-wine.sh
export MT5_BRIDGE_SECRET="$(openssl rand -hex 32)"
```

Run the next three lines **one at a time**. Each asks a question and waits
for the answer, so do not paste them together:

```bash
read -rp 'MT5 login: ' MT5_LOGIN
```

```bash
read -rsp 'MT5 password: ' MT5_PASSWORD; echo
```

```bash
read -rp 'MT5 server: ' MT5_SERVER
```

Then:

```bash
export MT5_LOGIN MT5_PASSWORD MT5_SERVER
bash /root/mt5-sidecar-wine.sh install --instance demo-a --port 9100 --server-tz <mt5-server-tz> --tls
unset MT5_BRIDGE_SECRET MT5_PASSWORD
```

To install your broker's own MT5 build, add `--installer-url` followed by
the download address the broker gives for its MT5 installer.

**Expected:** the script exits 0. Its output includes:

```
[mt5] TLS: on. In the app use https://<this host>:9100 and this certificate fingerprint:
[mt5]   AB:CD:...
[mt5] check: PASS (demo account 12345678 on Broker-Demo, unauthenticated 401)
```

The fingerprint is 32 pairs of characters. `<this host>` is printed just
like that, and the account number and server are your own.

Write the fingerprint on the values sheet as `<mt5-fingerprint>`. It is not
a secret.

**If it fails:**
- *Exit 4:* the terminal needs a person, to log in or to turn on **Algo
  Trading**. Run `bash /root/mt5-sidecar-wine.sh vnc --instance demo-a`,
  open an SSH tunnel to the VM from your computer
  (`ssh -L 5900:localhost:5900 <mt5-user>@<mt5-address>`), connect a VNC
  viewer to `localhost:5900`, and do it there. Then run
  `bash /root/mt5-sidecar-wine.sh check --instance demo-a`.
- *Exit 2:* an input is missing or invalid; the message names it.
- *Exit 1 with "non-demo account":* the login is a real-money account.
  This install is for demo accounts only. Do not work around it.
- *Exit 1, or anything else:* stop and report the script's output.

**Done when:** `bash /root/mt5-sidecar-wine.sh check --instance demo-a`
prints a line that starts with `check: PASS`.

What the script set up:

- The secret is generated once and saved in `/etc/mt5-sidecar/demo-a.env`;
  anything that reaches the sidecar with it can trade the account. The
  script keeps the sidecar to demo accounts (`MT5_ALLOW_REAL=false`).
- `--tls` makes a self-signed certificate for the instance
  (`/etc/mt5-sidecar/demo-a.crt` and `.key`) and has the sidecar serve HTTPS
  only, so the secret and every order cross your network encrypted. The
  app's connection is given the fingerprint below, and trusts exactly that
  certificate. Without `--tls` the link is plain HTTP, and
  `./tradingapp.sh doctor` on the app server says so.
- For a second account, run the install again with `--instance demo-b` and
  `--port 9101`. Each instance gets its own certificate and fingerprint.
- To turn TLS on for an instance installed without it, run the same install
  command again with `--tls`, then change the connection in the app to an
  `https://` Bridge URL with the fingerprint. The connection fails between
  the two steps, so do it while nothing is trading.

<details>
<summary><b>Alternative: a Windows VM</b></summary>

There is no community script for Windows.

**Where:** Proxmox UI, then the Windows desktop of VM 120.

**Before:** you have a Windows 11 ISO and licence, and the demo account's
details.

**Do:** create the VM in the Proxmox UI with **Create VM**: ID `120`, a
Windows 11 ISO and the
[VirtIO driver ISO](https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso),
2 cores, 4096 MiB, a 64 GB disk. When the Windows installer finds no disk,
load the VirtIO SCSI driver from the second CD. Give it the address
`<mt5-address>`. Then:

1. Install the MT5 terminal from your broker. For two accounts, install it
   twice into two folders and set `MT5_PORTABLE=true`.
2. Install 64-bit Python 3.11 from python.org, and put the repository (or
   just `mt5_sidecar/`) on the VM at `C:\tradingapp`.
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
7. Turn TLS on. Make a self-signed pair on any machine with OpenSSL (the
   app server has it), copy both files next to `server.py`, and name them
   in `sidecar.env`:

   ```bash
   openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj /CN=mt5-sidecar \
     -keyout sidecar.key -out sidecar.crt
   ```

   ```
   MT5_TLS_CERT=C:\tradingapp\mt5_sidecar\sidecar.crt
   MT5_TLS_KEY=C:\tradingapp\mt5_sidecar\sidecar.key
   ```

   Restart the sidecar, and delete the copy of `sidecar.key` left on the
   machine that made it.

**Expected:** the sidecar's log (`sidecar.log`) has a line
`TLS on. Certificate SHA-256 fingerprint: AB:CD:...`. Write the
fingerprint on the values sheet as `<mt5-fingerprint>`.

**If it fails:** *the sidecar refuses to listen:* `MT5_BRIDGE_SECRET` is
missing or shorter than 24 characters. Generate one with
`openssl rand -hex 32` on the app server.

**Done when:** [Check it from the app server](#check-it-from-the-app-server)
passes.

</details>

#### Sidecar settings

The script writes these to `/etc/mt5-sidecar/<instance>.env` (for the first
account, `/etc/mt5-sidecar/demo-a.env`); on Windows they go in `sidecar.env`
next to `server.py`
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
| `MT5_TLS_CERT` / `MT5_TLS_KEY` | none | A PEM certificate and its key. With both, the sidecar serves HTTPS only and logs the certificate's fingerprint when it starts. |

For long chart histories, raise **Tools > Options > Charts > Max bars in
chart** in the terminal.

#### Check it from the app server

Run from the app server, so the network path is tested too.

**Where:** CT 110 console. A person does this step: it types the sidecar's
secret.

**Before:** the sidecar's check passes on VM 120, and you can read
`<mt5-secret>` there:
`grep MT5_BRIDGE_SECRET /etc/mt5-sidecar/demo-a.env` in the VM 120 console.

**Do:**

```bash
read -rsp 'Bridge secret: ' SECRET; echo
```

Paste the secret and press Enter, then run the rest:

```bash
H="X-MT5-Bridge-Secret: $SECRET"
U=https://<mt5-address>:9100
curl -k -H "$H" $U/health
curl -k -o /dev/null -w '%{http_code}\n' $U/health
curl -k -H "$H" "$U/symbols?query=EURUSD&limit=20"
curl -k -H "$H" "$U/quote?symbol=EURUSD"
date -u +%s
unset SECRET H
```

`-k` skips the certificate check for these hand tests only, because curl
does not know the self-signed certificate. The app does check it, by its
fingerprint. Without TLS, use `http://` and drop `-k`.

**Expected:** the first reply has `"status":"ok"` and
`"account_type":"demo"`. The second prints `401`. The third lists symbol
names. While the market is open, the quote's `time` is within a few
seconds of `date -u +%s`.

**If it fails:**
- *No answer:* the VM's address or port is wrong, the service is down
  (`systemctl status mt5-sidecar@demo-a` on VM 120), or a firewall is in
  the way (step 8).
- *`401` with the secret:* the secret was mistyped.
- *The quote's time is off by whole hours:* `<mt5-server-tz>` is wrong.
  Run the install again with the right `--server-tz`.

**Done when:** the first reply shows `"account_type":"demo"` and the
second prints `401`.

Note the exact symbol names `/symbols` returns (`EURUSD`, `EURUSD.a`,
`EURUSDm`); you may need them for a symbol map ([4.9](#49-not-yet-on-the-form-symbol-maps-and-account-info-from)).

#### Add the connection

**Where:** the app. A person enters the bridge secret.

**Before:** [Check it from the app server](#check-it-from-the-app-server)
passed.

**Do:** [add a connection](#adding-a-connection) with Firm set to the
account's firm (**Axi (MT5)**, **Eightcap (MT5)**, **Vantage (MT5)**, or
**Another MT5 firm (no web API)** for any other, such as a prop firm), Mode
**paper**:

- **Bridge URL**: `https://<mt5-address>:9100` (`http://` without TLS)
- **Bridge secret**: `<mt5-secret>`
- **Certificate fingerprint**: `<mt5-fingerprint>`, with or without the
  colons. Leave it empty without TLS. To read it again, on VM 120:
  `bash /root/mt5-sidecar-wine.sh check --instance demo-a`
- **Server timezone** (optional): `<mt5-server-tz>`

For a second account, add a second connection with port 9101.

**Expected:** the connection's row reads "Encrypted to
`<mt5-address>`:9100, certificate pinned". The app reads the sidecar's
certificate before it sends anything, and sends the secret only if the
fingerprint matches.

**If it fails:**
- *The test fails to connect:* check the URL and port, and the firewall
  (step 8).
- *The secret is refused:* it is not the same on both sides.
- *"MT5 bridge not trusted":* the sidecar's certificate is not the one
  with that fingerprint. Read the fingerprint again on the sidecar's
  machine and compare.

**Done when:** `./tradingapp.sh doctor` on the app server lists the link
under `=== Links to brokers on the LAN ===` as
`encrypted, certificate pinned, reachable from this server`.

### 4.3 Interactive Brokers (CT 130)

IB Gateway is a Java application that must stay logged in. CT 130 runs it in
Docker with the [`ib-gateway`](https://github.com/gnzsnz/ib-gateway-docker)
image, which bundles IBC to log in, accept the API settings and restart it
daily without a person. For which Interactive Brokers route to use, see
[Decisions, question 3](#decisions-to-make-first).

#### Create the container

**Where:** Proxmox shell.

**Before:** `pct status 130` says the container does not exist, and
`<ib-address>` is on the values sheet.

**Do:** [run the **Docker** script](#running-a-community-script). In
Advanced Install:

| Setting | Value |
|---|---|
| Container ID | `130` |
| Hostname | `ib-gateway` |
| Disk size | `16` GB |
| CPU cores | `2` |
| RAM | `4096` MiB |
| IPv4 | `<ib-address>`, gateway `<gateway>` |
| Nesting | **Yes** |
| Keyctl | **Yes** |

Answer **No** to exposing the Docker TCP socket.

**Expected:** `Completed successfully`.

**If it fails:** see [Running a community script](#running-a-community-script).

**Done when:** in the CT 130 console, `docker run --rm hello-world` prints
`Hello from Docker!`.

#### Run IB Gateway

**Where:** CT 130 console. A person types the IB login.

**Before:** the container is created, and you have the **paper** account's
username and password.

**Do:** create the folder, then run the two `read` lines **one at a time**.
Each asks a question and waits for the answer, so do not paste them
together:

```bash
mkdir -p /opt/ib-gateway && cd /opt/ib-gateway
```

```bash
read -rp 'IB paper username: ' IB_USER
```

```bash
read -rsp 'IB paper password: ' IB_PASS; echo
```

Then write the two files and start the Gateway:

```bash
umask 077
cat > .env <<EOF
TWS_USERID=$IB_USER
TWS_PASSWORD=$IB_PASS
TRADING_MODE=paper
READ_ONLY_API=no
TIME_ZONE=Etc/UTC
AUTO_RESTART_TIME=11:59 PM
TWOFA_TIMEOUT_ACTION=restart
RELOGIN_AFTER_TWOFA_TIMEOUT=yes
EOF
unset IB_USER IB_PASS
cat > docker-compose.yml <<'EOF'
services:
  ib-gateway:
    image: ghcr.io/gnzsnz/ib-gateway:stable
    restart: always
    env_file: .env
    ports:
      - "4002:4004"
EOF
docker compose up -d
docker compose logs -f
```

Wait for the login to finish in the log, then press Ctrl+C.

**Expected:** `docker compose ps` shows the `ib-gateway` service `Up`, and
from the CT 110 console `nc -vz <ib-address> 4002` reports the port open
(`succeeded` or `open`).

**If it fails:**
- *The log shows a failed login:* the username or password is wrong, or
  it is the live login. Correct `.env` and run `docker compose up -d`.
- *IB asks for a second factor:* add `VNC_SERVER_PASSWORD=` with a
  password of your choosing to `.env` and `- "127.0.0.1:5900:5900"` under
  `ports`, run `docker compose up -d`, and reach the Gateway's screen
  through an SSH tunnel to CT 130. Never publish VNC to the network.
- *`nc` cannot connect:* the Gateway has not finished logging in, or a
  firewall blocks the port.

**Done when:** `nc -vz <ib-address> 4002` from the CT 110 console reports
the port open, and `stat -c '%a' /opt/ib-gateway/.env` on CT 130 prints
`600`.

`READ_ONLY_API=no` lets the app place orders (paper ones included). Inside
the container the API answers on its loopback, which IB Gateway always
trusts, so there is no Trusted IPs list to keep: the firewall in step 8 is
what limits port 4002 to the app server. The IB API has no authentication of
its own, so do not skip that step.

#### Add the connection

**Where:** the app.

**Before:** `nc -vz <ib-address> 4002` from the CT 110 console reports the
port open.

**Do:** [add a connection](#adding-a-connection) with Firm **Interactive
Brokers (IB Gateway)**, Mode **paper**: **Gateway host** `<ib-address>`,
**Port** `4002`, and a **Client ID** that no other program uses on that
Gateway (`1` if nothing else connects).

**Expected:** the test passes and the row shows as connected.

**If it fails:** the Gateway has not finished logging in
(`docker compose logs` in `/opt/ib-gateway` on CT 130), the port or client
id is wrong, or a firewall blocks the port.

**Done when:** as in [Adding a connection](#adding-a-connection).

A logged-out Gateway looks like a quiet market: data just stops. The
connection check on Settings > Connections shows it, and so do the alerts in
step 6.

### 4.4 Alpaca

A cloud API, with no server to build.

**Where:** Alpaca's paper dashboard, then the app.

**Before:** you have an Alpaca account with paper trading.

**Do:**
1. In Alpaca's paper dashboard, generate an API key and secret.
2. [Add a connection](#adding-a-connection) with Firm **Alpaca**, Mode
   **paper**, the **API key** and the **API secret**. Paper connections
   use Alpaca's paper endpoint.

**Expected:** the test passes and the row shows as connected.

**If it fails:** the key is wrong or belongs to a live account, or the
app server has no outbound HTTPS.

**Done when:** as in [Adding a connection](#adding-a-connection).

### 4.5 IG

A cloud API, with no server to build.

**Where:** IG's web platform, then the app.

**Before:** you have an IG **demo** login.

**Do:**
1. Log in to IG's web platform with your demo login. Under **My IG >
   Settings > API keys**, create a key. A demo key works only with a demo
   login, and a live key only with a live one.
2. [Add a connection](#adding-a-connection) with Firm **IG**, Mode
   **paper**, the **API key**, and the **Username** and **Password** of
   that login. Leave **Account ID** blank to trade the login's default
   account, or enter another account's id (such as `Z3ABCD`) from My IG.

**Expected:** the test passes and the row shows as connected.

**If it fails:** the key belongs to the other environment (demo vs
live), the password is wrong, or the app server has no outbound HTTPS.

**Done when:** as in [Adding a connection](#adding-a-connection).

Markets are addressed by IG's *epic*. Spot FX in the app's form (`EUR.USD`)
maps to IG's CFD epic (`CS.D.EURUSD.CFD.IP`); anything else uses the epic
search returns, such as `IX.D.ASX.IFT.IP`. IG meters historical prices
(10,000 points a week by default), so a chart period asks for at most the
1,000 most recent bars. IG has no 8-hour bar and no stop-limit order.

### 4.6 cTrader (IC Markets, Pepperstone, FP Markets, Fusion and others)

Spotware's cTrader Open API serves every cTrader broker through one cloud
service, so there is no server to build. The broker is whichever one holds
the account you grant access to.

**Where:** the broker's site, [openapi.ctrader.com](https://openapi.ctrader.com),
then the app.

**Before:** nothing. Allow a day or two: Spotware approves new
applications.

**Do:**
1. Open a demo cTrader account at the broker.
2. At [openapi.ctrader.com](https://openapi.ctrader.com), sign in with the
   same cTrader ID, add an application, and note its **client ID** and
   **client secret**.
3. In the application's **Playground**, authorise it with the **trading**
   scope and copy the **access token**. The playground also lists your
   accounts with their `ctidTraderAccountId`, the number to enter as the
   account id (it is not the account login).
4. [Add a connection](#adding-a-connection) with Firm set to the account's
   firm (**IC Markets (cTrader)**, **Pepperstone (cTrader)**, **FP Markets
   (cTrader)**, **Fusion Markets (cTrader)**, or **Another cTrader
   firm**), Mode **paper**, with the client ID, client secret, access
   token and ctidTraderAccountId.

**Expected:** the test passes and the row shows as connected.

**If it fails:** the access token has expired or was issued for another
account, the account id is the login instead of the ctidTraderAccountId,
or the app server cannot reach `demo.ctraderapi.com` on port 5036
(`nc -vz demo.ctraderapi.com 5036` in the CT 110 console).

**Done when:** as in [Adding a connection](#adding-a-connection).

Quantities on cTrader are in units, as on OANDA (100,000 EURUSD units is one
lot). cTrader has no 8-hour bar.

**Access tokens expire after about 30 days.** The app does not refresh them
(refreshing replaces the refresh token, which the broker service cannot write
back), so when the connection check reports that the credentials were
refused, issue a new token in the playground and paste it into the
connection.

### 4.7 Which platform for which firm

Each firm has exactly one connection type. The app refuses to save any other
pairing, and also refuses a connection named after a firm of another type
(an MT5 connection named `icmarkets`, for example).

| Firm on the form | Broker it sets | Notes |
|---|---|---|
| OANDA | OANDA | Native REST API. OANDA MT5 accounts cannot be added. |
| IG | IG | Native REST API. |
| IC Markets, Pepperstone, FP Markets, Fusion Markets (each "(cTrader)") | cTrader | cTrader Open API. Their MT5 accounts cannot be added; open a cTrader account with the firm instead. |
| Another cTrader firm | cTrader | Any other firm on cTrader. |
| Interactive Brokers (Web API), Australia included | IBKR Web API | The Web API ([4.10](#410-interactive-brokers-web-api-client-portal-gateway)) reaches every market the account trades and allows several accounts. Prefer it for a new connection. IBKR's MCP server ([4.11](#411-ibkrs-mcp-server-for-claude)) connects an account to Claude, not to the app. |
| Alpaca | Alpaca | Native REST API. |
| Axi (MT5) | MT5 | Axi has no public trading API. Its MCP server (`mcp.axi.com`, in alpha) connects an Axi MT5 account to Claude only, not to other applications, so the app reaches Axi through the MT5 sidecar. |
| Eightcap (MT5), Vantage (MT5) | MT5 | Through the MT5 sidecar. |
| Another MT5 firm (no web API) | MT5 | Any firm with no web API, prop firms included. Not for a firm listed above. |
| Interactive Brokers (IB Gateway) | IB | The older TWS socket route ([4.3](#43-interactive-brokers-ct-130)): US stocks on one account. Interactive Brokers is the one firm with two entries on the form. |

### 4.8 Priority and the default broker

A request that names no broker goes to the highest-priority one that has a
connection: the web API brokers OANDA, IG, cTrader, the IBKR Web API and
Alpaca, then MT5, then IB Gateway. A broker with no connection answers 501.
An order you saved on the Connections tab is kept on upgrade; only the
built-in default changed.

**Where:** the app, **Settings > Connections**.

**Before:** every broker you use has a connection.

**Do:** only if the built-in order does not suit you: change the order on
the Connections tab, or pin one broker with `DEFAULT_BROKER` on
**Settings > Trading**.

**Expected:** the tab shows the order you set.

**If it fails:** *a connection shows as not connected:* go back to that
broker's step and its **If it fails**.

**Done when:** each connection shows as connected on Settings >
Connections, the header's health badge agrees, and the Getting started
checklist shows the broker step done.

### 4.9 Not yet on the form: symbol maps and "account info from"

Two MT5 options cannot be entered on the Connections form yet:

- **Symbol map.** When a broker lists several tiers of a pair
  (`EURUSD`, `EURUSD.a`, `EURUSD.pro`), symbol resolution reports it as
  ambiguous and needs a map such as `{"EURUSD": "EURUSD.a"}`.
- **Account info from.** An MT5 account at OANDA can read its balance and
  positions from the matching OANDA connection while orders still go through
  the sidecar.

**Do you need this step?** Only if a chart or order for an MT5 symbol
reports that the symbol is ambiguous. Otherwise skip it.

Until the form has them there are two workarounds, each with a catch.

**Workaround 1: SQL, on a connection added in the app.**

**Where:** CT 100 console, then the CT 110 console.

**Before:** the MT5 connection exists in the app. You know its **Name**
(here `demo-a`) and the exact symbol names from
[Check it from the app server](#check-it-from-the-app-server).

**Do:** in the CT 100 console, with your own map and connection name in
place of the ones shown:

```bash
runuser -u postgres -- psql -d tradingapp <<'SQL'
UPDATE broker_connections
   SET settings = settings || '{"symbol_map": {"EURUSD": "EURUSD.a"}}'::jsonb
 WHERE platform = 'mt5' AND account = 'demo-a';
SQL
```

Then, in the CT 110 console:

```bash
cd /opt/tradingapp && runuser -u tradingapp -- ./tradingapp.sh restart
```

**Expected:** `UPDATE 1`.

**If it fails:** *`UPDATE 0`:* no MT5 connection has that name. Read the
names with
`runuser -u postgres -- psql -d tradingapp -Atc "SELECT account FROM broker_connections WHERE platform='mt5'"`.

**Done when:** a chart of the mapped symbol shows bars.

The catch: saving that connection on the form again rebuilds its settings
from the form's fields and drops the map, so run the update again after
every edit.

**Workaround 2: a `BROKER_CONNECTIONS` manifest in `.env`.** A JSON list of
connections that may carry `symbol_map` and `account_info_from` (the format
is at the top of
[`broker_service/connections.py`](../broker_service/connections.py)). The
catch: for a broker it names, `.env` replaces every connection added in the
app (they show as overridden), so all of that broker's accounts must then
live in the manifest, with their secrets in further `.env` lines. Use
workaround 1 unless you already keep connections in `.env`.

---

### 4.10 Interactive Brokers Web API (Client Portal Gateway)

The IBKR Web API is IBKR's REST interface. For an individual account,
including one at Interactive Brokers Australia, IBKR serves it only through
the **Client Portal Gateway**, a small Java program that holds the session
after you sign in from a browser (OAuth is for institutions and approved
third-party vendors). Compared with IB Gateway in 4.3 it:

- reaches any market the account can trade: US and ASX stocks, ETFs,
  IDEALPRO FX, futures and options;
- allows several connections (say a paper and a live account);
- attaches a stop and target to the entry as one bracket order;
- needs no client ids and no GUI session.

It also has a price: the gateway must be **signed in by a person** after
each daily reset (around 01:00 in the account's region) and whenever IBKR
ends the session, with your second factor. The app keeps a live session open
(its connection check tickles the gateway every minute), but it cannot sign
in for you.

Symbols: `AAPL` is the US listing, `BHP:ASX` names the exchange, `AUD.USD` is
an IDEALPRO pair, and a number is an IBKR contract id (conid) as search
returns it, which is how futures and options are addressed. Prices need the
account's market-data subscriptions for that exchange: a paper account
shares its live account's subscriptions.

#### Run the gateway

**Where:** CT 130 console.

**Before:** CT 130 exists
([4.3, Create the container](#create-the-container)); it can run beside
IB Gateway. `<admin-address>` is on the values sheet.

**Do:** fetch the gateway's three files from the repository and start
it:

```bash
mkdir -p /opt/ibkr-gateway && cd /opt/ibkr-gateway
for f in Dockerfile entrypoint.sh docker-compose.yml; do
  curl -fsSL "https://raw.githubusercontent.com/41agent41/tradingapp/master/ops/ibkr-gateway/$f" -o "$f"
done
echo 'GATEWAY_ALLOW=<app-address>,<admin-address>' > .env
docker compose up -d --build
```

**Expected:** `docker compose ps` shows the `ibkr-gateway` service `Up`.

**If it fails:** *a `curl` line fails:* CT 130 has no outbound internet.
Fix that, or copy the three files from `/opt/tradingapp/ops/ibkr-gateway/`
on CT 110.

**Done when:** from your computer, `https://<ib-address>:5000` shows
IBKR's login page (after you accept the self-signed certificate).

`GATEWAY_ALLOW` is the gateway's own allow list (IBKR's form, `10.0.0.*`
works): only those addresses may use the API or open the login page. Keep
it to the app server and the computer you sign in from, and keep port 5000
off the internet, as in step 8.

#### Sign in

**Where:** your computer (it must be `<admin-address>`). A person does
this step, with the second factor.

**Before:** the gateway is running.

**Do:** open `https://<ib-address>:5000`, accept the self-signed
certificate, and log in with the **paper** login (IBKR's paper username,
not the live one), completing the second factor.

**Expected:** the page says "Client login succeeds".

**If it fails:**
- *The page is refused:* your computer's address is not on
  `GATEWAY_ALLOW`. Correct `/opt/ibkr-gateway/.env` on CT 130 and run
  `docker compose up -d`.
- *The login succeeds, then the connection check says the session was
  taken:* one IBKR username holds one brokerage session at a time. Logging
  in to TWS, IBKR Desktop or the mobile app with the same username takes
  the session from the gateway. Log that one out and sign in here again.

**Done when:** the page says "Client login succeeds".

For a live account, create a second username for the app in Client Portal
(Settings > Users & Access Rights) so your own logins do not compete with
it.

#### Add the connection

**Where:** the app.

**Before:** the gateway is signed in, and `<paper-account-id>` is on the
values sheet (it is shown top right in Client Portal, and starts with
`D`).

**Do:** [add a connection](#adding-a-connection) with Firm **Interactive
Brokers (Web API)**, Mode **paper**: **Client Portal Gateway URL**
`https://<ib-address>:5000` and **Account ID** `<paper-account-id>`.

**Expected:** the test passes and the row shows as connected.

**If it fails:**
- *The save is refused:* the mode must match the account. Paper ids start
  with `D`, and a paper connection with a live id (or the reverse) is
  refused.
- *The test fails:* the gateway is not signed in (sign in again), another
  IBKR session took it (log that one out), the account id belongs to a
  different login, or the app server is not on `GATEWAY_ALLOW`. The
  account must be one the gateway is signed in to, so a gateway signed in
  to the live login cannot serve a paper connection.

**Done when:** as in [Adding a connection](#adding-a-connection).

### 4.11 IBKR's MCP server, for Claude

IBKR runs a remote MCP server that connects one IBKR account to an AI app
such as Claude, ChatGPT or Claude Code: `https://api.ibkr.com/v1/api/mcp-public`.
You sign in on IBKR's own page and approve the account; the AI app never
sees your password, and you revoke it under Client Portal > Settings >
Manage Third-Party Consents. It reads balances, positions, orders, trades,
prices and contract search, and drafts trade instructions that you approve
and submit in an IBKR platform.

It is not a data or execution feed for this app. It answers AI apps only,
is authorised for a single account, and does not place orders by itself,
so the app uses the Web API (4.10) or IB Gateway (4.3) instead. It works
well beside the app: ask Claude about the same account the app trades. This
step is optional and nothing later depends on it.

**Where:** Claude, or a terminal with Claude Code.

**Before:** you have an IBKR login.

**Do:** in Claude, use **Settings > Connectors > Add custom connector**
with that URL. In Claude Code:

```bash
claude mcp add --transport http ibkr https://api.ibkr.com/v1/api/mcp-public
```

**Expected:** IBKR's own sign-in page opens and asks you to approve one
account.

**If it fails:** stop; this is IBKR's service and outside the app.

**Done when:** Claude answers a question about the account's balance.

## 5. Market data

**Where:** the app, **Settings > Schedulers and data**.

**Before:** at least one broker connection shows as connected (step 4).

**Do:**
1. In the data collection table, add an entry per instrument and
   timeframe: the broker, the symbol, the timeframe, how often to collect,
   and how many days of bars to keep.
2. For backtests, set **History from** on an entry, as far back as the
   broker has bars (the form accepts up to 30 years). The scheduler then
   also walks back to that date, 20,000 bars at a time and up to five
   chunks per entry per pass, so a year of 5-minute bars arrives in two
   passes. The History column shows how far it has got. Bars from the
   history start on are kept whatever the entry's retention. A year of
   5-minute FX bars is about 75,000 rows, roughly 10 MB, per instrument.
3. Turn on the backfill scheduler (`BACKFILL_ENABLED`). It is off by
   default because it calls brokers on a timer. It starts without a
   restart.
4. Optional, for instruments you will replay or backtest on 1-minute bars:
   tick **Record live** on the instrument's row. The app then stores its
   1-minute bars from live prices as they form, with no chart open. Tick
   **Store ticks** as well only if you want every quote kept: a busy FX
   pair is 15 to 25 MB a day, and quotes are deleted after 30 days
   (`TICK_RETENTION_DAYS`, same tab). Both boxes apply to the instrument,
   so they change on all of its rows. Each night at 02:30 UTC the app
   replaces the last two days of recorded bars with the broker's own and
   fills any gap; nothing needs turning on for that.

**Expected:** after the scheduler's next pass, a chart of a collected
instrument shows bars. If you ticked Record live, the line above the table
reads "Live recorder: on", and within a minute of the market being open
the row's Live feed column shows "streamed" or "polled" with a count of
quotes.

**If it fails:**
- *The Live feed column reads "not streaming:":* it is followed by the
  broker's reason. Fix that at the broker's step in section 4.
- *No bars arrive:* the connection is not connected, the symbol is not one
  the broker knows (search for it on the chart page), or
  `BACKFILL_ENABLED` is still off.

**Done when:** the Getting started checklist shows the market data step
done, and a chart of a collected instrument shows bars.

Backtests run on these stored bars. An instrument that is not collected can
still be backtested: the Backtest page says which bars are missing and offers
to fetch and store them.

---

## 6. Alerts and safety nets

Set these before anything runs unattended.

**Where:** the app, on the Settings tabs named below. A person supplies
the Telegram token and the monitor's URLs.

**Before:** step 3 is done. You have a Telegram account, and an account
with a monitor **off this Proxmox host**, such as healthchecks.io.

**Do:**
1. **Telegram** (Settings > Alerts and safety): create a bot with
   @BotFather, send it a message, read the chat id from
   `https://api.telegram.org/bot<TOKEN>/getUpdates` (where `<TOKEN>` is
   the bot's token), and set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
2. **Dead-man's switch** (same tab): create a check on the monitor with a
   1-minute period and 5-minute grace. Set `HEARTBEAT_URL` to the check's
   URL, and `HEARTBEAT_FAIL_URL` to the check's `/fail` URL. The backend
   pings it every minute, and the fail URL when the broker service is
   unreachable. If the whole host goes down, this is what tells you.
3. **Kill switch**: leave `KILL_SWITCH_ACTION` at `notify` until the paper
   runbook has shown what its alerts look like.
4. **Risk limits** (Settings > Risk): set `TRADING_DAY_TIMEZONE` to your
   broker's (or prop firm's) server zone, and the fleet-wide caps you
   want. Per-account limits and prop-firm rules go on each connection's
   form; a connection's own value wins over the fleet-wide one.

**Expected:** within two minutes, in the CT 110 console,

```bash
curl -s http://127.0.0.1:4000/api/health | jq .services.heartbeat
```

shows `"last_result": "ok"`, and the monitor's check turns green.

**If it fails:**
- *`last_result` is not `ok`:* the app server cannot reach the monitor's
  URL, or the URL is mistyped. Try it with `curl -sI` and the same URL in
  the CT 110 console.
- *No Telegram message arrives:* the chat id is wrong, or you have not
  sent the bot a message first.

**Done when:** the monitor's check is green and the Getting started
checklist is complete.

---

## 7. Reverse proxy and TLS (CT 140)

The app serves plain HTTP on port 3000. Anywhere beyond an isolated lab
network, put TLS in front of it
([Decisions, question 5](#decisions-to-make-first)). Nginx Proxy Manager does
that from a web page, including the Let's Encrypt certificate. The app's
frontend forwards `/api` and `/socket.io` to the backend itself, so one proxy
host covers everything.

You need `<domain>`, pointing at the address where Nginx Proxy Manager is
reachable.

### 7.1 Create the container

**Where:** Proxmox shell.

**Before:** `pct status 140` says the container does not exist, and
`<proxy-address>` and `<domain>` are on the values sheet.

**Do:** [run the **Nginx Proxy Manager** script](#running-a-community-script).
In Advanced Install: ID `140`, hostname `tradingapp-proxy`, IPv4
`<proxy-address>` with gateway `<gateway>`; keep the default sizes.

**Expected:** `Completed successfully`.

**If it fails:** see [Running a community script](#running-a-community-script).

**Done when:** `http://<proxy-address>:81` shows Nginx Proxy Manager's
sign-in page.

### 7.2 Add the proxy host

**Where:** your computer, in a browser at `http://<proxy-address>:81`.

**Before:** step 7.1 is done, and `<domain>` resolves to the address
where the proxy is reachable (`nslookup <domain>`). Let's Encrypt must be
able to reach the proxy on port 80, or use its DNS challenge.

**Do:**
1. Sign in. The script's page on community-scripts.org gives the first
   login; you are asked to change it.
2. **Hosts > Proxy Hosts > Add Proxy Host**:
   - **Domain Names**: `<domain>`
   - **Scheme** `http`, **Forward Hostname / IP** `<app-address>`,
     **Forward Port** `3000`
   - tick **Websockets Support** and **Block Common Exploits**
3. On the **SSL** tab: **Request a new SSL Certificate**, tick **Force
   SSL** and **HTTP/2 Support**, agree to the terms, and save.

**Expected:** the proxy host is listed with status **Online** and a
certificate.

**If it fails:** *the certificate request fails:* `<domain>` does not
resolve to the proxy from the internet, or port 80 does not reach it. Fix
the DNS record or the port forward, or choose **Use a DNS Challenge** on
the SSL tab.

**Done when:** `https://<domain>` shows the app's sign-in page.

### 7.3 Tell the app about the proxy

**Where:** the app, **Settings > Network**.

**Before:** step 7.2 is done.

**Do:** set two fields:
- **Allowed browser origins** (`CORS_ORIGINS`): leave empty. The app's own
  pages are accepted without it, as long as the proxy passes the browser's
  host on in `Host` (Nginx Proxy Manager does) or `X-Forwarded-Host`.
- **Trusted reverse proxies** (`TRUST_PROXY`): `<proxy-address>`. Login
  lockout and the settings history then record the visitor's address
  instead of the proxy's.

Both apply at once. The session cookie is marked secure from the proxy's
`X-Forwarded-Proto` header, so `COOKIE_SECURE` on Settings > Security is
only for a proxy that does not send it.

**Expected:** the settings save without an error.

**If it fails:** *saving anything in the app fails with "Origin ... is
not allowed":* the proxy passes the browser's host in neither header. Set
**Allowed browser origins** to `https://<domain>`. If the Settings page
itself cannot save, see
[OPERATIONS.md § Sign-in](OPERATIONS.md#sign-in).

**Done when:** `https://<domain>` loads and signs in, and a chart on it
updates live.

---

## 8. Firewall

Docker publishes the app's ports by writing its own firewall rules, which run
before anything inside the container, so a firewall inside CT 110 cannot
close them. The Proxmox firewall filters each guest's traffic on the host,
before it reaches the guest, and nothing inside a guest can get around it.
Every rule below is set in the Proxmox web UI.

### 8.1 Name the servers

**Where:** Proxmox UI, **Datacenter > Firewall > Alias**.

**Before:** every server you will build exists.

**Do:** press **Add** once per server you built:

| Name | IP/CIDR |
|---|---|
| `tradingapp_db` | `<db-address>` |
| `tradingapp_app` | `<app-address>` |
| `mt5_bridge` | `<mt5-address>` |
| `ib_gateway` | `<ib-address>` |
| `tradingapp_proxy` | `<proxy-address>` |
| `prometheus` | `<prometheus-address>` |
| `grafana` | `<grafana-address>` |
| `admin` | `<admin-address>` |
| `lan` | `<lan-range>` |

Rules then refer to these names instead of addresses.

**Expected:** each alias is listed.

**If it fails:** *the UI refuses a name:* alias names take letters, digits
and `_` only.

**Done when:** in the Proxmox shell, `pvesh get /cluster/firewall/aliases`
lists every alias you added.

### 8.2 Turn the firewall on for each guest's network

The community scripts do not do this. Without it, the rules in 8.3 do
nothing for that guest.

**Where:** Proxmox UI, each guest in turn.

**Before:** step 8.1 is done.

**Do:** for each container: select it > **Network** > `net0` > **Edit** >
tick **Firewall** > **OK**. For VM 120: **Hardware** > **Network Device**
> **Edit** > tick **Firewall**.

**Expected:** the network line of each guest shows `firewall=1`.

**If it fails:** nothing is known to fail here.

**Done when:** in the Proxmox shell, `pct config 100 | grep net0` (and
the same for 110, 130, 140, 150, 160, and `qm config 120 | grep net0`)
each include `firewall=1`.

### 8.3 Rules per guest

**Where:** Proxmox UI, each guest's **Firewall** page.

**Before:** step 8.2 is done. For the datacenter-level switch, read the
warning below the table **first**.

**Do:** for each guest, add its rules under *guest* > **Firewall** >
**Add** (Direction `in`, Action `ACCEPT`, Protocol `tcp`), then under
*guest* > **Firewall** > **Options** set **Firewall** to **Yes** and
**Input Policy** to **DROP**.

| Guest | Allow | From (Source) |
|---|---|---|
| CT 100 database | port `5432` | `tradingapp_app` |
| CT 110 app | port `3000` | `tradingapp_proxy` (without step 7: `lan`) |
| CT 110 app | port `4000` | `prometheus` (only with step 9) |
| VM 120 MT5 | ports `9100-9101` | `tradingapp_app` |
| CT 130 IB Gateway | port `4002` | `tradingapp_app` |
| CT 130 Client Portal Gateway | port `5000` | `tradingapp_app`, and `admin` |
| CT 140 proxy | ports `80`, `443` | anywhere (leave Source empty) |
| CT 140 proxy | port `81` | `admin` |
| CT 150 Prometheus | port `9090` | `grafana`, and `admin` |
| CT 160 Grafana | port `3000` | `admin` (or `lan`) |
| every guest | port `22` | `lan`, if you use SSH |

The Proxmox console keeps working with every guest's firewall on: it does
not go over the guest's network.

The datacenter-level switch (**Datacenter > Firewall > Options >
Firewall**) must also be on for any of this to apply. If it is off on your
host, turn it on only after adding rules at **Datacenter > Firewall** that
let `admin` reach the host's web UI (`8006`) and SSH (`22`); turning it on
applies a default-drop policy to the host itself, and a mistake there
needs the physical console to undo. An agent does not turn this switch on:
it asks the operator to ([A.5](#a5-rules-for-an-agent-running-the-install)
rule 6).

**Expected:** from your computer, `https://<domain>` works (without step
7: `http://<app-address>:3000` works), and these say `closed`:

```bash
nc -z -w 3 <db-address> 5432 && echo OPEN || echo closed
nc -z -w 3 <app-address> 4000 && echo OPEN || echo closed
```

With step 7, `nc -z -w 3 <app-address> 3000` also says `closed`. (Windows
PowerShell: `Test-NetConnection <db-address> -Port 5432` reports
`TcpTestSucceeded : False`.)

**If it fails:**
- *A port says `OPEN`:* that guest's firewall is off (8.2, or its
  **Options**), the datacenter switch is off, or the rule's source is too
  wide.
- *The app stops working:* a rule the app needs is missing. In the CT 110
  console, `./tradingapp.sh doctor` shows which side it cannot reach.

**Done when:** the app works from your computer, and the broker ports are
closed to it. To check the broker ports, in the CT 110 console run

```bash
cd /opt/tradingapp && runuser -u tradingapp -- ./tradingapp.sh doctor
```

and read `=== Links to brokers on the LAN ===`. It lists each MT5 sidecar
and IB Gateway the app connects to, says whether the link is encrypted
and reachable from the app server, and prints one line per port, such as

```bash
nc -z -w 3 <ib-address> 4002 && echo OPEN || echo closed
```

Run each printed line on your computer. Each must say `closed`. IB
Gateway's API has no TLS, so this rule is the only thing that keeps other
machines off port `4002`.

> The broker service (port 8000) and Redis are not published beyond the app
> server's own loopback, so they need no rule.

---

## 9. Monitoring (CT 150 and CT 160)

Optional ([Decisions, question 6](#decisions-to-make-first)). Prometheus
collects the backend's metrics and evaluates the alert rules shipped with the
app; Grafana shows the dashboard.

### 9.1 Prometheus (CT 150)

**Where:** Proxmox shell, then the CT 150 console.

**Before:** `pct status 150` says the container does not exist,
`<prometheus-address>` is on the values sheet, and port 4000 on CT 110
allows `prometheus` (step 8.3).

**Do:** [run the **Prometheus** script](#running-a-community-script). In
Advanced Install: ID `150`, hostname `prometheus`, IPv4
`<prometheus-address>` with gateway `<gateway>`, disk `16` GB.

In the CT 150 console, fetch the alert rules and open the configuration:

```bash
curl -fsSL https://raw.githubusercontent.com/41agent41/tradingapp/master/ops/prometheus/alerts.yml \
  -o /etc/prometheus/alerts.yml
nano /etc/prometheus/prometheus.yml
```

Add to `prometheus.yml` (keep what is there; `rule_files` is a top-level
key, the job goes under the existing `scrape_configs:`):

```yaml
rule_files:
  - /etc/prometheus/alerts.yml

scrape_configs:
  - job_name: tradingapp-backend
    metrics_path: /metrics
    static_configs:
      - targets: ['<app-address>:4000']
```

Save, exit, and apply it:

```bash
promtool check config /etc/prometheus/prometheus.yml
systemctl restart prometheus
```

**Expected:** `promtool` prints `SUCCESS` for the file and for the rules.

**If it fails:**
- *`promtool` reports a YAML error:* the file has two `scrape_configs:` or
  two `rule_files:` keys, or the indentation is off. There must be one of
  each.
- *The target is down:* the firewall rule for port 4000 is missing (step
  8.3), or the address is wrong.

**Done when:** `http://<prometheus-address>:9090/targets` shows
`tradingapp-backend` as **UP**.

### 9.2 Grafana (CT 160)

**Where:** Proxmox shell, then your computer, in a browser.

**Before:** step 9.1 is done, `pct status 160` says the container does
not exist, and `<grafana-address>` is on the values sheet.

**Do:** [run the **Grafana** script](#running-a-community-script). In
Advanced Install: ID `160`, hostname `grafana`, IPv4 `<grafana-address>`
with gateway `<gateway>`. Then:
1. Open `http://<grafana-address>:3000` and sign in (`admin` / `admin`,
   then change it).
2. **Connections > Data sources > Add > Prometheus**, URL
   `http://<prometheus-address>:9090`, **Save & test**.
3. **Dashboards > New > Import**, upload
   [`ops/grafana/tradingapp-dashboard.json`](../ops/grafana/tradingapp-dashboard.json)
   and pick the Prometheus data source.

**Expected:** **Save & test** reports that the data source works, and the
dashboard's panels show data.

**If it fails:** *the data source test fails:* Grafana cannot reach
Prometheus on port 9090. CT 150's firewall must allow port `9090` from
`grafana` (step 8.3).

**Done when:** the TradingApp dashboard shows the backend's request rate.

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

**Where:** Proxmox UI, **Datacenter > Backup**.

**Before:** a backup storage exists (`pvesm status` in the Proxmox shell
lists one with content `backup`), ideally a Proxmox Backup Server or a
share off this host.

**Do:** press **Add**:
- **Selection**: 100, 110, 130 and 120 (and 140 to 160 if you built them)
- **Storage**: the backup storage
- **Schedule**: daily, outside market hours
- **Mode**: **Snapshot**
- **Notification**: on failure

Then select the job and press **Run now** once.

**Expected:** the task log ends with `TASK OK`.

**If it fails:** the task log names the guest and the cause, most often a
full backup storage.

**Done when:** each selected guest shows a backup under *guest* >
**Backup**.

A backup of CT 100 restores the server, but its data only as of a power
cut. The nightly dumps from step 1.5 are the clean copy of the data; keep
both.

### 10.2 What the backups do not hold

Nothing to do here but check three things:

- **The encryption key** (step 2.4). Keep it in a password manager. Without
  it a restored database opens everything except the stored secrets.
- **Broker logins** in `/opt/ib-gateway/.env` on CT 130 and
  `/etc/mt5-sidecar/` on VM 120 are in the guest backups, but keep your own
  record of them too.
- Docker images, Redis and the app's internal secrets are rebuilt or
  regenerated; nothing to keep.

### 10.3 Before an upgrade

**Where:** Proxmox UI.

**Before:** you are about to upgrade the app
([OPERATIONS.md § Upgrade](OPERATIONS.md#upgrade-in-place)).

**Do:** snapshot the app and the database together, since an upgrade can
change the database: CT 110 and CT 100 > **Snapshots** > **Take
Snapshot**, with the same name on both.

**Expected:** both snapshots are listed.

**If it fails:** *"snapshot feature is not available":* the guest's disk
is on storage without snapshots. Run a backup of both guests instead
(step 10.1, **Run now**).

**Done when:** both guests show the snapshot. Roll both back to the same
point if the upgrade goes wrong, and delete old snapshots: they take real
space on LVM-thin and ZFS.

### 10.4 Boot order

The community scripts set every guest to start at boot.

**Where:** Proxmox UI, each guest's **Options**.

**Before:** every server you will build exists.

**Do:** set *guest* > **Options** > **Start/Shutdown order**:

| Guest | Order | Startup delay |
|---|---|---|
| CT 100 database | 1 | 30 |
| VM 120 MT5, CT 130 IB Gateway | 2 | 30 |
| CT 110 app | 3 | |
| CT 140 proxy, CT 150, CT 160 | 4 | |

Then reboot the Proxmox host, outside market hours. An agent asks the
operator before rebooting the host.

**Expected:** after the reboot every guest is running.

**If it fails:** *a guest did not start:* its **Start at boot** option is
off. Turn it on.

**Done when:** after the reboot, the app signs in and every connection
shows connected.

The backend waits for its database however long it takes, so a slow
database start delays the app but does not break it. Inside CT 110 the
installer's service starts the stack.

---

## 11. Verify

**Where:** CT 110 console.

**Before:** every step you chose in
[Decisions to make first](#decisions-to-make-first) is done.

**Do:**

```bash
cd /opt/tradingapp
runuser -u tradingapp -- ./tradingapp.sh status
runuser -u tradingapp -- ./tradingapp.sh test
runuser -u tradingapp -- ./tradingapp.sh doctor
bash /root/install.sh verify
```

**Expected:** `status` shows every container up. `test` passes for the
frontend, backend, broker service and readiness. `doctor` shows
`state: ready`, each broker connection as `(connected)`, and no extra
lines in `.env`. `verify` ends with `result: PASS`.

**If it fails:** each `CHECK ... FAIL` line of `verify` is in
[A.3](#a3-checks) with its fix. For `doctor`, see
[OPERATIONS.md § Troubleshooting](OPERATIONS.md#troubleshooting).

**Done when:** every box below is ticked:

- [ ] `doctor` shows `state: ready`, and `.env` holds only the seven
      database and key lines
- [ ] Encryption key stored off the host
- [ ] `/opt/tradingapp/site-values.md` is filled in, with no secret in it
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
| env | exit 2 naming a key; exit 3 | supply the key; for 3, [A.5](#a5-rules-for-an-agent-running-the-install) rule 1 |
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

**Where:** Proxmox UI and shell, then the new CT 110's console. A person
enters the saved key.

**Before:** CT 100 is running and its database is intact, and you have the
encryption key from your password manager.

**Do:**
1. Remove the old CT 110, or stop it and give the new one another ID.
2. Do steps 2.1 and 2.2 again. Then add a fourth line to
   `/etc/tradingapp/install.answers` in the new container's console,
   `SETTINGS_ENCRYPTION_KEY=` followed by the saved key (with
   `nano /etc/tradingapp/install.answers`).
3. Do steps 2.3 and 2.5.
4. If the new container has another address: change the line in
   `pg_hba.conf` (step 1.4), the `tradingapp_app` alias (step 8.1), and
   the values sheet.

**Expected:** step 2.3 ends with `result: PASS`. The backend adopts the
existing tables, applies only pending migrations, checks the key and comes
up configured: no setup screen, and your login, brokers and settings are
already there.

**If it fails:** *it stops with `key_mismatch`:* the key is wrong; see
[OPERATIONS.md § Lost encryption key](OPERATIONS.md#lost-encryption-key).

**Done when:** the app signs in with your existing password and every
connection shows connected.

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

8. **Follow the six parts of each step.** Check **Before**, run **Do** as
   written, compare with **Expected**, and do not go on until **Done when**
   holds. A step marked "a person does this step" is the operator's: say
   what is needed and wait. Every value comes from the
   [values sheet](#values-sheet), which the operator fills in; ask for a
   missing one, never guess it.

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

**Where:** Proxmox shell, then the CT 110 console.

**Before:** `pct status 110` says the container does not exist, and
`<app-address>` and `<gateway>` are chosen.

**Do:**
1. Create CT 110 as in [step 2.1](#21-create-the-container), with a `100`
   GB disk and `12288` MiB of RAM.
2. In its console, with no answers to give:

   ```bash
   mkdir -p -m 700 /etc/tradingapp
   install -m 600 /dev/null /etc/tradingapp/install.answers
   curl -fsSL https://raw.githubusercontent.com/41agent41/tradingapp/master/install/install.sh -o /root/install.sh
   bash /root/install.sh all
   ```

**Expected:** the last lines include `result: PASS`.

**If it fails:** as in [step 2.3](#23-run-the-installer).

**Done when:** `tail -1 /var/log/tradingapp-install/report.txt` prints
`result: PASS`. Continue with
[step 2.4](#24-save-the-encryption-key), then steps 3 to 6.

Without `INSTALL_DB_MODE=external`, the installer runs TimescaleDB as a
container next to the app and generates its password. Its data lives in
the `tradingapp_pgdata` Docker volume (Docker shows it as
`tradingapp_tradingapp_pgdata`).

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
  support and sends `X-Forwarded-Proto`; set `TRUST_PROXY` (and
  `CORS_ORIGINS` if needed) as in step 7.3 (for a proxy on the app server itself,
  `TRUST_PROXY` is `172.20.0.1`, the Docker network's gateway). Docker's published ports bypass `ufw`, so
  close 3000 and 4000 at a firewall Docker does not control.
