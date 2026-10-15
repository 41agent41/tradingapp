# Agent Install Runbook

**What this is:** steps an AI agent (or a person) can follow top to bottom to
install TradingApp in **paper mode**. It runs unattended except where an
operator's credential or a GUI login is needed. It drives the scripts in
[`install/`](install/) and ends with a machine-checked report.

**What it is not:** a replacement for the guides behind it. They explain why
each step exists: [`PROXMOX_DEPLOYMENT.md`](PROXMOX_DEPLOYMENT.md),
[`DEPLOYMENT.md`](DEPLOYMENT.md) and
[`mt5_sidecar/README.md`](mt5_sidecar/README.md). When a step fails, the
section it links to has the fix.

| Script | Runs on | Does |
|---|---|---|
| [`install/proxmox-create-ct.sh`](install/proxmox-create-ct.sh) | Proxmox VE host | Creates the app LXC with the Docker-in-LXC features (Proxmox guide §4.1, Appendix A) |
| [`install/install.sh`](install/install.sh) | App host (LXC, VM, bare metal) | Packages, Docker, deploy user, checkout, then `tradingapp.sh install` as that user, verification, boot unit |
| [`install/mt5-sidecar-wine.sh`](install/mt5-sidecar-wine.sh) | MT5 host (Linux VM or privileged LXC) | Wine, Windows Python, MT5 terminal, sidecar service, check |

`install.sh` does what needs root. Everything about the app itself is done by
`./tradingapp.sh install`, run as the deploy user, so an unattended install
and a hand install end up the same. Brokers are not part of the install. They
are added in the app under Settings > Connections, which tests each one
(Phase B).

---

## 0. Rules for the agent

Each rule exists because breaking it can lose money or lock the operator out.

