# Paper Deployment Runbook: Two MT5 Demo Accounts

**Purpose:** get Components C and E running end to end against two real MT5
demo accounts, with auto-execution **off** for most of it and the kill switch
in notify-only throughout. The app itself is commissioned with
`./tradingapp.sh install`. This runbook covers what sits around it: broker
accounts, the MT5 terminals and sidecars on their own hosts, and the
settings to turn on in the app.

**How to use it:** work top to bottom. Each step has a **verify** command or
observation and an explicit pass condition. Report `PASS` / `FAIL` per step
number. On a `FAIL`, the "if it fails" note usually says what to send back.

**Do not skip the ordering.** Step 3 (the schema is up to date) must pass
before step 11 adds a second connection. Fixing the schema afterwards cannot
recover fills that were already dropped.

**Where settings live.** Switches such as `SYSTEMATIC_ENABLED` are set on the
app's Settings page, on the tab named in each step. Each setting shows its
key there. A key can still be pinned in `.env`: the page then shows it as
locked, and `.env` wins. Prefer the page.

Notation: `{BASE}` is the backend URL (e.g. `http://localhost:4000`),
`{BROKER}` the broker service (e.g. `http://localhost:8000`), `{SIDECAR}` an
MT5 sidecar (e.g. `http://10.7.3.22:9100`).

Calls to `{BROKER}` other than `/health` need the broker service token in an
`X-Broker-Service-Token` header. The token is not in `.env`; read it on the
app host with:
```bash
TOKEN=$(docker compose exec -T backend cat /run/tradingapp/broker_service_token)
```
and add `-H "X-Broker-Service-Token: $TOKEN"` to those `curl` commands. The
broker service listens on loopback only, so run them on the app host.

---

## Phase 0: Accounts and hosts

### 1. Open two MT5 **demo** accounts at two different brokers
Use different brokers on purpose: the point is to exercise per-connection
symbol resolution and differing lot steps. IC Markets, Pepperstone, FTMO free
trial, XM and Exness are all fine. Both must be in **the same account
currency** (USD unless you have a reason otherwise). Mixed currencies switch
the portfolio cap off by design.

**Verify:** you can log in to both terminals and see EURUSD quotes.
**Pass:** two demo logins, two brokers, same currency.
**Record:** for each, the broker name, login, server name, account currency,
and the **exact** EURUSD symbol as the terminal shows it (`EURUSD`,
`EURUSD.a`, `EURUSD_i`, `EURUSDm` and so on). The suffix matters later.

### 2. Stand up the Windows host(s)
One MT5 terminal per account, each logged in and left running. One sidecar
process per terminal: the `MetaTrader5` Python package binds to a single
terminal, so two accounts means two processes on two ports.

**Verify:** both terminals show "connected" in the bottom-right status bar.
**Pass:** two terminals, both connected, both left running.
**If it fails:** a terminal sitting at a login dialog is the exact failure the
circuit breaker exists for. Note how it behaves, but fix it before
continuing.

---

## Phase 1: Schema up to date before a second connection

### 3. Confirm the schema is current
The backend applies the schema itself when it starts, and nothing is run by
hand. To bring an existing host up to date:

```bash
git pull && ./tradingapp.sh install
./tradingapp.sh migrate     # shows the state; applies anything pending
```

**Verify:**
```sql
SELECT conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conrelid = 'order_executions'::regclass AND contype = 'u';
```
**Pass:** `./tradingapp.sh migrate` reports nothing pending, and you see
`UNIQUE (broker, broker_account, exec_id)`.
**If it fails:** send the output of `./tradingapp.sh doctor` and the query.
Do **not** proceed to step 11. A second account on the old key silently drops
colliding fills, and widening the constraint afterwards recovers nothing
because the rows were never written.

### 4. Confirm the startup guard is armed
Check the backend logs (`./tradingapp.sh logs`).

**Pass:** no `refusing to start: unsafe schema for multi-connection` error, and
the systematic services start normally.
**If it fails:** step 3 did not take effect. Send the log line.

