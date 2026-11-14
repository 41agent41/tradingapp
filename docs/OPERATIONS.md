# Running TradingApp

How to run an installed TradingApp: the management commands, where settings
live, upgrades and rebuilds, going live, data collection, monitoring,
backups and troubleshooting. Installing is in [INSTALL.md](INSTALL.md).

Every command here runs on the app server, as the deploy user, in the
checkout: `./tradingapp.sh COMMAND`. On a server built with
[INSTALL.md](INSTALL.md), that is the `tradingapp` user in `/opt/tradingapp`:
in CT 110's Console, `su - tradingapp`, then `cd /opt/tradingapp`. This guide
calls that the **app shell**.

**How procedures are written.** Each procedure has the same six parts as an
install step: **Where**, **Before**, **Do**, **Expected**, **If it fails**
and **Done when** ([INSTALL.md § How each step is written](INSTALL.md#how-each-step-is-written)).
A failure that is not listed means stop and report, with the output of
[Reporting a problem](#reporting-a-problem). Placeholders in angle brackets,
such as `<db-address>`, are the ones on the
[values sheet](INSTALL.md#values-sheet); this site's values are in
`/opt/tradingapp/site-values.md`. Addresses of the app itself are written as
`127.0.0.1`, because the commands run on the app server.

**Calling the API from the shell.** Some checks need an API token (Settings
> Security). Put it in the shell once, without it showing on screen:

```bash
read -rsp 'API token: ' API_TOKEN; echo
```

The commands below then use `$API_TOKEN`. `unset API_TOKEN` when you are
done.

## Contents

1. [Commands](#commands)
2. [Where things live](#where-things-live)
3. [Sign-in and API tokens](#sign-in-and-api-tokens)
4. [Upgrade, rebuild and move](#upgrade-rebuild-and-move)
5. [Going live](#going-live)
6. [Data collection and retention](#data-collection-and-retention)
7. [Executions (fills) sync](#executions-fills-sync)
8. [Monitoring](#monitoring)
9. [Backups and restore](#backups-and-restore)
10. [Troubleshooting](#troubleshooting)

---

## Commands

| Command | What it does |
|---|---|
| `install` | Docker, `.env`, database and stack in one step. Safe to re-run: it is also how you upgrade and repair. |
| `deploy` | Build and start, then wait until ready. |
| `redeploy` | Rebuild the images from scratch, then deploy. The database is kept. |
| `start`, `stop`, `status` | Start, stop, list the containers. |
| `restart` | Recreate the containers, so a change to `.env` takes effect. |
| `logs [follow]` | Recent logs of every service, or follow them. |
| `setup-code` | The code the first-run screen asks for. |
| `doctor` | Docker, `.env`, containers, the database, schema and key as the backend sees them, broker state, the MT5 and IB Gateway links on the LAN (encrypted or not, and the test that confirms the firewall) and the live recorder. |
| `test` | Check the frontend, backend, broker service and readiness answer. |
| `migrate` | Show the schema state and apply anything pending, without a restart. |
| `settings-import` | Move Settings-page keys from `.env` into the app. |
| `backup-key` | Print `SETTINGS_ENCRYPTION_KEY`, to store off the host. |
| `rotate-internal-secrets` | Replace the broker service token and the Redis password. |
| `forget-secrets` | Clear the secrets sealed with a lost encryption key (type FORGET). |
| `fix` | Stop, deploy and check again. |
| `clean [--include-database]` | Remove containers, images and build cache. Volumes are kept unless `--include-database` is given and you type DELETE. |

Old names still work: `setup` runs `install`, `config` and `env` run
`install --env-only`, `diagnose` runs `doctor`.

Always go through the script rather than a bare `docker compose`: the script
adds `docker-compose.db.yml` when the host runs the bundled database
(`.tradingapp.with-db` marks it), and a bare `docker compose up` would start
the stack without its database. Per-service commands such as
`docker compose logs backend` are fine.

---

## Where things live

| Where | What |
|---|---|
| `.env` (7 keys, mode 600) | `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_SSL`, `SETTINGS_ENCRYPTION_KEY`. Written by `install`. |
| `.env` (optional) | `FRONTEND_PORT`, `BACKEND_PORT`, `BROKER_SERVICE_PORT`; `APP_PASSWORD` or `ORDER_MFA_SECRET` as the way back in; any Settings-page key pinned. |
| `internal_secrets` volume | The broker service token and Redis password, generated on first start, mounted read-only at `/run/tradingapp`. |
| `tradingapp_pgdata` volume | The bundled database's data (Docker names it `tradingapp_tradingapp_pgdata`). |
| Settings > Connections | Broker accounts, their priority, credentials (encrypted), per-account limits and prop-firm rules. |
| Settings > other tabs | Trading, Risk, Alerts and safety, Strategies, Schedulers and data (with the data collection table), Security, Network, History. Stored in the database. |

How settings behave:

- **`.env` wins.** A key set in `.env` overrides the page, which shows it as
  locked. `./tradingapp.sh settings-import` moves such lines into the app
  (after a backup) and restarts the backend. `install` removes lines nothing
  reads any more, and reports broker lines it keeps.
- **`.env` is a ceiling for live trading:** `LIVE_TRADING_ENABLED=false`
  there keeps live off whatever the page says.
- **Each setting says when a change applies:** at once, on the next cycle of
  the loop it drives, or after a restart.
- **The safer direction is easy.** Turning a switch off or tightening a
  limit needs only the login. Turning one on or raising a cap also needs the
  trading token and an MFA code.
- **Every change is audited** on the History tab.
- **Broker lines in `.env`** (`BROKER_CONNECTIONS`, `IB_HOST`,
  `MT5_BRIDGE_URL`, `OANDA_API_TOKEN`, `ALPACA_API_KEY` and the rest) still
  define connections, and for that broker replace the ones added in the app,
  which then show as overridden. Use them only as a break-glass, or for the
  symbol map gap in [INSTALL.md § 4.9](INSTALL.md#49-not-yet-on-the-form-symbol-maps-and-account-info-from).

Settings you are most likely to look for (the page lists every key with its
help text):

| Tab | Keys |
|---|---|
| Trading | `LIVE_TRADING_ENABLED`, `SYSTEMATIC_ENABLED`, `SYSTEMATIC_EXECUTION_ENABLED`, `DEFAULT_BROKER` |
| Risk | `ORDER_MAX_QUANTITY`, `ORDER_MAX_PRICE`, `ORDER_MAX_POSITION`, `CONNECTION_MAX_*`, `PORTFOLIO_MAX_DAILY_LOSS`, `PORTFOLIO_BASE_CURRENCY`, `TRADING_DAY_TIMEZONE` |
| Alerts and safety | `KILL_SWITCH_ACTION` (`notify`, `halt`, `flatten`), `KILL_SWITCH_EQUITY_FLOOR`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `HEARTBEAT_URL`, `HEARTBEAT_FAIL_URL` |
| Strategies | `PROMOTION_*` gate thresholds, `PROMOTION_PAPER_GATE` |
| Schedulers and data | Strategy runner timing, `BROKER_PROBE_INTERVAL_SECONDS`, `BACKFILL_*`, `RECORDER_ENABLED`, `TICK_STREAM_MAXLEN`, `TICK_RETENTION_DAYS`, `EXECUTIONS_SYNC_*`, `REDIS_ENABLED`, `STREAMING_ENABLED`, `NEWS_CALENDAR_*`, the data collection table |
| Security | Login password, API tokens, trading tokens, order MFA, `SESSION_TTL_HOURS`, `COOKIE_SECURE` |
| Network | `CORS_ORIGINS`, `TRUST_PROXY` |
| Connections | Broker priority, `IB_TIMEZONE` |

Per-connection limits: a `CONNECTION_MAX_*__<CONNECTION>` or
`PROP_RULES__<CONNECTION>` line in `.env` wins, then the connection's own
value, then the fleet-wide cap on Settings > Risk.

---

## Sign-in and API tokens

- The browser signs in with the login password and holds an HttpOnly session
  cookie for `SESSION_TTL_HOURS` (default 12). Five wrong passwords from one
  address lock it out for 15 minutes.
- Settings > Security > Signed-in browsers lists each session and signs out
  one browser or all of them. Signing out ends the session on the server, so
  a copied cookie stops working at once. If a browser or laptop is lost, use
  **Sign out everywhere**, then change the password. Signing a browser out
  also closes its open live price streams.
- Live streams follow the same origin rule as the API: a page on another
  site can open one only when its origin is listed in `CORS_ORIGINS`.
- Scripts send `Authorization: Bearer <token>` with an API token from
  Settings > Security. Health checks and signing in and out need none.
  `/metrics` needs none either unless `METRICS_TOKEN` is set, and then it
  needs that token and no other.
- A live stream takes a script's token in the handshake's `auth.token` or
  its `Authorization` header. A token in the URL (`?token=`) is not read,
  because URLs are written to proxy and access logs.
- A request body may be 100 KB of JSON. The Parquet export and the bar
  upload take 25 MB. A larger body is answered with HTTP 413.
- Every answer carries security headers: the backend's from `helmet`, the
  pages' from `frontend/securityHeaders.js`, including a Content Security
  Policy that lets a page load only what the app itself serves and stops
  another site framing it.
- Ports 3000 and 4000 listen on every address of the app host unless
  `FRONTEND_BIND` or `BACKEND_BIND` in `.env` says otherwise. Set
  `127.0.0.1` for a reverse proxy on the same host. The pages reach the
  backend through port 3000, so `BACKEND_BIND=127.0.0.1` is safe unless
  Prometheus or a script on another machine calls port 4000. With the proxy
  on its own host (CT 140), keep the defaults and rely on the firewall
  rules in [INSTALL.md § 8](INSTALL.md#8-firewall).
- Only the backend may call the broker service, with the internal token.
- The page and API share one address, so the app works on any name or IP that
  reaches port 3000.

### Locked out

For a forgotten login password, or a lost authenticator. The way back in is
a line in `.env`, which wins over what the app has stored.

**Where:** app shell, then the app. A person does this: it chooses a
password.

**Before:** you can reach the app shell.

**Do:**

1. *Forgotten password:* add a line to `.env` with `nano .env`:
   `APP_PASSWORD=` followed by the new password, at least 12 characters.

   *Lost authenticator:* make a new secret with
   `head -c 20 /dev/urandom | base32`, add it to the authenticator app as a
   new account ("enter a setup key", time based), and add a line to `.env`:
   `ORDER_MFA_SECRET=` followed by that secret.
2. Run `./tradingapp.sh restart`.
3. Sign in with the new password (or check that the authenticator's code is
   accepted on Settings > Security).
4. Move the value into the app and take it out of `.env`:

   ```bash
   ./tradingapp.sh settings-import
   ```

   Answer `y` when it asks to delete the lines from `.env`. It keeps a backup
   named `.env.bak.<timestamp>`, which holds the secret: delete it once you
   are signed in.

While the line is in `.env`, the Security tab refuses to change that value
and says so. That is why item 4 comes before any change there.

**Expected:** `settings-import` prints `Stored in the app:` followed by
`APP_PASSWORD` or `ORDER_MFA_SECRET`, removes the line and restarts the
backend.

**If it fails:**
- *The backend does not come back after item 2, and its log says `refusing
  to start`:* the value is too weak or malformed. See
  [Backend refuses to start](#backend-refuses-to-start).
- *`settings-import` says `APP_PASSWORD stays in .env`:* the reason follows
  on the same line, usually that it is shorter than 12 characters. Choose a
  longer one and start again from item 1.
- *Five wrong passwords locked the address out:* wait 15 minutes.

**Done when:** you are signed in, and
`grep -c -E '^(APP_PASSWORD|ORDER_MFA_SECRET)=' .env` prints `0`.

---

## Upgrade, rebuild and move

### Upgrade in place

An upgrade fetches the new version, rebuilds the images and restarts the
stack. Migrations apply themselves when the backend starts. Read
[What each upgrade changes](#what-each-upgrade-changes) first: it lists what
to do after a particular upgrade.

**Where:** Proxmox UI, the CT 100 console, then the CT 110 console as root.

**Before:**
- Nothing is trading: no strategy run is open and no order is working, or
  the markets you trade are closed.
- The app is healthy now: in the app shell, `./tradingapp.sh doctor` shows
  `state: ready`. Do not upgrade a broken install; fix it first.
- The encryption key is stored off the host (`./tradingapp.sh backup-key`
  prints it).
- Note the version you are leaving, for the report if anything goes wrong:
  `git -C /opt/tradingapp rev-parse --short HEAD`.

**Do:**

1. Snapshot the app and the database together, with the same name on both
   ([INSTALL.md § 10.3](INSTALL.md#103-before-an-upgrade)). This is the
   rollback point.
2. Take a fresh dump, in the CT 100 console:

   ```bash
   /usr/local/bin/backup-tradingapp.sh && ls -t /var/backups/tradingapp | head -1
   ```

3. Upgrade, in the CT 110 console as root. The first line refreshes the
   installer itself:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/41agent41/tradingapp/master/install/install.sh -o /root/install.sh
   bash /root/install.sh repo env deploy verify
   ```

4. Check it, in the CT 110 console:

   ```bash
   cd /opt/tradingapp && runuser -u tradingapp -- ./tradingapp.sh doctor
   ```

On a host installed by hand instead of items 3 and 4: `git pull`, then
`./tradingapp.sh install`, then `./tradingapp.sh doctor`.

**Expected:** item 3 ends with `result: PASS` and
`done: repo env deploy verify`. The rebuild takes several minutes, longer
when the base images changed. `doctor` shows `state: ready`, and after an
upgrade that changed the database a line `applied at this start:` naming the
new migrations. On a host set up by an older version, the installer also
removes `.env` lines nothing reads any more (after a backup to
`.env.bak.<timestamp>`).

**If it fails:**

| You see | Cause | Do |
|---|---|---|
| `has local changes to tracked files` | Someone edited a file in `/opt/tradingapp` | `git -C /opt/tradingapp status` shows which. Keep a copy of the change if it matters, `git -C /opt/tradingapp checkout -- <file>`, and run item 3 again. |
| `cannot fast-forward ... it has diverged` | The checkout is not a plain copy of the repository | Stop and report. |
| The build fails | Most often memory (the frontend build needs 4 GB) or a full disk | `free -h`, `df -h`; `docker system prune -f` frees old images. Run item 3 again. |
| `migration_failed` | A migration hit a database error; the detail carries it | [The page says it is waiting for the database](#the-page-says-it-is-waiting-for-the-database-or-a-key-mismatch). If it cannot be fixed, [roll back](#roll-back-an-upgrade). |
| `result: FAIL (n)` | A check failed | Each `CHECK ... FAIL` line is in [INSTALL.md § A.3](INSTALL.md#a3-checks). |
| Every browser is asked to sign in again | Expected after some upgrades | Sign in. API tokens are not affected. |
| Anything else | | [Roll back](#roll-back-an-upgrade), then report with [Reporting a problem](#reporting-a-problem). |

**Done when:** `tail -1 /var/log/tradingapp-install/report.txt` prints
`result: PASS`, you can sign in, every connection on Settings > Connections
shows connected, and a chart updates. Keep the snapshots for a few days,
then delete them: they take real space on LVM-thin and ZFS.

### Roll back an upgrade

The supported way back is the pair of snapshots from item 1 above. An
upgrade can change the database, and the older version is not tested
against the newer schema, so going back to older code alone is not
supported: the app and the database go back together.

**Where:** Proxmox UI.

**Before:** both snapshots exist (CT 110 and CT 100, same name), and you
accept losing what was stored after they were taken. Bars are collected
again by the backfill; orders and fills from that time are not, so check the
broker's own record for anything traded in between.

**Do:**

1. Stop CT 110, then CT 100.
2. CT 100 > **Snapshots** > select the snapshot > **Rollback**. Do the same
   on CT 110.
3. Start CT 100, then CT 110.

Without snapshots there is a slower route, which has not been rehearsed, so
prefer the snapshots and ask before using it: in the app shell,
`./tradingapp.sh stop`; restore the dump from item 2
([Backups and restore](#backups-and-restore)); then
`git checkout --detach` followed by the version you noted under **Before**,
and `./tradingapp.sh redeploy`.

**Expected:** both guests start, and the app comes up as it was when the
snapshots were taken.

**If it fails:** *the app shows `waiting_for_database`:* CT 100 was not
started first, or is still starting. It recovers by itself once the database
answers.

**Done when:** in the app shell, `./tradingapp.sh doctor` shows
`state: ready`, and `git rev-parse --short HEAD` prints the version you
noted before the upgrade.

### What each upgrade changes

Newest first. Each entry says what, if anything, you must do after
upgrading across it.

**Request limits and security headers (S-08 to S-12).** Usually nothing to
do. Check these three only if they apply to you:

- A script that opened a live stream with the API token in the URL
  (`?token=`) must send it as `auth.token` or in the `Authorization` header
  instead.
- A script that posts more than 100 KB of JSON to a route other than the
  Parquet export or the bar upload now gets HTTP 413.
- The pages now carry a Content Security Policy. If a page stays blank after
  the upgrade, open the browser's console, copy any line that mentions
  "Content Security Policy", and report it.

Optional and off until you set them: `METRICS_TOKEN`, `FRONTEND_BIND` and
`BACKEND_BIND` in `.env`.

**Sign-out closes live streams; live streams check the origin.** Nothing to
do. A page on another site can open a live stream only when its origin is
listed in `CORS_ORIGINS`, as for the API.

**Encrypted link to an MT5 sidecar.** Nothing changes until you turn it on:
an existing `http://` connection keeps working, and `doctor` and Settings >
Connections say it is not encrypted. To turn it on, follow
[INSTALL.md § 4.2](INSTALL.md#42-metatrader-5-vm-120): on the sidecar's
machine pull the new code and run the install again with `--tls`, then give
the connection an `https://` Bridge URL and the certificate fingerprint. If
the sidecar's certificate is ever replaced, the connection stops with "MT5
bridge not trusted" until it is given the new fingerprint.

**Images run as an unprivileged user.** The backend and frontend images run
as the `node` user and hold production dependencies only. The upgrade
rebuilds them, and there is nothing to change. Commands run inside them with
`docker compose exec` also run as `node`; add `-u 0` for the rare one that
needs root.

**Migration `010_auth_sessions`: signed-in browsers.** Adds one small table
and runs in an instant. Session cookies issued before this upgrade are no
longer accepted, so every browser signs in once after it. API tokens are not
affected.

**Allowed browser origins.** An empty `CORS_ORIGINS` used to accept requests
from any website and now accepts the app's own pages only. Nothing needs
changing for the app itself, also behind Nginx Proxy Manager. If pages on
another site call the API, list their origins on Settings > Network. If
saving in the app fails with "Origin ... is not allowed" behind another
reverse proxy, see that row under [Sign-in](#sign-in).

**Dependency and Node.js upgrade (November 2026).** The images moved to a
supported Node.js release, the broker service and MT5 sidecar to current
FastAPI and Starlette, and every build now installs exactly the versions in
the lock files. For the app server there is nothing to do beyond the upgrade
itself; the first rebuild is slower because the base images are downloaded
again. **The MT5 sidecars upgrade separately**, because they run on the MT5
VM, not in the Docker stack: see
[Upgrade an MT5 sidecar](#upgrade-an-mt5-sidecar).

**Migration `009_bar_spread`: spreads on bars.** Adds one column,
`candlestick_data.spread`, and runs in an instant. From then on OANDA's bars
are stored with the spread at each bar's close, and a backtest on bars that
carry one fills buys at the ask and sells at the bid. Bars stored before the
upgrade have no spread and are not changed by it. A backtest on them fills
at the mid price as before, and the results offer **Download the range again
with spreads, then run**, which fetches the range from OANDA again and
stores the spread on each bar. The nightly reconcile and the data collection
also add spreads to the bars they fetch again. Expect an OANDA backtest to
return a little less once its bars carry spreads: that is the cost the mid
price left out.

**Migration `008_built_bars`: bars built from 1-minute bars.** The views are
filled in the background within the hour. They answer correctly before that,
only more slowly. A rule-set that has a `stop` block backtests differently
from before, because the stop used to be ignored.

**Migration `006_live_recorder`.** Live streams are per broker connection,
and their channel names changed. Reload any chart tab left open across the
upgrade. Nothing is recorded until you tick Record live on an entry.

**Migration `005_connection_firm`.** Each connection names its firm, and
each firm connects one way only. The migration fills in the firm for OANDA,
IG, Alpaca and IB connections, and for cTrader and MT5 connections named
after their firm. After the upgrade, open Settings > Getting started: the
**Add a broker connection** item lists every connection still without a
firm. For each one, on Settings > Connections:

1. Press **Edit**, choose its **Firm**, and press **Save**.
2. If saving says the firm "connects only through" another broker (an IC
   Markets account on MT5, for example), press **Remove** on that connection
   and add the account again with that firm, which sets the right broker.

**Migration `004_keep_bar_history`.** The upgrade removes the old 2-year
policy and, for every entry whose history start is more than two years back,
resets its history cursor so the next backfill passes re-collect any bars
the policy dropped. Watch the History column; nothing else is needed.

### Upgrade an MT5 sidecar

Needed after an upgrade that changes `mt5_sidecar/` (the November 2026
dependency upgrade did). Do it for each sidecar.

**Where:** VM 120 console (Ubuntu with Wine), or the Windows desktop of
VM 120.

**Before:** the app server is upgraded, and nothing is trading on that MT5
account. The instance name is the one used at install (`demo-a` for the
first account).

**Do:** *Ubuntu with Wine:* update the code, then run the install again. It
keeps the stored secret, login, certificate and TLS setting, installs the
new packages and restarts the service:

```bash
git -C /opt/tradingapp pull --ff-only
cp /opt/tradingapp/install/mt5-sidecar-wine.sh /root/mt5-sidecar-wine.sh
bash /root/mt5-sidecar-wine.sh install --instance demo-a --port 9100 --server-tz <mt5-server-tz>
```

For a second account, run the last line again with `--instance demo-b
--port 9101`.

*Windows:*

1. Stop the sidecar (end the **MT5 sidecar A** task in Task Scheduler).
2. Update the code (`git pull` in `C:\tradingapp`, or copy the new
   `mt5_sidecar/` folder over the old one, keeping `sidecar.env`).
3. Run `python -m pip install -r requirements.txt` in
   `C:\tradingapp\mt5_sidecar`.
4. Start the task again.

**Expected:** on Ubuntu, a line that starts with `[mt5] check: PASS`.

**If it fails:** as in
[INSTALL.md § 4.2](INSTALL.md#42-metatrader-5-vm-120), "Install the terminal
and sidecar".

**Done when:** the check from the app server passes
([INSTALL.md § 4.2](INSTALL.md#check-it-from-the-app-server)), and the
connection shows connected on Settings > Connections.

### Rebuild on a new host, keeping an external database

**Where:** as [INSTALL.md § A.4](INSTALL.md#a4-rebuilding-the-app-server),
which is this procedure in full.

**Before:** the database server is intact, and you have the saved encryption
key.

**Do:** follow [INSTALL.md § A.4](INSTALL.md#a4-rebuilding-the-app-server).
On a host installed by hand instead: `./tradingapp.sh install --external-db`,
with the database's address and password and the saved
`SETTINGS_ENCRYPTION_KEY` in `--answers FILE`, or typed when asked.

**Expected:** the backend adopts the existing schema, applies only pending
migrations and checks the key. It comes up configured: no setup screen, and
the brokers are already there.

**If it fails:** *it stops in `key_mismatch`:* the key is not the one this
database was sealed with. The backend stops there instead of starting with
secrets it cannot read. Find the right key, or see
[Lost encryption key](#lost-encryption-key).

**Done when:** `./tradingapp.sh doctor` shows `state: ready` and you can
sign in with your existing password.

### The bundled database

Its data is in a Docker volume on the app host. `clean` and `redeploy` keep
it. Only `./tradingapp.sh clean --include-database`, after you type DELETE,
removes it. To move to a new host, take a dump first and restore it there.

### Move from the bundled to an external database

`install --external-db` refuses on a host that runs the bundled database,
because it would leave the data behind. Move the data first.

**Where:** the app shell, then the database server's console as root (CT 100
on Proxmox), then the app shell again.

**Before:**
- The app host runs the bundled database: `ls .tradingapp.with-db` in the
  checkout finds the file.
- The database server is built
  ([INSTALL.md step 1](INSTALL.md#1-database-server-ct-100)), with the app
  host's address in its `pg_hba.conf` line, and its database is still empty.
- Nothing is trading.

**Do:**

1. In the app shell, stop the backend and dump the bundled database:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.db.yml stop backend
   docker compose -f docker-compose.yml -f docker-compose.db.yml exec -T postgres \
     pg_dump -U tradingapp -Fc tradingapp > /tmp/tradingapp.dump
   ls -l /tmp/tradingapp.dump
   ```

2. Copy the dump to `/tmp/tradingapp.dump` on the database server. On
   Proxmox, in the Proxmox shell:

   ```bash
   pct pull 110 /tmp/tradingapp.dump /tmp/tradingapp.dump
   pct push 100 /tmp/tradingapp.dump /tmp/tradingapp.dump
   ```

3. On the database server, restore it:

   ```bash
   runuser -u postgres -- psql -d tradingapp -c 'SELECT timescaledb_pre_restore();'
   runuser -u postgres -- pg_restore -d tradingapp --no-owner --role=tradingapp /tmp/tradingapp.dump
   runuser -u postgres -- psql -d tradingapp -c 'SELECT timescaledb_post_restore();'
   ```

4. In the app shell, switch over. `--no-db` stops using the bundled
   database; the key in `.env` stays, so the restored secrets still open. It
   asks for the database's address and password
   (`/root/tradingapp-db-password` on CT 100):

   ```bash
   ./tradingapp.sh --no-db install --external-db
   ```

5. Once the app is healthy, remove the old volume and the dumps:

   ```bash
   docker volume rm tradingapp_tradingapp_pgdata
   rm -f /tmp/tradingapp.dump
   ```

**Expected:** the dump is not empty. `pg_restore` may print one error that
the `timescaledb` extension already exists; that is expected. Item 4 ends
with the app running.

**If it fails:**
- *`pg_restore` prints other errors:* the target database was not empty.
  Drop and recreate it as in INSTALL step 1.3, and restore again.
- *Item 4 stops at `waiting_for_database`:* the address, password or
  `pg_hba.conf` line is wrong. Correct it and run item 4 again. The bundled
  database's volume is untouched until item 5, so nothing is lost meanwhile.
- *`key_mismatch`:* `.env` lost its key. Put the saved key back.

**Done when:** `./tradingapp.sh doctor` shows `Database: external` and
`state: ready`, your connections and stored bars are there, and
`docker volume ls | grep pgdata` prints nothing.

### Lost encryption key

Only when the saved key cannot be found anywhere. This cannot be undone.

**Where:** app shell. A person decides this: an agent never runs it on its
own ([INSTALL.md § A.5](INSTALL.md#a5-rules-for-an-agent-running-the-install)
rule 7).

**Before:** you have looked for the key in the password manager, in
`.env.bak.*` files in the checkout, and in backups of the app server. You
have each broker's credentials to hand, to enter again.

**Do:**

```bash
./tradingapp.sh forget-secrets
```

and type `FORGET` when asked. Then sign in and enter the secrets again, on
Settings > Connections, Alerts and safety, and Security.

**Expected:** it clears every secret sealed with the old key: broker
credentials, secret settings, the MFA secret and the session key.
Connections and settings stay.

**If it fails:** stop and report. Never generate a new key on a database
that already holds secrets; `install` never replaces an existing key for
that reason.

**Done when:** `./tradingapp.sh doctor` shows `state: ready`, every
connection shows connected again, and the new key is stored off the host
(`./tradingapp.sh backup-key`).

### Internal secrets

The broker service token and the Redis password are generated on first
start. Rotate them if they may have leaked.

**Where:** app shell.

**Before:** nothing is trading; the services restart.

**Do:**

```bash
./tradingapp.sh rotate-internal-secrets
```

**Expected:** it replaces both and recreates the services that use them.

**If it fails:** *it warns that `BROKER_SERVICE_TOKEN` or `REDIS_PASSWORD`
"is still set in .env and wins":* a line left by an old install.
`./tradingapp.sh install` removes it; then rotate again.

**Done when:** `./tradingapp.sh test` passes for every service.

---

## Going live

Live orders are off by default. The backend and the broker service both
refuse any `account_mode=live` order with 403 until you turn it on; paper
orders always work. Take a strategy through
[PAPER_TRADING.md](PAPER_TRADING.md) first.

**Where:** the app, then the app shell. A person does this, and only a
person: an agent never turns live trading on or adds a live connection
([INSTALL.md § A.5](INSTALL.md#a5-rules-for-an-agent-running-the-install)
rule 1).

**Before:**
- The strategy has been through [PAPER_TRADING.md](PAPER_TRADING.md).
- On Settings > Security, order MFA is enrolled and a trading token exists.
- Alerts and the dead-man's switch work
  ([INSTALL.md step 6](INSTALL.md#6-alerts-and-safety-nets)).
- `LIVE_TRADING_ENABLED=false` is not pinned in `.env`:
  `grep -c '^LIVE_TRADING_ENABLED=' .env` prints `0`.

**Do:**

1. Add the account as a **live** connection on Settings > Connections. A
   live order to a paper connection is refused. For IB that is the live port
   (4001); for MT5 the sidecar also needs `MT5_ALLOW_REAL=true` in its
   settings file, and a restart of the sidecar.
2. On Settings > Trading, enter the trading token and a current MFA code,
   set Live trading on, and type LIVE when asked. The change goes to the
   settings history and to Telegram.
3. Check the gate, in the app shell, with `$API_TOKEN` set as at the top
   of this guide:

   ```bash
   curl -s -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:3000/api/orders/config | jq
   ```

**Expected:** `live_trading_enabled` is `true`, and `backend_live_enabled`
and `ib_live_enabled` agree.

**If it fails:**
- *`backend_live_enabled` and `ib_live_enabled` disagree:* the broker
  service has not picked the change up yet (it does within 15 seconds). Run
  the check again. Do not send a live order until they match.
- *The switch is locked on the page:* `LIVE_TRADING_ENABLED` is pinned in
  `.env`, which wins.
- *The save is refused:* the trading token or the MFA code is wrong.

**Done when:** the check shows all three `true`, and a Telegram message
reported the change.

A strategy runs live only after the promotion gate has seen a paper run of
the same definition (`GET /api/strategies/definitions/:id/promotion` says
what is missing).

Safety rails:

- `LIVE_TRADING_ENABLED=false` in `.env` keeps live off whatever the page
  says. Removing the trading token or the MFA secret also closes the gate.
- `ORDER_MAX_QUANTITY` (default 100,000) and `ORDER_MAX_PRICE` (default
  1,000,000) on Settings > Risk apply to every order.
- Every order attempt is stored in `order_audit`, shown in the `/trade`
  blotter and at `GET /api/orders/audit`.
- With `SYSTEMATIC_EXECUTION_ENABLED` on and no heartbeat URL, the backend
  logs a startup warning: nothing would page you if the host went down.

---

## Data collection and retention

Which instruments and timeframes are stored, how often and for how long is
the data collection table on Settings > Schedulers and data
(`data_collection_config`; API `/api/market-data/collection`). Setting it up
is [INSTALL.md step 5](INSTALL.md#5-market-data).

- Each backfill pass (`BACKFILL_INTERVAL_MINUTES`) fetches every enabled
  entry whose newest bar is older than its interval, over the recent
  `BACKFILL_PERIOD`, and upserts the bars, so gaps inside the window fill
  themselves. Removing an entry stops collection; stored bars stay.
- With **History from** set, each pass also walks back towards that date in
  chunks of about 20,000 bars, up to five per entry per pass. OANDA and Alpaca
  requests are paged past their per-request limits; MT5 answers a date range
  in one request. The History column shows progress.
- Bars and stored quotes have no TimescaleDB retention policy. The backend's
  cleanup is the only thing that deletes them. It runs every day at 03:30
  UTC, and on `POST /api/market-data/database/clean`. It removes bars older
  than each entry's retention, always keeping bars from an entry's history
  start on, and stored quotes older than `TICK_RETENTION_DAYS` (30 by
  default), a whole day at a time.
- With **Record live** ticked, the live recorder stores the instrument's
  1-minute bars from its live prices, and with **Store ticks** each quote as
  well. See [Live recorder](#live-recorder) below.

Check it, in the app shell, with `$API_TOKEN` set as at the top of this
guide:

```bash
curl -fs http://127.0.0.1:4000/api/health | jq .services.backfill
curl -fs -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:4000/api/market-data/database/stats | jq
```

---

### Live recorder

What it does and how is in
[FEATURES.md § Live recorder](FEATURES.md#live-recorder). Day to day:

```bash
./tradingapp.sh doctor        # its last section is the recorder
curl -fs http://127.0.0.1:4000/api/health | jq .services.recorder
curl -fs http://127.0.0.1:4000/api/market-data/recorder/status | jq
```

The line above the data collection table says the same in words, and the
Live feed column shows each recorded instrument: streamed or polled, quotes
in the last minute, the time of the last quote, or why it is not streaming.

| You see | What to do |
|---|---|
| "Live recorder: off" | Turn on `RECORDER_ENABLED` on the same tab. |
| "not running", with a reason | The backend cannot reach Redis, the database or the broker service. `docker compose ps`, then `docker compose logs backend redis broker_service`. It retries every 5 seconds by itself. |
| "falling behind", lag growing | The database is slow or down. Quotes wait in Redis (up to `TICK_STREAM_MAXLEN`) and are stored when it returns. If lag grows with the database healthy, record fewer instruments with Store ticks, or raise `TICK_STREAM_MAXLEN` while you look. |
| "not streaming: ..." on a row | The broker refused the symbol or is down; the text is the broker's reason. Fix the symbol or the connection. It is tried again every minute. |
| "no quote yet" for minutes | The market is closed, or the broker sends nothing for that symbol. Open `/live` for the same symbol and connection to compare. |
| A gap in recorded bars | The nightly reconcile (02:30 UTC) fills it from the broker's history. **Reconcile now**, under the recorder's line, does it at once. It reaches back two days; for an older gap, tick Collect on the instrument's 1min row and let the backfill fetch it. |
| "Reconcile ... 1 instrument failed" | The broker refused the history request. `curl -fs http://127.0.0.1:4000/api/market-data/recorder/status \| jq .reconcile` gives the reason per instrument. It is tried again the next night. |

A weekend or a closed market gives no quotes and no bars. That is normal and
is not reported as a fault.

In the reconcile's results, `mean_move_bps` is how far the broker's closes
were from the recorded ones. A few basis points on a polled broker is
expected. The same large figure every night on one broker means its bars are
being built on the wrong price; report it.

### Backtests and stored bars

Backtests run on stored bars
([FEATURES.md § Backtesting](FEATURES.md#backtesting)). When the page says
bars are missing:

- **Fetch missing bars, then run** is right the first time an instrument and
  timeframe is backtested, or after widening the range. Years of 5-minute
  bars take a few minutes; the page waits up to 15.
- **Run on what is stored** is right when the missing stretch is before the
  broker's own history starts, so fetching cannot fill it.

To have the bars there already, add the instrument and timeframe to the data
collection table with **History from** set
([INSTALL.md step 5](INSTALL.md#5-market-data)).

A 5-minute to 1-hour backtest needs no fetch when the range is covered by
1-minute bars: it runs on bars built from them, and the results header says
so. These bars come from the views `bars_5min`, `bars_15min`, `bars_30min`,
`bars_1hour`, `bars_4hour` and `bars_1day`, which TimescaleDB keeps up to
date by itself. To see them:

```bash
docker compose exec postgres psql -U tradingapp -d tradingapp -c \
  "SELECT view_name, materialized_only FROM timescaledb_information.continuous_aggregates;"
```

A strategy with a protective stop is backtested most faithfully when 1-minute
bars are stored for the range, because the stop then fills on the minute that
reached it. The results header says which was used: "Stops filled along
stored 1 minute bars" or "Stops filled on each bar's own range". For the
first, record the instrument live or add it to the data collection table at
1 minute.

OANDA's bars carry the spread at each bar's close, and a backtest on bars
that carry one fills buys at the ask and sells at the bid. Bars stored
before spreads were kept fill at the mid price, and the results offer
**Download the range again with spreads, then run**.

To check two runs used the same data, compare the data hash in their results
headers, or `data.hash` from `GET /api/backtesting/runs/<id>`, where `<id>`
is the run's id from the results page.

What changed with each upgrade is under
[What each upgrade changes](#what-each-upgrade-changes).

### Bar replay

The Bar Replay page ([FEATURES.md § Bar replay](FEATURES.md#bar-replay))
plays stored 1-minute bars.

- **"No 1 minute bars are stored for ..."** The instrument has none at that
  broker. Tick **Record live** for it, or add it to the data collection
  table at 1 minute with **History from** set, and choose the same
  connection on the replay page.
- **"... They are stored from A to B."** The start is after the last stored
  bar. Choose a start inside that range.
- **The candles before the start are missing or few.** They come from the
  views built from 1-minute bars, so there are only as many as there is
  1-minute history before the start.
- **A strategy's trades could not be worked out.** The message gives the
  backtest's reason. On 4-hour and daily candles a backtest needs the
  broker's own bars for that timeframe stored; on 5 minutes to 1 hour the
  stored 1-minute bars are enough.

## Executions (fills) sync

Without the sync, positions and P&L are estimated from submitted orders,
which is wrong on partial fills, late rejections and trades placed outside
the app. With Fills sync (`EXECUTIONS_SYNC_ENABLED`, Settings > Schedulers and
data) on, the backend records each venue's own fills. Turn it on if a
strategy uses `risk.max_daily_loss` (with the sync off that cap fails closed
and the run places nothing), or if you want `/api/account/executions` and
`/api/account/pnl`.

- It polls only venues the app has traded at recently or has a running
  strategy on. The window overlaps on purpose so late fills are picked up;
  rows upsert on `(broker, broker_account, exec_id)`.
- OANDA fills also arrive as they happen, over OANDA's transaction stream,
  while the sync is on. To check it, `GET /account/executions/stream/status`
  on the broker service lists each OANDA connection with `listening`, a fill
  count and its `last_error`; `/api/health` on the backend shows the same
  under `services.executions.stream` (`listening`, `received`, `stored`). A stream
  that is down costs nothing but speed: the poll still records every fill.
  Fills streamed while Redis or the backend is down are not replayed; the
  next poll brings them in.
- IG and Alpaca appear in the same two places. Their streams are used only
  as a sign that something traded, so the count is of trade events, and the
  backend's
  `services.executions.stream.refreshes` counts the polls they caused.
  An IG stream signs in with the same session as its REST requests. If IG
  refuses a stream, `last_error` shows IG's reason and the service logs in
  again at most once a minute, because IG locks an API key that logs in too
  often. IG allows 40 streaming subscriptions per session; the app uses one
  for all of a connection's live prices and one for its trades.
  Alpaca answers `connection limit exceeded` (406) when a second market data
  connection is opened with the same key, which happens if another program
  is streaming with it; a free account's 31st symbol is refused with
  `symbol limit exceeded` (405). In both cases prices fall back to polling.
- A position is the recorded fills plus the unfilled part of working orders.
  `ORDER_MAX_POSITION` caps the whole account, so manual trades count.
- IB reports times in the Gateway's zone (`IB_TIMEZONE`, default UTC). Run
  the Gateway in UTC.

Check it:

```bash
curl -fs http://127.0.0.1:4000/api/health | jq .services.executions
curl -fs -H "Authorization: Bearer $API_TOKEN" \
  "http://127.0.0.1:4000/api/account/reconciliation?broker=ib" | jq
```

The reconciliation lists every symbol either side knows with a `matched`
flag. On an account you also trade by hand, alert on `.mismatches > 0`.

---

## Monitoring

### Health

```bash
./tradingapp.sh status
./tradingapp.sh test
./tradingapp.sh doctor
curl -fs http://127.0.0.1:4000/api/health/ready
curl -fs http://127.0.0.1:4000/api/health | jq
```

`/api/health/ready` answers 200 when the database is reachable, migrated and
opened by the key, and 503 with the reason otherwise. The backend's Docker
health check uses it. Brokers and Redis do not count, so an outage there
never marks the backend down. `/api/health` also reports the cache,
streaming, backfill, the live recorder, fills sync and heartbeat.

Redis is a cache, the live-tick bus and the queue of quotes waiting to be
recorded. If it is down, endpoints still work, charts fall back to one-off
REST calls, and live recording pauses until it returns. The cache, the chart
stream and the recorder can each be switched off on Settings > Schedulers
and data (`REDIS_ENABLED`, `STREAMING_ENABLED`, `RECORDER_ENABLED`).

### Prometheus and Grafana

The backend serves Prometheus metrics at `GET /metrics` on port 4000. With
no `METRICS_TOKEN` in `.env` it needs no token, so port 4000 should be
reachable only from Prometheus (the firewall rules in INSTALL.md § 8 do
that). To require a token, add `METRICS_TOKEN=<a long random value>` to
`/opt/tradingapp/.env` (`openssl rand -hex 24` makes one), run
`./tradingapp.sh restart`, and give Prometheus the same value under the job:
`authorization: { credentials: '<the value>' }`. Check it with
`curl -s -o /dev/null -w '%{http_code}\n' http://<app-address>:4000/metrics`,
which prints `401` without the token. The broker service has its own `/metrics`, but it is published on
the app host's loopback only, so an outside Prometheus cannot reach it
without a proxy of your own.

```yaml
# prometheus.yml
rule_files:
  - /etc/prometheus/alerts.yml
scrape_configs:
  - job_name: tradingapp-backend
    metrics_path: /metrics
    static_configs: [{ targets: ['<app-address>:4000'] }]
```

- **Alert rules:** copy [`ops/prometheus/alerts.yml`](../ops/prometheus/alerts.yml)
  to `/etc/prometheus/alerts.yml` and check it with
  `promtool check rules /etc/prometheus/alerts.yml`. It covers targets down,
  error rate, latency and event-loop lag, and per connection (the
  `tradingapp-fleet` group) an open circuit breaker, unprotected positions,
  position divergence, stop gaps, orders blocked by caps and connections with
  no active runs.
- **Dashboard:** in Grafana, **Dashboards → New → Import**
  [`ops/grafana/tradingapp-dashboard.json`](../ops/grafana/tradingapp-dashboard.json)
  and pick your Prometheus data source for `DS_PROMETHEUS`. It shows request
  rate, p95 latency and error rate per service, backtest runs persisted, and
  process memory, CPU and event-loop lag.

| Metric | From |
|---|---|
| `http_request_duration_seconds` (histogram, and its `_count`) | backend (`backend/src/services/metrics.ts`) and broker service |
| `backtest_runs_persisted_total` | backend (`backend/src/routes/backtesting.ts`) |
| `process_*`, `nodejs_*` | backend (`prom-client` defaults) |
| `http_requests_total` | broker service (`prometheus_fastapi_instrumentator`) |

Prometheus runs on your own infrastructure, so it does not replace Telegram
alerts and the heartbeat: something off the host must notice when everything
stops.

---

## Backups and restore

Keep the encryption key with the backups, but not on the same host:
`./tradingapp.sh backup-key`. A dump restores everything; without its key,
everything except the stored secrets.

Taking dumps on the database server is
[INSTALL.md § 1.5](INSTALL.md#15-nightly-dumps). For the bundled database,
the same `pg_dump -Fc` runs through `docker compose -f docker-compose.yml -f
docker-compose.db.yml exec -T postgres pg_dump -U tradingapp -Fc tradingapp`
on the app server. Managed databases have their own point-in-time recovery;
prefer it.

### Restore a dump

**Where:** the app shell to stop the app, then the database server's console
as root (CT 100 on Proxmox).

**Before:**
- You have the dump file, and its path on the database server (dumps from
  INSTALL step 1.5 are in `/var/backups/tradingapp/`).
- The `timescaledb` extension exists in the target database (it does on a
  server built with INSTALL step 1).
- You have the encryption key that database was sealed with.
- You accept that the restore replaces what the database holds now.

**Do:**

1. In the app shell, stop the app: `./tradingapp.sh stop`.
2. On the database server, with the dump's path in place of the one shown:

   ```bash
   DUMP=/var/backups/tradingapp/tradingapp_20261112_021000.dump
   runuser -u postgres -- psql -d tradingapp -c 'SELECT timescaledb_pre_restore();'
   runuser -u postgres -- pg_restore -d tradingapp -c --no-owner --role=tradingapp "$DUMP"
   runuser -u postgres -- psql -d tradingapp -c 'SELECT timescaledb_post_restore();'
   ```

3. In the app shell, start the app: `./tradingapp.sh start`.

For the bundled database, run the three commands of item 2 through
`docker compose -f docker-compose.yml -f docker-compose.db.yml exec -T postgres`
as user `tradingapp` (`psql -U tradingapp`, `pg_restore -U tradingapp`), with
only the backend stopped
(`docker compose -f docker-compose.yml -f docker-compose.db.yml stop backend`).

**Expected:** `pg_restore` may print an error that the `timescaledb`
extension already exists; that is expected. The two `SELECT` lines each
print one row.

**If it fails:**
- *The app comes up in `key_mismatch`:* the key in `.env` is not the one the
  dump was sealed with. Put that key in `.env` and `./tradingapp.sh restart`.
- *`pg_restore` reports many errors about existing objects:* the dump was
  restored without `-c` into a database that was not empty. Run item 2
  again as written.

**Done when:** `./tradingapp.sh doctor` shows `state: ready`, and the newest
bar on a chart matches the time of the dump.

Test a restore at least once, into a spare database server, before you need
one.

---

## Troubleshooting

### First response

```bash
./tradingapp.sh status          # containers and ports
./tradingapp.sh test            # do the services answer?
./tradingapp.sh doctor          # Docker, .env, database, schema, key, brokers
./tradingapp.sh logs            # recent lines per service
./tradingapp.sh fix             # stop, deploy and check again
```

`./tradingapp.sh install` is safe to re-run and repairs most host problems.

### The page says it is waiting for the database, or a key mismatch

The backend does nothing else until its database is reachable, migrated and
opened by the encryption key. Until then `/api/health/ready` and every other
API route answer 503 with the state, and the page shows it.

| State | Meaning | What to do |
|---|---|---|
| `waiting_for_database` | The backend cannot reach PostgreSQL. It retries every 1 to 30 seconds with no deadline, so it recovers once the database is up. | Bundled: `./tradingapp.sh status` and `logs`. External: check `POSTGRES_*` in `.env` (host, port, password, `POSTGRES_SSL`), and from the app host `nc -vz <db-address> 5432`; then `listen_addresses`, `pg_hba.conf` and the firewall. |
| `migrating` | The schema is being created or updated. | Wait. A first install or a large migration can take minutes. |
| `migration_failed` | A migration failed; the detail carries the database error. It does not retry by itself. | Usually permissions: the role must own the database, and the `timescaledb` extension must exist. Fix it, then `./tradingapp.sh migrate`, which applies what is pending and restarts the backend if it had stopped on the failure. |
| `key_mismatch` | `SETTINGS_ENCRYPTION_KEY` in `.env` does not open this database's secrets. | Put the saved key back in `.env` and `./tradingapp.sh restart`. If it is lost: [Lost encryption key](#lost-encryption-key). |

`install` waits up to 900 seconds; on a slow host,
`INSTALL_TIMEOUT=1800 ./tradingapp.sh install`.

### Backend refuses to start

The backend log has `refusing to start: ...` lines
(`docker compose logs backend | grep -E 'refusing to start|\[startup\]'`).
Each names the key:

- **`... is still a template or default value`** or **`is shorter than N
  characters`**: a secret pinned in `.env` is weak. Remove the line to manage
  it in the app, or set a fresh value (`openssl rand -hex 32`).
- **`BROKER_SERVICE_TOKEN ...`**: an old `.env` line; `./tradingapp.sh
  install` removes it, or `rotate-internal-secrets` makes a new one.
- **`POSTGRES_PASSWORD is empty or a known default`**: change it in the
  database and in `.env` together.
- **`KILL_SWITCH_ACTION`**, **`TRADING_DAY_TIMEZONE`**, **`PROP_RULES__<CONNECTION>`**,
  **`HEARTBEAT_URL`**: an invalid value, usually pinned in `.env`. Fix or
  remove it; the Settings page checks these when you save.

`refusing to start: unsafe schema for multi-connection` does not stop the
process: the strategy runner and fills poller stay off. Run
`./tradingapp.sh migrate`, then `restart`. `[startup]` lines without
"refusing" are warnings worth acting on, such as auto-execution with no
heartbeat URL.

### Install and host

| Symptom | Fix |
|---|---|
| "Don't run this script as root" | `tradingapp.sh` runs as the deploy user: `su - tradingapp`, or `runuser -u tradingapp -- ./tradingapp.sh ...`. As root, use `install/install.sh` ([INSTALL.md step 2](INSTALL.md#23-run-the-installer)). |
| "docker group membership is not active" | The script re-runs itself under `sg docker`. If it still says so: `newgrp docker` (or log out and in), then re-run. |
| "Docker is installed but not running" | `sudo systemctl start docker` |
| Port already in use | `sudo ss -ltnp \| grep -E ':(3000\|4000\|8000)'`; free it, or set `FRONTEND_PORT` / `BACKEND_PORT` / `BROKER_SERVICE_PORT` in `.env` and `./tradingapp.sh deploy`. |
| Build fails | `docker system prune -f`, then `./tradingapp.sh redeploy`. Under 4 GB of memory the frontend build fails. |
| Permission denied on files | `sudo chown -R "$USER":"$USER" .` and `chmod 600 .env` |
| `.env` lost or damaged | Restore it from a backup, or run `./tradingapp.sh install --env-only`, put the original `POSTGRES_PASSWORD` and `SETTINGS_ENCRYPTION_KEY` back, then `install`. |

Never run `docker compose down -v` to "fix" volumes: it deletes the bundled
database and the internal secrets. `./tradingapp.sh clean` keeps them.

### Proxmox containers

| Symptom | Cause and fix |
|---|---|
| Docker fails to start, or containerd exits at once | Keyctl is off. CT > **Options** > **Features**: tick **keyctl** and **nesting**, then restart the container. |
| Docker starts but every `run` fails with an overlay or mount error, or `docker info` shows storage driver `vfs` | Nesting is off, or the storage cannot carry `overlay2`. Tick **nesting** (and **FUSE**) under **Options** > **Features**, `apt install fuse-overlayfs`, put `{ "storage-driver": "fuse-overlayfs" }` in `/etc/docker/daemon.json`, then `rm -rf /var/lib/docker` and `systemctl restart docker`. That discards the images; `bash /root/install.sh deploy` rebuilds them. |
| Docker warns about `/dev/kmsg` | Harmless in a container. |
| Docker works only in a privileged container | Don't keep that. Go back to unprivileged and turn on the feature that was missing (nesting, keyctl or FUSE). |
| `free -h` in a container shows the host's total memory | Restart the container. |
| A process is killed well below the host's free memory | Container memory is a hard limit. Raise it under **Resources** > **Memory**. |
| Time is wrong in a container | Fix the host's clock; containers cannot set their own. |
| The installer warns the clock is not NTP-synchronised | In a container that is the host's job; check the host's time synchronisation. |
| Firewall rules have no effect on a guest | Its network device lacks the **Firewall** tick ([INSTALL.md § 8.2](INSTALL.md#82-turn-the-firewall-on-for-each-guests-network)). |
| Everything unreachable after turning on the datacenter firewall | From the physical console: `pve-firewall stop`, fix the rules at **Datacenter** > **Firewall**, then start it again. |
| Snapshots fail | The storage cannot snapshot (plain directory storage). Move the disk to LVM-thin or ZFS, or rely on the backup job. |
| Host storage full, containers stuck | Usually old snapshots or backups on local storage. Delete them, then restart the containers. |
| Routes to part of the LAN vanish on CT 110 only | That part of the LAN overlaps the app's Docker network, `172.20.0.0/16` ([INSTALL.md § Plan the addresses](INSTALL.md#plan-the-addresses)). |
| `waiting_for_database` on CT 110 | From CT 110: `nc -vz <db-address> 5432`; then the database's `pg_hba.conf` line, the password in `.env`, and CT 100's firewall rule ([INSTALL.md step 1](INSTALL.md#1-database-server-ct-100)). |
| IB Gateway connection down | In CT 130: `docker compose logs` in `/opt/ib-gateway`. A login IB refuses, or a second factor it asks for, shows there. |

### Sign-in

| Symptom | Fix |
|---|---|
| The login page asks for a setup code | No password is set yet. `./tradingapp.sh setup-code`. |
| Forgot the password or lost the authenticator | [Sign-in and API tokens](#sign-in-and-api-tokens). |
| Scripts get 401 | Missing or wrong API token. If `NEXT_PUBLIC_API_TOKEN` is still in `.env`, remove it and rotate any token that held that value: it was readable in the page. |
| "Origin ... is not allowed" | A page on another site called the API: list its exact origin in `CORS_ORIGINS` (Settings > Network). If it is the app's own page behind a reverse proxy, the proxy passes the browser's host in neither `Host` nor `X-Forwarded-Host`: fix the proxy, or add the public origin (for example `CORS_ORIGINS=https://trading.example.com` in `.env`, then `./tradingapp.sh restart`), since the Settings page cannot save while this fails. |
| Logs show the proxy's address, not the visitor's | Set `TRUST_PROXY` (Settings > Network) to the proxy's address ([INSTALL.md § 7.3](INSTALL.md#73-tell-the-app-about-the-proxy)); for a proxy on the app server itself, `172.20.0.1`. |

### Brokers

Brokers are tested in the app, never by `install` or `test`, so a broker
that is down never fails a deploy. Each connection has a Test button and the
app re-checks every `BROKER_PROBE_INTERVAL_SECONDS`.

| Symptom | Cause and fix |
|---|---|
| Requests for a broker return 501 | No connection for it. Add one on Settings > Connections. |
| Requests return 503 | The broker is unreachable from the app host. Cloud brokers: outbound HTTPS. MT5: the sidecar host, the terminal's login, the URL. IB: below. |
| Connection shows "overridden" | A broker line in `.env` wins over the app. Delete it when ready and `./tradingapp.sh restart`. |
| A connection shows a secret error | The secrets were sealed with another key. Re-enter them, or see [Lost encryption key](#lost-encryption-key). |
| MT5 sidecar rejects requests | The connection's Bridge secret is not the sidecar's `MT5_BRIDGE_SECRET`. |
| MT5 `/health` reports `trading_disabled` | Turn Algo Trading on in the terminal. |
| MT5 quote times off by whole hours | `MT5_SERVER_TZ` on the sidecar is wrong. |
| Symbol resolution says "ambiguous" | The broker lists several tiers of the pair; the connection needs a symbol map ([INSTALL.md § 4.9](INSTALL.md#49-not-yet-on-the-form-symbol-maps-and-account-info-from)). |
| Log line `connection breaker open` | That connection is not answering. Others keep running; it is retried after the cooldown. |

IB Gateway, checked from the app host with `nc -vz <ib-address> 4002`:

| Symptom | Likely cause | Fix |
|---|---|---|
| Connection refused | Gateway not running, or wrong port | Start it; match the port on the connection to its socket port. |
| Timeout or host unreachable | A firewall between the hosts | Open the port to the app host and check routing. |
| Connects, then disconnects | Client id already in use | Give the connection an unused client id. |
| Connects but no data, or empty searches | Not logged in, no market-data subscription, or the app host missing from Trusted IPs | Log in; subscribe in IB Account Management; fix Trusted IPs and restart the Gateway. |
| Bars shifted by hours | The Gateway is not in UTC | Run it in UTC, or set `IB_TIMEZONE`. |

### Charts and streaming

| Symptom | Fix |
|---|---|
| Network errors in the browser, blank charts | `curl -fs http://127.0.0.1:3000/api/health` (through the frontend) and `http://127.0.0.1:4000/api/health` (direct). If only the first fails, check `BACKEND_INTERNAL_URL` in `docker-compose.yml` matches `BACKEND_PORT`. A 503: the readiness states above. |
| Bars in the wrong year or shifted hours | Bars are stored in UTC. Compare one from `/api/market-data/history` with the broker's own chart; for IB, run the Gateway in UTC. |
| Slow charts | Shorter periods (`3M` rather than `1Y`); collect the instrument so reads come from the database. |
| Price stops updating, history still loads | `curl -fs http://127.0.0.1:4000/api/health \| jq .services.streaming`. `connected: false`: the backend cannot reach Redis (`docker compose logs backend redis`, then `docker compose restart redis`). No subscriptions: reload the chart. Ticks published but none in the browser: the session expired, sign in again. |

### Systematic trading and alerts

[PAPER_TRADING.md](PAPER_TRADING.md) is the step-by-step check for all of
this. The Fleet panel on `/systematic` shows each connection's limits and
halt state.

| Symptom | Cause and fix |
|---|---|
| Signals recorded but no orders | `SYSTEMATIC_EXECUTION_ENABLED` is off (signal-only), or a limit refuses entries. The signal's reason says which: daily loss, prop buffer, news blackout, weekend cutoff, or the connection is halted. |
| A run won't start: promotion gate | `GET /api/strategies/definitions/:id/promotion` lists what is missing. `PROMOTION_PAPER_GATE=off` skips the paper check, for smoke tests only. |
| Entries refused with "news rule cannot be checked" | The calendar could not be fetched for `NEWS_CALENDAR_MAX_AGE_HOURS`. Check outbound HTTPS. |
| A connection shows halted | A critical kill-switch trigger under `halt` or `flatten`, or an operator flatten. Fix the cause (the alert names it), then **Resume entries** on its Fleet card. A halt survives restarts. |
| "FLATTEN INCOMPLETE" alert | A close at market failed. Close the rest in the terminal, then resume. |
| Daily figures roll over at the wrong time | `TRADING_DAY_TIMEZONE` (Settings > Risk) to the broker's or prop firm's server zone. |
| Drawdown stays high after a withdrawal | Reset the high-water mark from the connection's Fleet card. |
| No Telegram messages | Check the bot token and chat id (message the bot first, then read `getUpdates`). Repeats are suppressed for `ALERT_DEDUPE_SECONDS`. |
| Heartbeat monitor never turns green | `/api/health` shows `heartbeat.last_result`. Check the URL and outbound HTTPS. |

### Emergency recovery

When the stack will not come up and the tables above have not helped. Each
item is stronger than the one before; stop at the first that works.

**Where:** app shell.

**Before:** you have read `./tradingapp.sh doctor` and
`./tradingapp.sh logs`, and the problem is not one the tables above name.

**Do:**

1. `./tradingapp.sh fix` (stop, deploy, check).
2. `./tradingapp.sh clean`, then `./tradingapp.sh install` (remove the
   containers and images, rebuild, and wait until ready). The database and
   the internal secrets are kept.

**Expected:** `install` ends with the app's address.

**If it fails:** stop and report
([Reporting a problem](#reporting-a-problem)). Do not go further on your
own: `clean --include-database` also deletes the bundled database and the
internal secrets, and is only ever run on the operator's word, after a dump.

**Done when:** `./tradingapp.sh test` passes for every service and
`./tradingapp.sh doctor` shows `state: ready`.

### Reporting a problem

**Where:** app shell.

**Before:** nothing.

**Do:**

```bash
./tradingapp.sh doctor  > diagnostics.txt 2>&1
docker compose version >> diagnostics.txt
uname -a               >> diagnostics.txt
df -h                  >> diagnostics.txt
free -h                >> diagnostics.txt
```

**Expected:** a file `diagnostics.txt` in the checkout. `doctor` prints the
names of the keys in `.env`, never their values.

**If it fails:** *`doctor` itself fails:* include what it printed.

**Done when:** you have sent `diagnostics.txt`, the OS version, the step or
procedure you were on, the exact command and its output, and the version
(`git rev-parse --short HEAD`). Never include a value from `.env`, a
password, a token or the encryption key.
