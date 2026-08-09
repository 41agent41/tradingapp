# Paper Deployment Runbook — Two MT5 Demo Accounts

**Purpose:** get Components C and E running end-to-end against two real MT5
demo accounts, with auto-execution **off** for most of it and the kill switch
in notify-only throughout. Everything here is outside the application
repository: sidecar code on a Windows host, broker accounts, and configuration.

**How to use it:** work top to bottom. Each step has a **verify** command or
observation and an explicit pass condition. Report `PASS` / `FAIL` per step
number — on a `FAIL`, the "if it fails" note usually says what to send back.

**Do not skip the ordering.** Step 3 (the schema migration) must land before
step 6 (a second connection). Applying it afterwards cannot recover fills that
were already dropped.

Notation: `{BASE}` is the backend URL (e.g. `http://localhost:4000`),
`{BROKER}` the broker service (e.g. `http://localhost:8000`), `{SIDECAR}` an
MT5 sidecar (e.g. `http://10.7.3.22:9100`).

---

## Phase 0 — Accounts and hosts

### 1. Open two MT5 **demo** accounts at two different brokers
Different brokers, deliberately — the point is to exercise per-connection
symbol resolution and differing lot steps. IC Markets, Pepperstone, FTMO free
trial, XM, Exness are all fine. Both must be **the same account currency**
(USD unless you have a reason otherwise); mixed currencies switch the portfolio
cap off by design.

**Verify:** you can log into both terminals and see EURUSD quotes.
**Pass:** two demo logins, two brokers, same currency.
**Record:** for each — broker name, login, server name, account currency, and
the **exact** EURUSD symbol as the terminal shows it (`EURUSD`, `EURUSD.a`,
`EURUSD_i`, `EURUSDm`, …). The suffix matters later.

### 2. Stand up the Windows host(s)
One MT5 terminal per account, each logged in and left running. One sidecar
process per terminal — the `MetaTrader5` Python package binds to a single
terminal, so two accounts means two processes on two ports.

**Verify:** both terminals show "connected" in the bottom-right status bar.
**Pass:** two terminals, both connected, both left running.
**If it fails:** a terminal sitting at a login dialog is the exact failure the
circuit breaker exists for — worth noting how it behaves, but fix it before
continuing.

---

## Phase 1 — Migrate before you add a second connection

### 3. Apply the schema migration
Run the current `backend/src/database/timescaledb-schema.sql` against your
database. It is idempotent.

**Verify:**
```sql
SELECT conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conrelid = 'order_executions'::regclass AND contype = 'u';
```
**Pass:** you see `UNIQUE (broker, broker_account, exec_id)`.
**If it fails:** send the output. Do **not** proceed to step 6 — a second
account on the old key silently drops colliding fills, and widening the
constraint afterwards recovers nothing because the rows were never written.

### 4. Confirm the startup guard is armed
Restart the backend and check the logs.

**Pass:** no `refusing to start: unsafe schema for multi-connection` error, and
the systematic services start normally.
**If it fails:** step 3 did not take effect; send the log line.

---

## Phase 2 — Sidecar (the real work)

The full contract is documented at the top of
`broker_service/mt5_adapter.py`. Build against that; the checks below are the
acceptance tests.

### 5. Implement the read-side endpoints
`GET /health`, `/symbols`, `/history`, `/quote`, `/tick`, `/positions`,
`/orders`, `/account`, `/deals`, `/symbol`. All requests carry
`X-MT5-Bridge-Secret` when a secret is configured; **reject requests without
it** — anything that can reach the sidecar can otherwise trade the account.

**Verify (from the app host, not the Windows box — you are testing the network
path too):**
```bash
curl -H "X-MT5-Bridge-Secret: $SECRET" {SIDECAR}/health
curl -H "X-MT5-Bridge-Secret: $SECRET" "{SIDECAR}/symbols?query=EURUSD&limit=20"
curl -H "X-MT5-Bridge-Secret: $SECRET" "{SIDECAR}/history?symbol=EURUSD.a&timeframe=M5&count=10"
curl -H "X-MT5-Bridge-Secret: $SECRET" "{SIDECAR}/symbol?symbol=EURUSD.a"
curl {SIDECAR}/health          # no header — must be rejected
```
**Pass:** first four return data; the last returns 401/403.
**Record:** the `/symbols` output for each connection — that is what symbol
resolution will match against.

### 6. Add the fields E-2/E-3/E-4 need
These are additions to endpoints you already have, and they are the reason
this phase exists rather than reusing an older sidecar:

| Endpoint | Field | Why |
|---|---|---|
| `GET /symbol` | `trade_stops_level`, `point` | Minimum stop distance — the engine refuses a stop inside it rather than sending an order the venue will bounce |
| `GET /symbol` | `trade_tick_value`, `trade_tick_size` | `risk_pct` sizing divides by these. **Without them risk sizing refuses outright** rather than approximating from contract size, which is only correct when quote and account currency match |
| `GET /positions` | `sl`, `tp` per position | The trail compares against what the venue currently holds; their absence on a protected position is a kill-switch trigger |