---

## Phase 2: Sidecar (the real work)

The sidecar is in the repo at `mt5_sidecar/`. Its
[README](mt5_sidecar/README.md) covers installing it on Windows or on Linux
under Wine. The contract it implements is documented at the top of
`broker_service/mt5_adapter.py`. The checks below are the acceptance tests
against a real terminal.

Each sidecar needs its own secret (`MT5_BRIDGE_SECRET` in its `sidecar.env`).
Pick it yourself, for example with `openssl rand -hex 32`, and keep it: you
enter the same value in the app in step 11. Nothing generates it for you.

### 5. Implement the read-side endpoints
`GET /health`, `/symbols`, `/history`, `/quote`, `/tick`, `/positions`,
`/orders`, `/account`, `/deals`, `/symbol`. All requests carry
`X-MT5-Bridge-Secret`. **Reject requests without it.** Anything that can
reach the sidecar can otherwise trade the account.

**Verify (from the app host, not the Windows box, so you test the network
path too):**
```bash
curl -H "X-MT5-Bridge-Secret: $SECRET" {SIDECAR}/health
curl -H "X-MT5-Bridge-Secret: $SECRET" "{SIDECAR}/symbols?query=EURUSD&limit=20"
curl -H "X-MT5-Bridge-Secret: $SECRET" "{SIDECAR}/history?symbol=EURUSD.a&timeframe=M5&count=10"
curl -H "X-MT5-Bridge-Secret: $SECRET" "{SIDECAR}/symbol?symbol=EURUSD.a"
curl {SIDECAR}/health          # no header: must be rejected
```
**Pass:** the first four return data; the last returns 401/403.
**Record:** the `/symbols` output for each connection. That is what symbol
resolution will match against.

### 6. Add the fields E-2/E-3/E-4 need
These are additions to endpoints you already have, and they are the reason
this phase exists rather than reusing an older sidecar:

| Endpoint | Field | Why |
|---|---|---|
| `GET /symbol` | `trade_stops_level`, `point` | Minimum stop distance. The engine refuses a stop inside it rather than sending an order the venue will bounce |
| `GET /symbol` | `trade_tick_value`, `trade_tick_size` | `risk_pct` sizing divides by these. **Without them risk sizing refuses outright** rather than approximating from contract size, which is only correct when quote and account currency match |
| `GET /positions` | `sl`, `tp` per position | The trail compares against what the venue currently holds. Their absence on a protected position is a kill-switch trigger |

**Verify:** `/symbol?symbol=EURUSD.a` returns all four numeric fields, non-zero.
**Pass:** all four present. `trade_tick_value` should be about 1.0 for a
standard EURUSD lot on a USD account.
**If it fails:** send the raw `/symbol` payload. The adapter reads these
defensively under several names and can be widened.

### 7. Implement `POST /orders` with `sl`/`tp`
The order body carries `sl` and `tp` (absolute prices, or null).

**Two requirements, both load-bearing:**
- Attach them **atomically with the entry**: one `order_send` with SL/TP
  populated, not an order followed by a modify. The two-call version leaves a
  window where the position is open and unprotected.
- **Echo back the `sl`/`tp` the venue actually recorded.** The app compares
  them and flags a mismatch. A silently dropped stop looks the same as a
  working one until it is needed.

**Verify:** place a 0.01-lot BUY with an `sl` about 50 pips below market:
```bash
curl -X POST -H "X-MT5-Bridge-Secret: $SECRET" -H 'Content-Type: application/json' \
  -d '{"symbol":"EURUSD.a","action":"BUY","quantity":0.01,"order_type":"MKT","tif":"DAY","sl":1.0800,"tp":null}' \
  {SIDECAR}/orders
```
**Pass:** the response carries an `order_id`/`ticket` **and** a non-null
`sl`; the terminal shows the position with its stop already attached;
`GET /positions` reports the same `sl`.
**If it fails:** the most common cause is the broker rejecting a stop inside
its minimum distance. Try a wider stop and check `trade_stops_level`.