1. **Paper only.** Never turn on `LIVE_TRADING_ENABLED` or
   `SYSTEMATIC_EXECUTION_ENABLED` (in the answers, `.env` or the Settings
   page). Never add a broker connection marked live, use an IB live port
   (4001 or 7496), or set `MT5_ALLOW_REAL=true` on a sidecar. `install.sh`
   refuses the two switches with exit code 3; do not work around a refusal.
   Going live is the operator's decision, made by hand
   ([`DEPLOYMENT.md` § Enabling live trading](DEPLOYMENT.md#enabling-live-trading)).
2. **Never invent an operator input.** Broker logins and passwords, API keys,
   Telegram tokens, heartbeat URLs, IP plans and an external database's
   password come from the operator (§1). If one is missing, ask for it, or
   skip the optional part that needs it and say so. The scripts generate the
   internal secrets: the encryption key, the bundled database's password, the
   broker service token and the Redis password. Do not choose these yourself.
   The MT5 sidecar secret is random; generate it with `openssl` (B2), never
   type one. The login password is the operator's: they choose it in the app
   on first visit (I3).
3. **Never print a secret** into chat, a ticket, a commit or a log you keep.
   Say where it is instead (for example `/opt/tradingapp/.env`, key
   `SETTINGS_ENCRYPTION_KEY`). The first-run setup code counts as a secret:
   tell the operator how to read it, never the code.
4. **Stop on a FAIL.** Every step has a pass condition. On a failure, run the
   step's diagnosis, fix only what the linked section describes, and re-run
   the step. If it still fails, stop and report (§9). Do not skip ahead: later
   steps assume earlier ones held.
5. **Re-running is safe; editing by hand is not.** Every phase checks before
   it changes anything. Do not edit `.env` unless the operator asks. App
   settings belong on the Settings page, or in the answers file followed by
   `install.sh deploy`.
6. **Do not open ports to the internet** or change the Proxmox firewall
   unless the operator asks. §10 of the Proxmox guide is theirs to apply.
7. **Never clear stored secrets on your own.** `./tradingapp.sh forget-secrets`
   and `clean --include-database` destroy data. Run them only when the
   operator says so.
8. **Exit codes mean something.** `0` done. `1` a step failed (read the
   output). `2` an input is missing or invalid (ask the operator). `3`
   refused for safety (stop and report). `4` (MT5 script only) the operator
   must act on the terminal's screen.

---

## 1. Inputs

Collect these before you start. "Agent" means the agent can decide or detect
it. Everything else comes from the operator.

| Input | Needed for | From | Notes |
|---|---|---|---|
| Target: Proxmox host, or an existing Ubuntu 22.04+/Debian 12+ host | everything | operator | Root SSH (or `pct exec`) to it |
| App host IP (CIDR), gateway, bridge, CT id, storage | Proxmox only | operator | Must not be in `172.20.0.0/16` (the stack's Docker network) |
| Database: bundled or external | `INSTALL_DB_MODE` | operator, default **bundled** | External needs host, password, and the Proxmox guide §5.3 done first |
| Saved encryption key | a rebuild that keeps an existing database | operator | From `./tradingapp.sh backup-key` on the old host (§8.2) |
| Browser login password | the app's first-run screen | operator | Chosen in the browser after install (I3) |
| IB Gateway host, paper account | IB, optional | operator | Gateway install needs a one-time GUI login (Proxmox guide §6) |
| MT5 **demo** account(s): login, password, server, broker server time zone | MT5, optional | operator | One terminal and sidecar per account |
| MT5 host: a Linux VM or privileged LXC, or a Windows VM | MT5, optional | operator | Not the app container (it is unprivileged) |
| Alpaca paper key and secret, OANDA practice token and account id | cloud brokers, optional | operator | Entered in the app, not the answers |
| Telegram bot token and chat id | alerts, recommended | operator | Created with @BotFather |
| Heartbeat URL (and `/fail` URL) on a monitor **off this host** | dead-man's switch, recommended | operator | For example a healthchecks.io check, period 1 min, grace 5 min |

With none of the optional inputs, the result is a working app with no broker
connected. Charts and orders need a broker; everything else runs.

---

## 2. Phase P: Proxmox container (skip on an existing host)

**P1. Check the hypervisor.** On the Proxmox host:

```bash
pveversion
pvesm status
chronyc tracking | grep -E 'Leap status|System time'
```

**Pass:** Proxmox VE 8 or later; the chosen storage is listed; leap status
`Normal`. Containers take their clock from the host, so a host without
working NTP is a FAIL ([§3.3](PROXMOX_DEPLOYMENT.md#33-time-synchronisation-not-optional-and-host-only)).

**P2. Create the app container.** Fetch the scripts onto the host and run:

```bash
mkdir -p /root/tradingapp-install && cd /root/tradingapp-install
for f in proxmox-create-ct.sh install.sh install.answers.example mt5-sidecar-wine.sh; do
  curl -fsSLO "https://raw.githubusercontent.com/41agent41/tradingapp/master/install/$f"
done
chmod +x *.sh

# Single container with the bundled database (Appendix A sizing):
./proxmox-create-ct.sh --ctid 110 --ip 10.7.3.20/24 --gw 10.7.3.1 \
  --storage local-lvm --bundled-db
# With an external database (§4.1 sizing): drop --bundled-db.
```

**Pass:** exit 0 and `container 110 is up ... and resolves names`. The script
adds `fuse=1` itself on ZFS storage.
**If it fails:** exit 1 on an existing container names the missing feature
and the `pct set` that fixes it. For anything else, see
[§15](PROXMOX_DEPLOYMENT.md#15-proxmox-specific-troubleshooting).

**P3. Hand the installer to the container.**

```bash
pct exec 110 -- mkdir -p -m 700 /etc/tradingapp
pct push 110 install.sh /root/install.sh --perms 0755
pct push 110 install.answers.example /etc/tradingapp/install.answers --perms 0600
```

From here every command runs **inside** the app host, as root
(`pct enter 110`, or `pct exec 110 -- <command>`).

---

## 3. Phase A: Answers file

**A1. Fill in `/etc/tradingapp/install.answers`.** On an existing host, fetch
`install.sh` and the example the same way as P2, then:

```bash
install -d -m 700 /etc/tradingapp
install -m 600 install.answers.example /etc/tradingapp/install.answers
```

The example documents every key. A fresh install with the bundled database
needs nothing in it at all. There are three kinds of key:

- `INSTALL_*` configure the installer (directory, user, repository, branch,
  database mode, timeout).
- `POSTGRES_*` and `SETTINGS_ENCRYPTION_KEY` go to `.env`. That is all `.env`
  holds.
- Anything else is an app setting. It is stored in the app's database after
  deploy, and not left in `.env`.

Add only what applies:

- External database: `INSTALL_DB_MODE=external`, `POSTGRES_HOST`,
  `POSTGRES_PASSWORD`, and `POSTGRES_SSL` if it needs TLS.
- A rebuild that keeps an existing database: also `SETTINGS_ENCRYPTION_KEY`,
  the saved key (§8.2). Leave it out on a fresh install; the installer makes
  one.
- Alerts, if the operator gave them: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
  `HEARTBEAT_URL`, `HEARTBEAT_FAIL_URL`.

Do not put broker keys here. `IB_HOST`, `BROKER_CONNECTIONS`, `OANDA_*`,
`ALPACA_*` and `MT5_*` are refused with exit 2. Brokers are added in Phase B.

**Pass:** `stat -c %a /etc/tradingapp/install.answers` prints `600`, and the
file holds only values the operator gave you or the defaults.

---

## 4. Phase I: Install

**I1. Run every phase.**

```bash
/root/install.sh all
```

The phases, in order:

| Phase | Does |
|---|---|
| preflight | OS, root, packages, disk, network, the `172.20.0.0/16` check |
| docker | Installs Docker (fuse-overlayfs first on ZFS); `hello-world` gate |
| user | Creates the deploy user and adds it to the docker group |
| repo | Clones or fast-forwards the repository |
| env | `tradingapp.sh install --env-only` as the deploy user: writes `.env` |
| schema | Nothing. The backend migrates its database at startup |
| deploy | `tradingapp.sh install` as the deploy user: builds, starts, waits until ready, stores app settings from the answers |
| verify | Runs the acceptance checks and writes the report |
| service | Installs the systemd unit that starts the stack on boot |

The first run takes several minutes (images build). It prints `[install]`
lines per phase and ends with the verification table. The full log is
`/var/log/tradingapp-install/install.log`.

**Pass:** exit 0, and the last lines read `result: PASS` and
`done: preflight docker user repo env schema deploy verify service`.

**If it fails,** the failed phase is the last `[install]` line before
`ERROR`. Fix the cause, then re-run from that phase (for example
`/root/install.sh deploy verify service`).

| Phase | Typical failure | Where the fix is |
|---|---|---|
| preflight | address in 172.20.0.0/16; disk; cannot reach GitHub | Proxmox guide §2; network |
| docker | daemon will not start; `hello-world` fails; `vfs` driver | Proxmox guide §4.2, §15 Docker-in-LXC (`nesting`, `keyctl`, `fuse` on ZFS) |
| repo | local changes or a diverged checkout | someone edited `/opt/tradingapp`; ask the operator before discarding |
| env | exit 2 naming a key; exit 3 | ask the operator for the key; for 3, see §0 rule 1 |
| deploy | `waiting_for_database` until the timeout (external) | Proxmox guide §5.3 to §5.4 (`pg_hba.conf`, password, extension) |
| deploy | `migration_failed` | the detail names the migration; Proxmox guide §15 Application-level |
| deploy | `key_mismatch` | `SETTINGS_ENCRYPTION_KEY` is not the one this database was sealed with; ask the operator for the saved key (§8.2) |
| deploy | `refusing to start: <reason>` | the reason names the key; [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) |
| verify | any `CHECK ... FAIL` | table in I2 |

**I2. Read the report.** `cat /var/log/tradingapp-install/report.txt`. Each
check is one line, `CHECK <id> PASS|FAIL|SKIP <detail>`:

| Check | Proves | On FAIL |
|---|---|---|
| V1 | every container is running | `./tradingapp.sh status`; `./tradingapp.sh logs` |
| V2 | `/api/health` reports healthy | the detail names the failing side |
| V3 | `/api/database/health`: the database is reachable from the backend | external: Proxmox guide §5.4 |
| V4 | the broker service answers `/health` | `./tradingapp.sh logs` |
| V5 | the frontend serves | `install.sh deploy` |
| V6 | the API refuses an unauthenticated call (401) | someone changed the auth setup; `install.sh deploy` |
| V7 | the broker service refuses calls without its token | "token not found": the internal secrets volume is missing; `install.sh deploy` |
| V8 | the broker service is on loopback only | someone changed `docker-compose.yml` |
| V9 | `/api/health/ready` is ready: schema up to date, encryption key matches | the detail gives the state; see the deploy rows in I1 |
| V10 | no startup refusals in the backend log | the log line names the key |
| V11 | paper only, in `.env` and in the app's settings | §0 rule 1: stop and report |
| V12 | `.env` is mode 600 and owned by the deploy user | `install.sh env` |
| V13 | the broker connections the app has; any that exist are paper | a connection not in paper mode: §0 rule 1, stop and report. No answer: see V4 and V7 |
| V16 | the dead-man's switch is pinging | wait a minute and re-run `install.sh verify` |

SKIP is not a failure. It means the optional part is not set up. V13 is SKIP
on a fresh install, because no broker has been added yet. V16 is SKIP until a
heartbeat URL is set. There is no V14 or V15: the app checks every broker
connection itself (Phase B).

To see the same state by hand, as the deploy user:

```bash
cd /opt/tradingapp && runuser -u tradingapp -- ./tradingapp.sh doctor
```

**I3. Confirm in a browser (operator).** Tell the operator to open
`http://<app host IP>:3000`. A new install asks for a setup code, then a new
password. Tell them how to read the code; do not read it to them:

```bash
cd /opt/tradingapp && runuser -u tradingapp -- ./tradingapp.sh setup-code
```

**Pass:** the operator confirms the dashboard loads after login. A rebuild
that kept its database has no setup screen: the operator signs in with their
existing password.

**I4. Snapshot (Proxmox).** On the host:
`pct snapshot 110 clean-install --description "install.sh all: PASS"`.
**Pass:** `pct listsnapshot 110` shows it. Directory storage cannot snapshot;
note that in the report rather than failing.

**I5. Save the encryption key (operator).** Tell the operator to run
`./tradingapp.sh backup-key` as the deploy user in `/opt/tradingapp` and store
the key in their password manager. Do not run it yourself and do not copy
the output anywhere. **Pass:** the operator confirms it is stored.

---

## 5. Phase B: Brokers (each optional)

Brokers are added in the app, not by a script. For each one:

1. Prepare the broker's host if it has one (B1, B2).
2. Add the connection: sign in, open **Settings > Connections**, choose the
   broker, mark it **paper**, enter its details, and save.
3. The app tests the connection as it saves and shows the result. It keeps
   checking it on a timer after that.

The operator does step 2 in their browser, since it needs their login and
their broker credentials. An agent with browser access to the app may do it
if the operator asks and supplies the values. Add one broker at a time and
check it before the next, so a failure has one cause.

**Pass for every broker:** the connection shows as connected on
Settings > Connections, and `/root/install.sh verify` lists it under V13 as
paper.

### B1. IB Gateway

The Gateway is a logged-in GUI session, set up once over VNC
([Proxmox guide §6](PROXMOX_DEPLOYMENT.md#6-create-the-ib-gateway-container)).

1. The agent creates the container and installs the packages (Proxmox guide
   §6.1, §6.2).
2. The **operator** logs in to the **paper** account and sets the API options
   (§6.3), because that needs their IB credentials and a screen.
3. The agent sets up the IBC service and firewall (§6.4, §6.5).
4. Add an IB connection in the app: host `<gateway IP>`, port `4002`.

**If the test fails:** the gateway is not logged in, the app host is not in
its Trusted IPs, or the firewall blocks 4002 (Proxmox guide §6.3 to §6.5).

### B2. MT5 demo account(s)

One terminal, one sidecar and one port per account. Use a separate Linux VM
or privileged LXC (Wine), or a Windows VM. Never the app container.

1. **Install the sidecar on the MT5 host (Linux, Wine).** Copy
   `mt5-sidecar-wine.sh` there. Generate the secret on that host and pass it,
   and the demo login, through the environment, not the command line. Ask the
   operator for the demo login, password, server and the broker server's time
   zone:

   ```bash
   export MT5_BRIDGE_SECRET="$(openssl rand -hex 32)"
   export MT5_LOGIN=... MT5_PASSWORD=... MT5_SERVER=...     # from the operator
   ./mt5-sidecar-wine.sh install --instance broker-a --port 9100 --server-tz Europe/Athens
   unset MT5_BRIDGE_SECRET MT5_PASSWORD
   ```

   The script saves the secret as `MT5_BRIDGE_SECRET` in
   `/etc/mt5-sidecar/broker-a.env` and sets `MT5_ALLOW_REAL=false`. A re-run
   without `MT5_BRIDGE_SECRET` keeps the saved one.

   Use `--installer-url` for the broker's own MT5 installer if the operator
   names one. **Pass:** exit 0 and `check: PASS (demo account ...)`.

   **Exit 4** means the operator must act on the terminal. Run
   `./mt5-sidecar-wine.sh vnc --instance broker-a`. Tell the operator to
   tunnel (`ssh -L 5900:localhost:5900 root@<mt5 host>`), connect a VNC
   viewer to `localhost:5900`, log in if needed, and switch **Algo Trading**
   on. Then run `./mt5-sidecar-wine.sh check --instance broker-a`.

   **Windows instead:** follow
   [`mt5_sidecar/README.md` § Windows](mt5_sidecar/README.md#windows), with
   `MT5_BRIDGE_SECRET` set to a value from `openssl rand -hex 32` and
   `MT5_ALLOW_REAL=false`.

2. **Firewall the sidecar** to the app host only (Windows Firewall, `ufw`, or
   the Proxmox firewall). Anything that reaches the port with the secret can
   trade the account.

3. **Add the MT5 connection in the app.** URL `http://<mt5 host>:9100`, and
   the same secret as on the sidecar. The operator reads the secret from
   `/etc/mt5-sidecar/broker-a.env` on the MT5 host (or `sidecar.env` on
   Windows) and pastes it into the form. Do not copy it into chat.

4. **Check the quote clock.** The check in
   [`mt5_sidecar/README.md` § Checking it](mt5_sidecar/README.md#checking-it)
   confirms `--server-tz`: while the market is open, a quote's time is within
   seconds of `date -u +%s`.

A second account repeats 1 to 4 with its own instance name, port, secret and
connection.

**If the test fails:** check the URL and port, that the secret matches on
both sides, and the firewall rule.

### B3. Alpaca paper and OANDA practice

Credentials only, no host. Add the connection in the app, marked paper:

- **Alpaca**: the paper API key and secret.
- **OANDA**: the practice API token and account id.

**If the test fails:** the key is wrong, or it belongs to a live account.

---

## 6. Phase S: Safety nets

Recommended before anything runs unattended. Required before the paper
runbook's execution steps.

1. Set the Telegram bot token and chat id, and the heartbeat and `/fail`
   URLs (all from the operator). Either enter them on Settings > Alerts and
   safety, or add them to the answers and run `/root/install.sh deploy`. Keep
   `KILL_SWITCH_ACTION=notify`.
2. Wait two minutes, then run `/root/install.sh verify`.

**Pass:** V16 PASS, and the operator sees the heartbeat check turn green on
their monitor. The deliberate failure tests (stopping the backend and being
paged) are in
[`PAPER_DEPLOYMENT_RUNBOOK.md` step 22](PAPER_DEPLOYMENT_RUNBOOK.md#22-confirm-the-alerting-path).
They page the operator, so agree a time with them first.

The Getting started checklist on the Settings page shows what is still open:
login password, a broker connection, instruments chosen for data collection,
and alerts.

---

## 7. Phase R: Reboot test

The boot unit only matters if it works after a reboot. In an LXC, every host
kernel update is one.

1. Outside market hours, with the operator's agreement, run `reboot`
   (VM or bare metal) or `pct reboot 110` (on the Proxmox host).
2. When the host is back, run `/root/install.sh verify`.

**Pass:** `result: PASS` with no other action. On a Proxmox host with
separate guests, set the boot order first
([§13](PROXMOX_DEPLOYMENT.md#13-boot-order-and-auto-start)).

---

## 8. Upgrades, changes and rebuilds

### 8.1 Upgrade

Same script, same answers:

```bash
/root/install.sh repo env deploy verify
```

`repo` fast-forwards to `INSTALL_REF` and refuses if someone changed tracked
files. `env` only adds what is missing; it never replaces the database
password or the encryption key, and it removes lines nothing reads any more
(after a backup to `.env.bak.<timestamp>`). `deploy` rebuilds, and the backend
applies any new migrations before it reports ready. Snapshot first on Proxmox
(`pct snapshot 110 pre-upgrade-$(date +%F)`, and the database container too).
Roll back with `pct rollback 110 <name>`.

### 8.2 Rebuild, keeping the database

Use this when the app host is lost or replaced and the database lives
elsewhere (Proxmox guide §5). The connections, settings and login all live in
the database, so the new host comes up configured.

1. Get the saved encryption key from the operator. It came from
   `./tradingapp.sh backup-key` on the old host. Without it the stored
   secrets cannot be read.
2. Create the new host (Phase P), or use the existing one.
3. Answers: `INSTALL_DB_MODE=external`, `POSTGRES_HOST`, `POSTGRES_PASSWORD`,
   and `SETTINGS_ENCRYPTION_KEY` set to the saved key.
4. Run `/root/install.sh all`.

**Pass:** `result: PASS`, V9 says the key matches, and V13 lists the existing
connections. There is no setup screen in I3.

**If deploy stops on `key_mismatch`:** the key is wrong. Ask the operator for
the right one. If it is lost for good, only the operator can decide to run
`./tradingapp.sh forget-secrets` (§0 rule 7); connections and settings stay,
and their secrets are entered again.

A host that runs the bundled database cannot be switched to an external one
by the installer: that is a data move. See the Proxmox guide §5.5.

---

## 9. Report to the operator

When done, or when stopped, send:

1. The outcome: `PASS`, or the phase and step that stopped, with the exit
   code.
2. The contents of `/var/log/tradingapp-install/report.txt`. It holds no
   secrets.
3. The URL, and that the first visit asks for a setup code
   (`./tradingapp.sh setup-code` in `/opt/tradingapp`) and then a password.
4. A reminder to save the encryption key (I5), if not yet confirmed.
5. What was skipped and the input it needs (for example "MT5: no demo login
   given").
6. Anything only the operator can do next: add broker connections, a VNC
   login, the TLS front door
   ([§10](PROXMOX_DEPLOYMENT.md#10-reverse-proxy-tls-and-firewalling)),
   firewall rules, backups
   ([§12](PROXMOX_DEPLOYMENT.md#12-backups-and-snapshots)).

---

## 10. After the install

The install ends at a verified, paper-mode system with no strategies running.
What comes next is the operator's evaluation, not part of installing:

- [`PAPER_DEPLOYMENT_RUNBOOK.md`](PAPER_DEPLOYMENT_RUNBOOK.md) takes two MT5
  demo accounts through the fleet view, signal-only running, paper execution
  and a week of notify-only observation. V9 and V10 cover its schema and
  startup-guard steps, and Phase B2 covers its sidecar setup.
- Turning on `SYSTEMATIC_ENABLED`, `EXECUTIONS_SYNC_ENABLED` and later
  `SYSTEMATIC_EXECUTION_ENABLED` happens there, on paper, one at a time.
- Live trading is out of scope for any agent following this runbook
  ([§0 rule 1](#0-rules-for-the-agent)).
