# Paper Trading Runbook: Two MT5 Demo Accounts

**Purpose:** get Components C and E running end to end against two real MT5
demo accounts, with auto-execution **off** for most of it and the kill switch
in notify-only throughout. Start from an install that has passed
[INSTALL.md](INSTALL.md) step 11. This runbook covers what sits around it:
two broker accounts, their MT5 terminals and sidecars, and the settings to
turn on in the app, in order.

**How to use it:** work top to bottom. Every step has the same six parts as
an install step: **Where**, **Before**, **Do**, **Expected**, **If it
fails** and **Done when**
([INSTALL.md § How each step is written](INSTALL.md#how-each-step-is-written)).
Report `PASS` or `FAIL` per step number: a step passes when its **Done
when** holds. On a failure that is not listed, stop and send back the step
number, the command and its output.

**Do not skip the ordering.** Step 3 (the schema is up to date) must pass
before step 11 adds a second connection. Fixing the schema afterwards cannot
recover fills that were already dropped.

**Paper only.** Both accounts are demo accounts and both connections are
`paper`. Nothing in this runbook turns live trading on, and an agent
following it never does
([INSTALL.md § A.5](INSTALL.md#a5-rules-for-an-agent-running-the-install)).

**Where settings live.** Switches such as `SYSTEMATIC_ENABLED` are set on the
app's Settings page, on the tab named in each step. Each setting shows its
key there. A key can still be pinned in `.env`: the page then shows it as
locked, and `.env` wins. Prefer the page.

## Names used in every step

**Where** uses the names from
[INSTALL.md](INSTALL.md#how-each-step-is-written), and two more:

| Name | Is |
|---|---|
| App shell | CT 110's console, then `su - tradingapp` and `cd /opt/tradingapp` |
| Terminal A, terminal B | The MT5 terminal of each demo account, on VM 120's desktop (reach it with `bash /root/mt5-sidecar-wine.sh vnc --instance demo-a`, as in INSTALL § 4.2) |

Placeholders in angle brackets are the ones on the
[values sheet](INSTALL.md#values-sheet). Two more are used here, and you
record them in step 1:

| Placeholder | Meaning | Example |
|---|---|---|
| `<symbol-a>`, `<symbol-b>` | EURUSD exactly as each broker's terminal names it | `EURUSD`, `EURUSD.a` |
| `<definition-id>` | The id of the strategy definition made in step 16 | `12` |

The commands use these shell variables. Set them once, in the app shell, and
again in any new shell. Each `read` asks a question and waits, so run those
lines one at a time:

```bash
BASE=http://127.0.0.1:4000
BROKER=http://127.0.0.1:8000
SIDECAR_A=https://<mt5-address>:9100
SIDECAR_B=https://<mt5-address>:9101
TOKEN=$(docker compose exec -T backend cat /run/tradingapp/broker_service_token)
```

```bash
read -rsp 'API token: ' API_TOKEN; echo
```

```bash
read -rsp 'Bridge secret of sidecar A: ' SECRET_A; echo
```

```bash
read -rsp 'Bridge secret of sidecar B: ' SECRET_B; echo
```

- `$BASE` is the backend. Its API needs `-H "Authorization: Bearer $API_TOKEN"`,
  with an API token from Settings > Security.
- `$BROKER` is the broker service. It listens on the app server's loopback
  only. Every call but `/health` needs `-H "X-Broker-Service-Token: $TOKEN"`.
  The token is not in `.env`; the line above reads it from the backend.
- `$SIDECAR_A` and `$SIDECAR_B` are the two MT5 sidecars. Every call needs
  `-H "X-MT5-Bridge-Secret: ..."` with that sidecar's secret
  (`MT5_BRIDGE_SECRET` in `/etc/mt5-sidecar/demo-a.env` and `demo-b.env` on
  VM 120). `curl -k` skips the certificate check for these hand tests only;
  the app checks the certificate by its fingerprint. For a sidecar without
  TLS, use `http://` and drop `-k`.

---

## Phase 0: Accounts and hosts

### 1. Open two MT5 **demo** accounts at two different brokers

Use different brokers on purpose: the point is to exercise per-connection
symbol resolution and differing lot steps.

**Where:** each broker's website, then each broker's MT5 terminal.

**Before:** nothing.

**Do:** open a demo account at two firms the app reaches through MT5: Axi,
CMC Markets, Eightcap, Vantage, or any firm with no web API, such as a prop firm's free
trial ([INSTALL.md § 4.7](INSTALL.md#47-which-platform-for-which-firm)). Not
OANDA, IC Markets, Pepperstone, FP Markets or Fusion Markets: their MT5
accounts cannot be added to the app. Both accounts must be in **the same
account currency** (USD unless you have a reason otherwise). Mixed
currencies switch the portfolio cap off by design.

Record, for each: the firm, the login, the server name, the server's time
zone, the account currency, and the **exact** EURUSD symbol as the terminal
shows it (`EURUSD`, `EURUSD.a`, `EURUSD_i`, `EURUSDm` and so on). The suffix
matters later; these are `<symbol-a>` and `<symbol-b>`.

**Expected:** you can log in to both terminals and see EURUSD quotes.

**If it fails:** *the firm offers no MT5 demo:* choose another firm from the
list above.

**Done when:** you have two demo logins, at two firms, in the same currency,
and the six facts recorded for each.

### 2. Stand up the terminals and sidecars

One MT5 terminal per account, each logged in and left running, and one
sidecar per terminal: the `MetaTrader5` Python package binds to a single
terminal, so two accounts means two sidecars on two ports.

**Where:** VM 120 console.

**Before:** step 1 is done, and VM 120 exists
([INSTALL.md § 4.2, Create the VM](INSTALL.md#create-the-vm)).

**Do:** install both as in
[INSTALL.md § 4.2](INSTALL.md#42-metatrader-5-vm-120), "Install the terminal
and sidecar": once with `--instance demo-a --port 9100` and account A's
details, and once with `--instance demo-b --port 9101` and account B's. Each
gets a secret and a certificate of its own. Write down both fingerprints. Do
not add the connections in the app yet.

**Expected:** each install ends with a line that starts
`[mt5] check: PASS`.

**If it fails:** as in INSTALL § 4.2. A terminal sitting at a login dialog
(exit 4) is the exact failure the circuit breaker exists for. Note how it
behaves, but fix it before continuing.

**Done when:** both of these print a line that starts `[mt5] check: PASS`:

```bash
bash /root/mt5-sidecar-wine.sh check --instance demo-a
bash /root/mt5-sidecar-wine.sh check --instance demo-b
```

---

## Phase 1: Schema up to date before a second connection

### 3. Confirm the schema is current

The backend applies the schema itself when it starts, and nothing is run by
hand.

**Where:** app shell, then the database server's console (CT 100).

**Before:** the app is running: `./tradingapp.sh doctor` shows
`state: ready`.

**Do:** in the app shell:

```bash
./tradingapp.sh migrate
```

Then, in the CT 100 console:

```bash
runuser -u postgres -- psql -d tradingapp -c "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'order_executions'::regclass AND contype = 'u';"
```

(With the bundled database, run the query in the app shell instead, through
`docker compose -f docker-compose.yml -f docker-compose.db.yml exec -T postgres psql -U tradingapp -d tradingapp -c "..."`.)

**Expected:** `migrate` reports nothing pending. The query shows a row whose
definition is `UNIQUE (broker, broker_account, exec_id)`.

**If it fails:**
- *`migrate` reports pending migrations it cannot apply, or the constraint
  is different:* the app is on an old version. Upgrade it
  ([OPERATIONS.md § Upgrade in place](OPERATIONS.md#upgrade-in-place)) and
  do this step again.
- *Anything else:* send the output of `./tradingapp.sh doctor` and of the
  query. Do **not** go on to step 11. A second account on the old key
  silently drops colliding fills, and widening the constraint afterwards
  recovers nothing, because the rows were never written.

**Done when:** `migrate` reports nothing pending and the query shows
`UNIQUE (broker, broker_account, exec_id)`.

### 4. Confirm the startup guard is armed

**Where:** app shell.

**Before:** step 3 passed.

**Do:**

```bash
docker compose logs backend | grep -c 'refusing to start: unsafe schema for multi-connection'
```

**Expected:** `0`.

**If it fails:** *it prints `1` or more:* step 3 did not take effect. Run
`./tradingapp.sh migrate`, then `./tradingapp.sh restart`, and check again.
If it still appears, send the log line.

**Done when:** the count is `0` and `./tradingapp.sh test` passes for every
service.

---

## Phase 2: Sidecar acceptance against a real terminal

The sidecar's contract is documented at the top of
`broker_service/mt5_adapter.py`, and CI tests it against a simulated
terminal. The checks below prove it against your broker's real terminal,
whose symbols, stop distances and tick values CI cannot know.

Steps 5 to 9 are written for sidecar A. Step 10 repeats them for sidecar B.

### 5. Check the read-side endpoints

`GET /health`, `/symbols`, `/history`, `/quote`, `/tick`, `/positions`,
`/orders`, `/account`, `/deals`, `/symbol`, `/ticks`. Every request carries
`X-MT5-Bridge-Secret`, and the sidecar rejects any without it: anything that
could reach it otherwise could trade the account.

**Where:** app shell (not VM 120, so the network path is tested too).

**Before:** step 2 passed, and the shell variables are set
([Names used in every step](#names-used-in-every-step)).

**Do:**

```bash
H="X-MT5-Bridge-Secret: $SECRET_A"
curl -k -H "$H" $SIDECAR_A/health
curl -k -H "$H" "$SIDECAR_A/symbols?query=EURUSD&limit=20"
curl -k -H "$H" "$SIDECAR_A/history?symbol=<symbol-a>&timeframe=M5&count=10"
curl -k -H "$H" "$SIDECAR_A/symbol?symbol=<symbol-a>"
curl -k -o /dev/null -w '%{http_code}\n' $SIDECAR_A/health
```

Keep the `/symbols` output: it is what symbol resolution will match against.

**Expected:** the first four return data, the first with `"status":"ok"` and
`"account_type":"demo"`. The last prints `401`.

**If it fails:**
- *No answer:* the address or port is wrong, the sidecar is down, or a
  firewall is in the way
  ([INSTALL.md § 4.2](INSTALL.md#check-it-from-the-app-server)).
- *`401` on the first four:* `$SECRET_A` is not that sidecar's secret.
- *`/history` or `/symbol` returns an error naming the symbol:*
  `<symbol-a>` is not the exact name. Take it from the `/symbols` output.

**Done when:** the first four return data and the last prints `401`.

### 6. Check the fields stops and sizing need

The terminal must report these, or the engine refuses rather than guesses:

| Endpoint | Field | Why |
|---|---|---|
| `GET /symbol` | `trade_stops_level`, `point` | Minimum stop distance. The engine refuses a stop inside it rather than sending an order the venue will bounce |
| `GET /symbol` | `trade_tick_value`, `trade_tick_size` | `risk_pct` sizing divides by these. **Without them risk sizing refuses outright** rather than approximating from contract size, which is only correct when quote and account currency match |
| `GET /positions` | `sl`, `tp` per position | The trail compares against what the venue currently holds. Their absence on a protected position is a kill-switch trigger |

**Where:** app shell.

**Before:** step 5 passed.

**Do:**

```bash
curl -k -s -H "$H" "$SIDECAR_A/symbol?symbol=<symbol-a>" | jq '{trade_stops_level, point, trade_tick_value, trade_tick_size}'
```

**Expected:** four numbers. `point`, `trade_tick_value` and
`trade_tick_size` are not zero (`trade_stops_level` may be `0` at a broker
with no minimum distance). `trade_tick_value` is about 1.0 for a standard
EURUSD lot on a USD account.

**If it fails:** *a field is `null`:* send the raw `/symbol` payload. The
adapter reads these defensively under several names and can be widened.

**Done when:** all four are numbers and the three named are not zero.

### 7. Check `POST /orders` with `sl`/`tp`

The order body carries `sl` and `tp` (absolute prices, or null). Two
guarantees, both load-bearing:

- They are attached **atomically with the entry**: one `order_send` with
  SL/TP populated, not an order followed by a modify. The two-call version
  leaves a window where the position is open and unprotected.
- The sidecar **echoes back the `sl`/`tp` the venue actually recorded.** The
  app compares them and flags a mismatch. A silently dropped stop looks the
  same as a working one until it is needed.

**Where:** app shell, then terminal A.

**Before:** step 6 passed, the market is open, and you have read the
current price in terminal A, or with
`curl -k -s -H "$H" "$SIDECAR_A/quote?symbol=<symbol-a>"`.

**Do:** place a 0.01-lot BUY with a stop about 50 pips below the market.
Put that price in place of `1.0800`:

```bash
curl -k -X POST -H "$H" -H 'Content-Type: application/json' \
  -d '{"symbol":"<symbol-a>","action":"BUY","quantity":0.01,"order_type":"MKT","tif":"DAY","sl":1.0800,"tp":null}' \
  $SIDECAR_A/orders
curl -k -s -H "$H" $SIDECAR_A/positions
```

**Expected:** the first reply carries an `order_id` or `ticket` **and** a
`sl` that is not null. Terminal A shows the position with its stop already
attached. `/positions` reports the same `sl`.

**If it fails:**
- *The order is rejected:* most often the stop is inside the broker's
  minimum distance. Try a wider stop and check `trade_stops_level`.
- *The position opens with no stop:* stop here and report it, with both
  replies. Close the position by hand in the terminal.

**Done when:** `/positions` shows the position with the `sl` you sent.

### 8. Check `POST /positions/{symbol}/stop`

MT5's `TRADE_ACTION_SLTP`. Body `{"sl": <price>, "tp": <price|null>}`.

**Where:** app shell, then terminal A.

**Before:** the position from step 7 is still open.

**Do:** move the stop 10 pips closer to the market. Put that price in place
of `1.0810`:

```bash
curl -k -X POST -H "$H" -H 'Content-Type: application/json' \
  -d '{"sl":1.0810,"tp":null}' "$SIDECAR_A/positions/<symbol-a>/stop"
curl -k -s -H "$H" $SIDECAR_A/positions
```

Then close the position by hand in terminal A. Step 15 uses that trade.

**Expected:** `/positions` shows the new `sl`.

**If it fails:** *the move is rejected:* the new stop is inside the minimum
distance, or on the wrong side of the price.

**Done when:** `/positions` showed the new `sl`, and after you close it,
`/positions` no longer lists the position.

### 9. Verify the fills feed

**Where:** app shell.

**Before:** steps 7 and 8 are done.

**Do:**

```bash
curl -k -s -H "$H" "$SIDECAR_A/deals?days=1"
```

Note the **ticket numbers**.

**Expected:** the entry and the exit appear, each with a distinct ticket, a
price and a timestamp.

**If it fails:** *the list is empty:* the trades were made more than a day
ago. Ask again with `days=7`.

**Done when:** both deals are listed. If both accounts later show low,
overlapping ticket numbers, you have seen first-hand the collision that the
step 3 schema fixes.

### 10. Repeat 5 to 9 for the second sidecar

**Where:** app shell, then terminal B.

**Before:** step 9 passed for sidecar A.

**Do:** set `H="X-MT5-Bridge-Secret: $SECRET_B"`, then do steps 5 to 9
again with `$SIDECAR_B` in place of `$SIDECAR_A` and `<symbol-b>` in place
of `<symbol-a>`.

**Expected:** as in each step.

**If it fails:** as in each step.

**Done when:** both sidecars satisfy every check above, on their own ports.

---

## Phase 3: Wire the app to both connections

### 11. Add both connections in the app

**Where:** the app, **Settings > Connections**, then the app shell. A person
enters the two bridge secrets.

**Before:** step 3 passed (do not skip this), and step 10 passed. `.env` has
no MT5 lines:
`grep -c -E '^(BROKER_CONNECTIONS|MT5_BRIDGE_URL|MT5_BRIDGE_SECRET)=' .env`
prints `0`. Such lines still define connections, and for MT5 they win over
the app's connections, which then show as overridden. If it does not print
`0`, remove them and run `./tradingapp.sh install`.

**Do:** [add a connection](INSTALL.md#adding-a-connection) for each account,
with Firm set to the account's firm:

| Field | Account A | Account B |
|---|---|---|
| Name | `broker-a-demo` | `broker-b-demo` |
| Mode | paper | paper |
| Currency | USD | USD |
| Bridge URL | `https://<mt5-address>:9100` | `https://<mt5-address>:9101` |
| Bridge secret | sidecar A's `MT5_BRIDGE_SECRET` | sidecar B's `MT5_BRIDGE_SECRET` |
| Certificate fingerprint | sidecar A's | sidecar B's |
| Server timezone | account A's server zone | account B's server zone |
| Default account for MT5 | on | off |

Then set Base currency (`PORTFOLIO_BASE_CURRENCY`) to `USD` on **Settings >
Risk**, and check, in the app shell:

```bash
curl -s -H "X-Broker-Service-Token: $TOKEN" $BROKER/providers | jq
```

Mode `paper` on both is a **binding constraint**: a live order addressed to
either is refused with a 409.

**Expected:** each connection is tested when you save it and shows as
connected. `/providers` lists both under `connections`, each with
`"broker": true`, `"market_data": true` and `account_mode: paper`, and
`currency.consistent` is `true`.

**If it fails:** the Test result on the connection, or the `error` in the
`/providers` reply, says what is wrong. The usual causes are in
[INSTALL.md § 4.2, Add the connection](INSTALL.md#add-the-connection).

**Done when:** `/providers` shows both connections as above, and the
header's health badge agrees.

### 12. Confirm per-connection routing

**Where:** app shell.

**Before:** step 11 passed.

**Do:**

```bash
curl -s -H "X-Broker-Service-Token: $TOKEN" "$BROKER/account/summary?broker=mt5&account=broker-a-demo"
curl -s -H "X-Broker-Service-Token: $TOKEN" "$BROKER/account/summary?broker=mt5&account=broker-b-demo"
```

**Expected:** two *different* account ids and balances.

**If it fails:** *they match:* both connections point at the same sidecar.
Correct the port in one Bridge URL.

**Done when:** the two replies name two different accounts.

### 13. Confirm symbol resolution across both

**Where:** app shell.

**Before:** step 12 passed.

**Do:**

```bash
curl -s -X POST -H "X-Broker-Service-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"symbol":"EURUSD","targets":[
        {"broker":"mt5","account":"broker-a-demo"},
        {"broker":"mt5","account":"broker-b-demo"}]}' \
  $BROKER/instrument/resolve/preview | jq
```

**Expected:** `resolved: 2`, each with the broker's own native symbol and
its own `spec.size_step`.

**If it fails:** *"ambiguous":* the broker offers several tiers of the pair.
That is working as intended: the connection needs a symbol map, such as
`EURUSD=EURUSD.a`. Add it on the connection form as in
[INSTALL.md § 4.9](INSTALL.md#49-mt5-symbol-map)
and repeat this step. If that is not possible, report it with the `/symbols`
output from step 5.

**Done when:** the reply shows `resolved: 2`.

### 14. Turn on the fleet view

**Where:** the app.

**Before:** step 13 passed.

**Do:** on **Settings > Trading**, turn on `SYSTEMATIC_ENABLED`. On
**Settings > Schedulers and data**, turn on `EXECUTIONS_SYNC_ENABLED`. Leave
`SYSTEMATIC_EXECUTION_ENABLED` off (Settings > Trading): signal-only. Then
open `/systematic`.

**Expected:** both connections appear as cards with `paper` badges and the
correct currency.

**If it fails:** *a red banner:* it names the cause. If it names the schema,
go back to step 3.

**Done when:** both cards show, with no red banner.

---

## Phase 4: Signal-only, then execution

### 15. Confirm the fills feed and reconciliation

The manual trades from steps 7 and 8 should now be ingested.

**Where:** app shell.

**Before:** step 14 passed, and a few minutes have gone by for the fills
sync to run.

**Do:**

```bash
curl -s -H "Authorization: Bearer $API_TOKEN" $BASE/api/account/reconciliation/all | jq
```

**Expected:** both connections listed, `unreachable: 0`. Mismatches are
*expected* here, because those trades belong to no run, but the numbers
match the terminals.

**If it fails:** *a connection is missing or `unreachable` is not 0:* the
fills sync is off (step 14), or that sidecar is down.

**Done when:** both connections are listed with `unreachable: 0`. **This is
the step that proves the C-0 fix:** if both accounts produced deals with the
same ticket number, both are now present as separate rows.

### 16. Deploy one strategy to both connections, signal-only

**Where:** the app, then the app shell.

**Before:** step 15 passed.

**Do:**

1. In the app, create a simple 5-minute definition on canonical `EURUSD`
   (an MA cross is fine), with a holdout start date. Note its id,
   `<definition-id>`.
2. Deploying needs a passing backtest of that definition from the holdout
   date (the promotion gate, see [FEATURES.md](FEATURES.md)). For this
   plumbing test only, set Backtest gate for paper (`PROMOTION_PAPER_GATE`)
   to `off` on **Settings > Strategies**. It skips that check for paper.
3. Deploy, in the app shell:

   ```bash
   curl -s -X POST -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
     -d '{"targets":[
           {"broker":"mt5","account":"broker-a-demo","canary":true,"account_mode":"paper"},
           {"broker":"mt5","account":"broker-b-demo","account_mode":"paper"}],
         "settle_seconds":900}' \
     $BASE/api/strategies/definitions/<definition-id>/deploy | jq
   ```

4. Set `PROMOTION_PAPER_GATE` back to `enforce`.

**Expected:** status 201, one group, two runs: the canary `running`, the
other `pending`. On `/systematic` this shows as **one strategy row with two
legs**, one badged `canary` and one `staged`.

**If it fails:** *the deploy is refused by the promotion gate:* item 2 was
not saved. `GET $BASE/api/strategies/definitions/<definition-id>/promotion`
lists what is missing.

**Done when:** `/systematic` shows the two legs, and
`PROMOTION_PAPER_GATE` reads `enforce` again.

### 17. Watch the canary admit its sibling

**Where:** the app, `/systematic`, and the app shell.

**Before:** step 16 passed.

**Do:** leave it for `settle_seconds` (15 minutes) plus a bar. Then:

```bash
docker compose logs backend | grep -c 'run group admitted'
```

**Expected:** the staged leg flips to `running`, and the count is `1` or
more. Each leg's "Trades as" column shows its **own** native symbol.

**If it fails:** *the group is abandoned instead:* the canary errored. The
reason is on the run row and in the logs. Send it.

**Done when:** both legs show `running`.

### 18. Let it run signal-only for a session

**Where:** the app, `/systematic`.

**Before:** step 17 passed.

**Do:** leave both legs running for one trading session. This is forward
testing: the strategy runs against live data with nothing at risk.

**Expected:** both legs evaluate on schedule (`last_evaluated_at` advancing
about every 5 minutes) and signals are recorded.

**If it fails:** *a leg stops evaluating:* its connection is down. The
connection check and the backend log say why.

**Done when:** a session has passed with signals recorded on both legs and
**no orders placed**.

### 19. Test connection isolation deliberately

**Where:** VM 120 console, then the app shell.

**Before:** step 18 passed, and both legs are running.

**Do:** stop one sidecar, wait three evaluation cycles, and look:

```bash
systemctl stop mt5-sidecar@demo-b      # on VM 120
```

```bash
docker compose logs --since 20m backend | grep 'connection breaker open'      # in the app shell
```

Then start it again: `systemctl start mt5-sidecar@demo-b` on VM 120.

**Expected:** within a few ticks the backend log shows
`connection breaker open — skipping its runs`, and the **other** connection
keeps evaluating on schedule. The app's connection check also shows the
stopped one as down. After the restart it recovers.

**If it fails:** *the healthy connection also stalls:* that is a genuine
failure. Send the timings and the backend log. **This is the step that
proves the bug-3 fix.**

**Done when:** the breaker line appeared, the other leg kept its schedule,
and both legs evaluate again after the restart.

### 20. Enable execution on paper

**Where:** the app, then both terminals.

**Before:** step 19 passed. Both connections are `paper`, and
`LIVE_TRADING_ENABLED` is off and stays off.

**Do:**

1. Add a stop rule to the definition so E-2/E-3 engage, for example:

   ```json
   "stop": { "type": "bar_extreme", "lookback": 2 },
   "sizing": { "type": "risk_pct", "size": 0.5 }
   ```

2. On **Settings > Trading**, turn on `SYSTEMATIC_EXECUTION_ENABLED`.
3. Wait for the first entry.

**Expected:** on the first entry:

- the order appears in both terminals, sized differently per account if
  their lot steps differ;
- **each position has its stop attached immediately**, not a second later;
- `/systematic` shows a `current_stop` per leg.

**If it fails:** *a position appears without a stop:* stop here and report.
That is the `unprotected_position` trigger, and it means step 7's atomicity
is not holding. Turn `SYSTEMATIC_EXECUTION_ENABLED` off and close the
position by hand.

**Done when:** both terminals show the position with its stop, and
`/systematic` shows a `current_stop` on both legs.

### 21. Watch the trail ratchet

**Where:** the app, the terminals, and the app shell.

**Before:** step 20 passed and a position is open in profit.

**Do:** let the position run in profit for several bars. Then:

```bash
docker compose logs backend | grep -c 'trailing stop moved'
```

**Expected:** the stop moves *only* in the protective direction, at most
once per bar, and the count is `1` or more.

**If it fails:** *the stop loosens on a pullback:* stop and report, with the
log lines and the terminal's order history.

**Done when:** the terminal confirms the stop moved and never loosened.

### 22. Confirm the alerting path

**Where:** the app, a terminal, and the app shell. A person supplies the
Telegram token and the monitor's URLs.

**Before:** step 20 passed and a position is open. If
[INSTALL.md step 6](INSTALL.md#6-alerts-and-safety-nets) is done, Telegram
and the dead-man's switch are already set: skip item 1.

**Do:**

1. Set Telegram and the dead-man's switch as in
   [INSTALL.md step 6](INSTALL.md#6-alerts-and-safety-nets).
2. With a position open, remove its stop by hand in the terminal. (Safe,
   and it exercises the real path.) Wait a bar, then put the stop back.
3. Stop the backend, wait for the page, and start it again:

   ```bash
   docker compose stop backend
   ```

   ```bash
   docker compose start backend
   ```

4. Stop the broker service, wait for the page, and start it again:

   ```bash
   docker compose stop broker_service
   ```

   ```bash
   docker compose start broker_service
   ```

**Expected:**
- Item 2: within a bar you receive an `unprotected_position` alert, the same
  condition does **not** alert again every bar, and the alert resolves when
  the stop is back.
- Item 3: you are paged within the monitor's grace period, and the check
  recovers after the start.
- Item 4: the page arrives at once (the fail URL), naming "broker service
  unreachable" in the check's log.

**If it fails:**
- *No Telegram message:* check the bot token and chat id; message the bot
  first.
- *No page:* `curl -s $BASE/api/health | jq .services.heartbeat` must show
  `"last_result": "ok"` while everything is up.

**Done when:** all three alerts arrived, both services are running again
(`./tradingapp.sh test`), and the Getting started checklist on the Settings
page shows alerts as done. (The checklist disappears once all five of its
items are done, so if it is gone, this item is done.)

---

## Phase 5: Observe

### 23. Run for a week, notify-only

This is the evidence-gathering the whole escalation design depends on.

**Where:** the app, over a week.

**Before:** step 22 passed.

**Do:** keep Kill switch action (`KILL_SWITCH_ACTION`, Settings > Alerts and
safety) at `notify` throughout, and record every alert received: for each,
whether it was real, and whether halting would have been the right
response. That judgement is what makes enabling `halt` (E-6) a decision
rather than a hope. During the week, do the four rehearsals below, each when
its **Before** holds.

**Expected:** a week of alerts, each judged.

**If it fails:** *an alert you cannot explain:* send it with the backend log
around its time.

**Done when:** the week has passed, the alert record is written, and each
rehearsal below that applies to you has passed.

#### 23a. Rehearse the equity limits

**Where:** the app.

**Before:** a position is open with a floating loss.

**Do:** set the daily equity loss and drawdown caps for each account on its
own form under **Settings > Connections**. (The fleet-wide defaults,
`CONNECTION_MAX_DAILY_EQUITY_LOSS` and `CONNECTION_MAX_DRAWDOWN`, are on
Settings > Risk.) Set `TRADING_DAY_TIMEZONE` on **Settings > Risk** to the
broker server's zone. Then set a daily limit just below the floating loss of
the open position.

**Expected:** the Fleet panel's equity, day start and drawdown agree with
the terminal. After the limit is set: a "Daily loss limit reached" alert,
and the next entry signal refused.

**If it fails:** *the daily figures roll over at the wrong time:*
`TRADING_DAY_TIMEZONE` is not the server's zone.

**Done when:** the alert arrived, the next entry was refused, and the
position's stop was untouched. Set the limit back to the value you want.

#### 23b. Prop accounts

Only before a funded or evaluation account trades.

**Where:** the app, and the firm's dashboard.

**Before:** you have the firm's rule page: the daily loss basis, static or
trailing max loss, and the initial balance.

**Do:** enter the account's prop rules on its form under **Settings >
Connections**, on the firm's demo account. Set `TRADING_DAY_TIMEZONE` to the
firm's rollover. Add the firm's schedule rules to the same rules JSON:
`news_blackout` with the firm's minutes either side, `weekend` with your
Friday cutoff (before the firm's), and `min_trading_days` for an evaluation.
Check that the backend can reach `NEWS_CALENDAR_URL` (Settings > Schedulers
and data).

**Expected:** the Fleet panel's floors match the firm's dashboard to the
cent, and the panel lists the rules. An entry signal inside the buffer is
refused with "prop daily loss buffer reached". An entry signal within the
window of a high-impact release for the pair is refused with "news blackout"
and the release named. A position left open past the Friday cutoff raises
"Position held into the weekend". The trading-day count matches the firm's
dashboard.

**If it fails:** *entries are refused with "news rule cannot be checked":*
the calendar could not be fetched and the copy held is a day old. Check
outbound HTTPS from the app server.

**Done when:** the floors agree to the cent and each refusal above has been
seen once.

#### 23c. Rehearse halt

Only once the alert record supports relying on it.

**Where:** the app, a terminal, and the app shell.

**Before:** a position is open on one account.

**Do:** set Kill switch action to `halt` on **Settings > Alerts and
safety**, and repeat step 22's stop removal on one account. After the
checks below, press **Resume entries** on the Fleet panel, and run
`./tradingapp.sh restart` once while it is still halted to see that the halt
survives it.

**Expected:** an "Entries halted" alert arrives. The Fleet panel shows that
connection halted and the others not. The trail puts the stop back. No new
entry is placed on that account after its position closes. **Resume
entries** lifts it and the next entry signal trades.

**If it fails:** *another connection is halted too, or the halt is gone
after a restart:* stop and report, with the alerts and the backend log.

**Done when:** all five expected points were seen, and the connection is
resumed.

#### 23d. Rehearse flatten, on paper only

**Where:** the app and a terminal.

**Before:** step 23c passed, and a position is open on one **paper**
account.

**Do:** press **Close all positions** on that account's Fleet card. Only
after that passes, consider Kill switch action `flatten`, and repeat step
22's stop removal.

**Expected:** the terminal shows the position closed, the order is in the
order audit, the connection shows halted ("operator flatten") and the others
not, and no entry is placed until it is resumed. With `flatten` set, the
alert reads "Entries halted and positions closed".

**If it fails:** *a "FLATTEN INCOMPLETE" alert:* a close at market failed.
Close the rest in the terminal, then resume.

**Done when:** the position is closed, the audit shows the order, and the
connection is resumed.

### 24. Report back

**Where:** wherever you report to the person who asked for the run.

**Before:** steps 1 to 23 are done, or one has failed.

**Do:** send: each step number with `PASS` or `FAIL`; for each failure, the
command and its raw output; the `/symbols` payloads from both brokers;
`trade_tick_value` for each; and the alert record from step 23. Send no
secret: no bridge secret, token or password.

**Expected:** nothing.

**If it fails:** nothing is known to fail here.

**Done when:** the report is sent.

---

## Things worth knowing before you start

- **Both accounts are `paper`.** Even with everything enabled, a live order
  is refused with a 409 by the registry. Moving to live is a deliberate
  change of the connection's Mode plus `LIVE_TRADING_ENABLED`, not an
  accident away.
- **`risk_pct` refuses rather than guessing.** If step 6's tick fields are
  missing, sizing declines instead of approximating. That is intentional:
  approximating is wrong by the FX rate on any pair not quoted in your
  account currency, and wrong silently.
- **Session times are broker-local.** Each broker's server clock is recorded
  but not normalised (C-P1). With both on the same offset this will not bite.
  If you later add a broker on a different one, session windows will differ
  between legs.
- **Reversal is refused.** A long-to-short signal while long returns a reason
  rather than flipping. Flat is always visited in between (E-P1).