### 8. Implement `POST /positions/{symbol}/stop`
MT5's `TRADE_ACTION_SLTP`. Body `{"sl": <price>, "tp": <price|null>}`.

**Verify:** with the position from step 7 still open, move the stop 10 pips
closer to market and re-read `/positions`.
**Pass:** the new `sl` is reflected. Then close the position by hand in the
terminal. You will use that in step 15.

### 9. Verify the fills feed
**Verify:** `GET /deals?days=1` after the trades above.
**Pass:** the entry and exit appear, each with a distinct ticket, a price and
a timestamp. Note the **ticket numbers**. If both accounts show low,
overlapping numbers, you have just seen first-hand the collision that the
step 3 schema fixes.

### 10. Repeat 5 to 9 for the second sidecar
**Pass:** both sidecars satisfy every check above, on their own ports.

---

## Phase 3: Wire the app to both connections

### 11. Add both connections in the app
On Settings > Connections, add an MT5 connection for each account:

| Field | Account A | Account B |
|---|---|---|
| Name | `broker-a-demo` | `broker-b-demo` |
| Mode | paper | paper |
| Currency | USD | USD |
| Bridge URL | `http://10.7.3.22:9100` | `http://10.7.3.23:9100` |
| Bridge secret | sidecar A's `MT5_BRIDGE_SECRET` | sidecar B's `MT5_BRIDGE_SECRET` |
| Default account for MT5 | on | off |

Each connection is tested when you save it. Then set Base currency
(`PORTFOLIO_BASE_CURRENCY`) to `USD` on Settings > Risk.

**Check `.env` has no MT5 lines.** `BROKER_CONNECTIONS`, `MT5_BRIDGE_URL` or
`MT5_BRIDGE_SECRET` in `.env` still define connections, and for MT5 they win
over the app's connections, which then show as overridden.
`./tradingapp.sh install` and `./tradingapp.sh doctor` report any broker lines
still there. Remove them and re-run `./tradingapp.sh install`.

Note Mode `paper` on both. That is a **binding constraint**: a live order
addressed to either is refused with a 409.

**Verify:** `curl {BROKER}/providers` (with the token, see Notation). The
Test button on each connection and the header health badge give the same
answer in the app.
**Pass:** both connections listed under `connections`, each with
`"broker": true`, `"market_data": true`, `account_mode: paper`, and
`currency.consistent: true`.
**If it fails:** the Test result on the connection, or the `error` in the
response, says what is wrong. Send that.

### 12. Confirm per-connection routing
```bash
curl "{BROKER}/account/summary?broker=mt5&account=broker-a-demo"
curl "{BROKER}/account/summary?broker=mt5&account=broker-b-demo"
```
**Pass:** two *different* account ids and balances. If they match, both
connections point at the same sidecar.

### 13. Confirm symbol resolution across both
```bash
curl -X POST -H 'Content-Type: application/json' \
  -d '{"symbol":"EURUSD","targets":[
        {"broker":"mt5","account":"broker-a-demo"},
        {"broker":"mt5","account":"broker-b-demo"}]}' \
  {BROKER}/instrument/resolve/preview
```
**Pass:** `resolved: 2`, each with the broker's own native symbol and its own
`spec.size_step`.
**If it fails with "ambiguous":** the broker offers several tiers of the
pair. That is working as intended: the connection needs a symbol map, such
as `{"EURUSD": "EURUSD.a"}`. The connection form on Settings > Connections
has no symbol map field yet. Report it, with the `/symbols` output from
step 5.

### 14. Turn on the fleet view
On Settings > Trading, turn on `SYSTEMATIC_ENABLED`. On Settings > Schedulers
and data, turn on `EXECUTIONS_SYNC_ENABLED`. Leave
`SYSTEMATIC_EXECUTION_ENABLED` off (Settings > Trading): signal-only.

**Verify:** open `/systematic`.
**Pass:** both connections appear as cards with `paper` badges and the
correct currency, and there are no red banners.