**Verify:** `/symbol?symbol=EURUSD.a` returns all four numeric fields, non-zero.
**Pass:** all four present. `trade_tick_value` should be ≈ 1.0 for a standard
EURUSD lot on a USD account.
**If it fails:** send the raw `/symbol` payload — the adapter reads these
defensively under several names and I can widen it.

### 7. Implement `POST /orders` with `sl`/`tp`
The order body now carries `sl` and `tp` (absolute prices, or null).

**Two requirements, both load-bearing:**
- Attach them **atomically with the entry** — one `order_send` with SL/TP
  populated, not an order followed by a modify. The two-call version leaves a
  window where the position is open and unprotected.
- **Echo back the `sl`/`tp` the venue actually recorded.** The app compares
  them and flags a mismatch; a silently-dropped stop is indistinguishable from
  a working one until it is needed.

**Verify:** place a 0.01-lot BUY with an `sl` ~50 pips below market:
```bash
curl -X POST -H "X-MT5-Bridge-Secret: $SECRET" -H 'Content-Type: application/json' \
  -d '{"symbol":"EURUSD.a","action":"BUY","quantity":0.01,"order_type":"MKT","tif":"DAY","sl":1.0800,"tp":null}' \
  {SIDECAR}/orders
```
**Pass:** response carries an `order_id`/`ticket` **and** a non-null `sl`; the
terminal shows the position with its stop already attached; `GET /positions`
reports the same `sl`.
**If it fails:** the most common cause is the broker rejecting a stop inside
its minimum distance — try a wider stop and check `trade_stops_level`.

### 8. Implement `POST /positions/{symbol}/stop`
MT5's `TRADE_ACTION_SLTP`. Body `{"sl": <price>, "tp": <price|null>}`.

**Verify:** with the position from step 7 still open, move the stop 10 pips
closer to market and re-read `/positions`.
**Pass:** the new `sl` is reflected. Then close the position by hand in the
terminal — you will use that in step 15.

### 9. Verify the fills feed
**Verify:** `GET /deals?days=1` after the trades above.
**Pass:** the entry and exit appear, each with a distinct ticket, a price, and
a timestamp. Note the **ticket numbers** — if both accounts show low,
overlapping numbers, you have just demonstrated first-hand the collision that
step 3 fixes.

### 10. Repeat 5–9 for the second sidecar
**Pass:** both sidecars satisfy every check above, on their own ports.

---

## Phase 3 — Wire the app to both connections

### 11. Write the connection manifest
In the app host's `.env` (see the commented block in `.env.example`):
```bash
BROKER_CONNECTIONS='[
  {"id":"broker-a-demo","platform":"mt5","url":"http://10.7.3.22:9100",
   "secret_env":"MT5_SECRET_A","account_mode":"paper","currency":"USD","default":true},
  {"id":"broker-b-demo","platform":"mt5","url":"http://10.7.3.23:9100",
   "secret_env":"MT5_SECRET_B","account_mode":"paper","currency":"USD"}
]'
MT5_SECRET_A=...
MT5_SECRET_B=...
PORTFOLIO_BASE_CURRENCY=USD
```
**Unset `MT5_BRIDGE_URL` and `MT5_BRIDGE_SECRET`** if they are set — the
manifest alongside a legacy variable is a deliberate startup error, because
supporting both needs a precedence rule and guessing wrong routes orders to
the wrong account.

Note `account_mode: paper` on both. That is a **binding constraint**: a live
order addressed to either is refused with a 409.

**Verify:** `curl {BROKER}/providers`
**Pass:** both connections listed under `connections`, each with
`"broker": true`, `"market_data": true`, `account_mode: paper`, and
`currency.consistent: true`.
**If it fails:** the response includes an `error` describing the manifest
problem — send that.

### 12. Confirm per-connection routing
```bash
curl "{BROKER}/account/summary?broker=mt5&account=broker-a-demo"
curl "{BROKER}/account/summary?broker=mt5&account=broker-b-demo"
```
**Pass:** two *different* account ids / balances. If they match, both
connections are pointed at the same sidecar.

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
**If it fails with "ambiguous":** the broker offers several tiers of the pair.
That is working as intended — add a `symbol_map` to that connection's manifest
entry, e.g. `"symbol_map": {"EURUSD": "EURUSD.a"}`, and re-check.

### 14. Turn on the fleet view
`SYSTEMATIC_ENABLED=true`, `EXECUTIONS_SYNC_ENABLED=true`. Leave
`SYSTEMATIC_EXECUTION_ENABLED=false` — signal-only.

**Verify:** open `/systematic`.
**Pass:** both connections appear as cards with `paper` badges and correct
currency; no red banners.