---

## Phase 4: Signal-only, then execution

### 15. Confirm the fills feed and reconciliation
The manual trades from steps 7 and 8 should now be ingested.

**Verify:** `curl {BASE}/api/account/reconciliation/all`
**Pass:** both connections listed, `unreachable: 0`. Mismatches are
*expected* here, because those trades belong to no run, but the numbers
should match the terminals.
**This is the step that proves the C-0 fix.** If both accounts produced deals
with the same ticket number, both should now be present as separate rows.

### 16. Deploy one strategy to both connections, signal-only
Create a simple 5-minute definition on canonical `EURUSD` (an MA cross is
fine), with a holdout start date. Deploying needs a passing backtest of that
definition from the holdout date (the promotion gate, see
[FEATURES.md](FEATURES.md)). For this plumbing test only, set Backtest gate
for paper (`PROMOTION_PAPER_GATE`) to `off` on Settings > Strategies. It
skips that check for paper. Set it back to `enforce` afterwards. Then:
```bash
curl -X POST -H 'Content-Type: application/json' \
  -d '{"targets":[
        {"broker":"mt5","account":"broker-a-demo","canary":true,"account_mode":"paper"},
        {"broker":"mt5","account":"broker-b-demo","account_mode":"paper"}],
      "settle_seconds":900}' \
  {BASE}/api/strategies/definitions/{ID}/deploy
```
**Pass:** 201, one group, two runs: the canary `running`, the other
`pending`. On `/systematic` this shows as **one strategy row with two legs**,
one badged `canary` and one `staged`.

### 17. Watch the canary admit its sibling
Leave it for `settle_seconds` (15 min) plus a bar.

**Pass:** the staged leg flips to `running`, and the backend logs show
`run group admitted`. Each leg's "Trades as" column shows its **own** native
symbol.
**If the group is abandoned instead:** the canary errored. The reason is on
the run row and in the logs. Send it.

### 18. Let it run signal-only for a session
**Pass:** both legs evaluate on schedule (`last_evaluated_at` advancing about
every 5 min), signals are recorded, and **no orders are placed**. This is
forward testing: the strategy runs against live data with nothing at risk.

### 19. Test connection isolation deliberately
Stop one sidecar process (or close its terminal).

**Pass:** within a few ticks, the backend logs show
`connection breaker open — skipping its runs`, and the **other** connection
keeps evaluating on schedule. The app's connection check also shows the
stopped one as down. Restart the sidecar and confirm it recovers.
**This is the step that proves the bug-3 fix.** If the healthy connection
also stalls, that is a genuine failure. Send timings.

### 20. Enable execution on paper
On Settings > Trading, turn on `SYSTEMATIC_EXECUTION_ENABLED`. Both
connections are `paper`, and `LIVE_TRADING_ENABLED` stays off.

Add a stop rule to the definition so E-2/E-3 engage, e.g.:
```json
"stop": { "type": "bar_extreme", "lookback": 2 },
"sizing": { "type": "risk_pct", "size": 0.5 }
```
**Pass on the first entry:**
- the order appears in both terminals, sized differently per account if their
  lot steps differ
- **each position has its stop attached immediately**, not a second later
- `/systematic` shows a `current_stop` per leg

**If the position appears without a stop:** stop here and report. That is
the `unprotected_position` trigger, and it means step 7's atomicity is not
holding.

### 21. Watch the trail ratchet
Let a position run in profit for several bars.

**Pass:** the stop moves *only* in the protective direction, at most once per
bar, and the logs show `trailing stop moved`. Confirm in the terminal that it
never loosens on a pullback.

### 22. Confirm the alerting path
On Settings > Alerts and safety, set `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID`. Create a bot with @BotFather, then get the chat id by
messaging it and reading
`https://api.telegram.org/bot<TOKEN>/getUpdates`.

**Verify (safe, and exercises the real path):** with a position open, remove
its stop by hand in the terminal.
**Pass:** within a bar you receive an `unprotected_position` alert, and the
same condition does **not** re-alert every bar afterwards.
**Then:** put the stop back and confirm the alert resolves.

**Dead-man's switch:** create a check on a monitor off the Proxmox host
(healthchecks.io: period 1 minute, grace 5 minutes, alerts to your phone).
Set `HEARTBEAT_URL` and `HEARTBEAT_FAIL_URL` on Settings > Alerts and safety.
`/api/health` shows `heartbeat.last_result: ok` and the check turns green.
**Verify:** stop the backend container.
**Pass:** you are paged within the grace period. Start it again and the check
recovers. Then stop the broker service instead: the page arrives at once
(the fail URL), naming "broker service unreachable" in the check's log.

The "Getting started" checklist on the Settings page should now show
alerts as done.

---

## Phase 5: Observe

### 23. Run for a week, notify-only
Keep Kill switch action (`KILL_SWITCH_ACTION`, Settings > Alerts and safety)
at `notify` throughout. This is the evidence-gathering the whole escalation
design depends on.

**Record:** every alert received, and for each, whether it was real and
whether halting would have been the right response. That judgement is what
makes enabling `halt` (E-6) a decision rather than a hope.

**Equity limits:** set the daily equity loss and drawdown caps for each
account on its own form under Settings > Connections. (The fleet-wide
defaults, `CONNECTION_MAX_DAILY_EQUITY_LOSS` and `CONNECTION_MAX_DRAWDOWN`,
are on Settings > Risk.) Set `TRADING_DAY_TIMEZONE` on Settings > Risk to the
broker server's zone. Check that the Fleet panel's equity, day start and
drawdown agree with the terminal. To rehearse, set a daily limit just below
the floating loss of an open position. **Pass:** a "Daily loss limit
reached" alert, the next entry signal refused, and the position's stop
untouched.

**Prop accounts:** before a funded or evaluation account trades, enter its
prop rules on its form under Settings > Connections, from the firm's rule
page (daily loss basis, static or trailing max loss, the initial balance).
Set `TRADING_DAY_TIMEZONE` to the firm's rollover. On the firm's demo
account, check that the Fleet panel's floors match what the firm's dashboard
shows. **Pass:** floors agree to the cent, and an entry signal inside the
buffer is refused with "prop daily loss buffer reached".

Add the firm's schedule rules to the same rules JSON: `news_blackout` with
the firm's minutes either side, `weekend` with your Friday cutoff (before the
firm's), and `min_trading_days` for an evaluation. Check that the backend can
reach `NEWS_CALENDAR_URL` (Settings > Schedulers and data): the Fleet panel
lists the rules, and an unreachable calendar shows up as entries refused with
"news rule cannot be checked" once the copy held is a day old. **Pass:** an
entry signal within the window of a high-impact release for the pair is
refused with "news blackout" and the release named; a position left open
past the Friday cutoff raises "Position held into the weekend"; the
trading-day count matches the firm's dashboard.

**Once the record supports it, rehearse halt before relying on it:** set Kill
switch action to `halt` on Settings > Alerts and safety, and repeat step 22's
stop removal on one account.
**Pass:** an "Entries halted" alert arrives; the Fleet panel shows that
connection halted and the others not; the trail puts the stop back; no new
entry is placed on that account after its position closes; **Resume
entries** on the Fleet panel lifts it and the next entry signal trades. A
halt survives a backend restart, so check it is still shown after
`./tradingapp.sh restart`.

**Then rehearse flatten, on paper only:** with a position open on one
account, press **Close all positions** on its Fleet card. **Pass:** the
terminal shows the position closed, the order is in the order audit, the
connection shows halted ("operator flatten") and the others not, and no
entry is placed until it is resumed. Only after that, consider Kill switch
action `flatten` and repeat step 22's stop removal: the alert reads "Entries
halted and positions closed".

### 24. Report back
Most useful: which steps failed and their raw output; the `/symbols` payloads
from both brokers; `trade_tick_value` for each; and the alert log from step
23.

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