---

## Phase 4 — Signal-only, then execution

### 15. Confirm the fills feed and reconciliation
The manual trades from steps 7–8 should now be ingested.

**Verify:** `curl {BASE}/api/account/reconciliation/all`
**Pass:** both connections listed, `unreachable: 0`. Mismatches are *expected*
here — those trades belong to no run — but the numbers should match the
terminals.
**This is the step that proves the C-0 fix.** If both accounts produced deals
with the same ticket number, both should now be present as separate rows.

### 16. Deploy one strategy to both connections, signal-only
Create a simple 5-minute definition on canonical `EURUSD` (an MA cross is
fine), then:
```bash
curl -X POST -H 'Content-Type: application/json' \
  -d '{"targets":[
        {"broker":"mt5","account":"broker-a-demo","canary":true,"account_mode":"paper"},
        {"broker":"mt5","account":"broker-b-demo","account_mode":"paper"}],
      "settle_seconds":900}' \
  {BASE}/api/strategies/definitions/{ID}/deploy
```
**Pass:** 201, one group, two runs — the canary `running`, the other
`pending`. On `/systematic` this shows as **one strategy row with two legs**,
one badged `canary` and one `staged`.

### 17. Watch the canary admit its sibling
Leave it for `settle_seconds` (15 min) plus a bar.

**Pass:** the staged leg flips to `running`; backend logs show
`run group admitted`. Each leg's "Trades as" column shows its **own** native
symbol.
**If the group is abandoned instead:** the canary errored. The reason is on the
run row and in the logs — send it.

### 18. Let it run signal-only for a session
**Pass:** both legs evaluate on schedule (`last_evaluated_at` advancing every
~5 min), signals recorded, **no orders placed**. This is forward testing: the
strategy is running against live data with nothing at risk.

### 19. Test connection isolation deliberately
Stop one sidecar process (or close its terminal).

**Pass:** within a few ticks, backend logs show
`connection breaker open — skipping its runs`; the **other** connection keeps
evaluating on schedule. Restart the sidecar and confirm it recovers.
**This is the step that proves the bug-③ fix.** If the healthy connection also
stalls, that is a genuine failure — send timings.

### 20. Enable execution on paper
Set `SYSTEMATIC_EXECUTION_ENABLED=true`. Both connections are `paper` and
`LIVE_TRADING_ENABLED` stays false.

Add a stop rule to the definition so E-2/E-3 engage, e.g.:
```json
"stop": { "type": "bar_extreme", "lookback": 2 },
"sizing": { "type": "risk_pct", "size": 0.5 }
```
**Pass on the first entry:**
- the order appears in both terminals, sized differently per account if their
  lot steps differ
- **each position has its stop attached immediately** — not a second later
- `/systematic` shows a `current_stop` per leg

**If the position appears without a stop:** stop here and report. That is the
`unprotected_position` trigger and it means step 7's atomicity is not holding.

### 21. Watch the trail ratchet
Let a position run in profit for several bars.

**Pass:** the stop moves *only* in the protective direction, at most once per
bar; logs show `trailing stop moved`. Confirm in the terminal that it never
loosens on a pullback.

### 22. Confirm the alerting path
Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (create a bot with
@BotFather; get the chat id by messaging it and reading
`https://api.telegram.org/bot<TOKEN>/getUpdates`).

**Verify (safe, and exercises the real path):** with a position open, remove
its stop by hand in the terminal.
**Pass:** within a bar you receive an `unprotected_position` alert, and the
same condition does **not** re-alert every bar afterwards.
**Then:** put the stop back and confirm the alert resolves.

---

## Phase 5 — Observe

### 23. Run for a week, notify-only
`KILL_SWITCH_ACTION=notify` throughout. This is the evidence-gathering the
whole escalation design depends on.

**Record:** every alert received, and for each — was it real, and would
halting have been the right response? That judgement is what makes enabling
`halt` (E-6) a decision rather than a hope.

### 24. Report back
Most useful to me: which steps failed and their raw output; the `/symbols`
payloads from both brokers; `trade_tick_value` for each; and the alert log
from step 23.

---

## Things worth knowing before you start

- **Both accounts are `paper`.** Even with everything enabled, a live order is
  refused with a 409 by the registry. Moving to live is a deliberate manifest
  change plus `LIVE_TRADING_ENABLED`, not an accident away.
- **`risk_pct` refuses rather than guessing.** If step 6's tick fields are
  missing, sizing declines instead of approximating. That is intentional —
  approximating is wrong by the FX rate on any pair not quoted in your account
  currency, and wrong silently.
- **Session times are broker-local.** Each broker's server clock is recorded
  but not normalised (C-P1). With both on the same offset this will not bite;
  if you later add a broker on a different one, session windows will differ
  between legs.
- **Reversal is refused.** A long→short signal while long returns a reason
  rather than flipping. Flat is always visited in between (E-P1).
