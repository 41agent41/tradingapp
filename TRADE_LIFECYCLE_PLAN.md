# Trade Lifecycle — Direction, Broker-Side Stops, Sizing, and the Kill Switch

**Status:** E-0 delivered; E-1 onward planned
**Scope:** what happens from the moment a strategy decides to trade until the
position is closed — direction, order placement, protective stops, trade
management, and the downside backstop.
**Prerequisites:** Component A (systematic engine) — delivered.
Interacts with Component C (connections) and Component D (rule vocabulary).

This is Component **E** of [SYSTEMATIC_TRADING_ROADMAP.md](SYSTEMATIC_TRADING_ROADMAP.md).
Component D covers *what a strategy can say*; this covers *what the engine does
once it has said it*.

---

## 1. Why this is net-new

Component D's plans assumed the execution layer underneath was adequate and
only the rule vocabulary needed extending. Reading `executionEngine.ts` closely
for that work showed it is not. Three properties of the current engine are
incompatible with the confirmed requirements:

| Current behaviour | Where | Requirement |
|---|---|---|
| **Long-only.** `buy` opens; `sell` closes a long and refuses when flat — *"exit signal but no open long position to close"* | `executionEngine.ts:205-221` | Long **and** short |
| **Market orders with no protection.** Every systematic order is `order_type: 'MKT'`, no stop attached | `executionEngine.ts:226-233` | Broker-side SL at entry |
| **Position inferred from the app's own fills**, scoped by `runId` | `strategyRunner.ts:296-302` | Broker-reported position is truth |

The third is the one that turns a missing feature into a correctness problem.
Once stops live at the broker, **the broker closes positions the app did not
close.** A fills-derived position that only counts orders this run placed would
never see that exit, and the run would trade on against a position that no
longer exists.

---

## 2. Confirmed requirements

Settled during planning; recorded here because several of them narrow the
design significantly.

| # | Decision | Consequence |
|---|---|---|
| E1 | **Long and short**, both first-class | Signed positions throughout |
| E2 | **MT5 netting accounts** — one net position per symbol, one direction | No hedging ticket model; position is a single signed number |
| E3 | **Broker-side SL**, actively managed app-side | Order path must carry `sl`; a modify path is required |
| E4 | **All decisions at bar close.** Streamed prices are chart-only | One evaluation loop; backtest parity preserved |
| E5 | **5-minute minimum** strategy timeframe | Bounds trail-modify traffic to one per position per bar |
| E6 | **Trailing stop**, e.g. "2-bar low", rule-defined | Ratchet enforced by the broker (§4.2) |
| E7 | **SL/TP are rule-defined**, not engine config | Each strategy carries its own risk model |
| E8 | **Trail only for now**; take-profit is a placeholder | Exits are stop-driven |
| E9 | **Risk-based sizing** (`risk_pct`), budget as % of equity, resolved at entry only | Sizing depends on the stop; no re-sizing of an open position |
| E10 | **One strategy per instrument per account** | The broker's net position maps 1:1 to one run |
| E11 | **Kill switch app-side**, may act as notification only | Bar-close cadence; a response, not a prevention |
| E12 | **No position reversal** (long → short directly) | Flat is always visited in between |

### 2.1 Two of these combine into a real simplification

**E10 + E3.** Because exactly one run owns the net position for a given
`(connection, symbol)`, a broker-side stop firing needs no attribution
machinery — the run reads the broker's position at bar close and *that is its
position*, regardless of who closed it. Without E10, a stop fill would arrive
with no `order_audit` row and no `requestId` linking it to a run, and matching
it back would need MT5's `position_id` threaded through the sidecar contract
and the fills schema. E10 removes that work entirely.

It also means **manual intervention is handled for free**: close a trade
yourself in the terminal, and the run sees flat on the next bar and behaves
correctly.

**E6 + E3.** A ratcheting trail normally needs carried state — the high-water
mark must persist so the stop never moves backwards. But with the stop living
at the broker, **the broker holds that state**. Each bar close the app computes
the desired stop from the rule and issues a modify *only when the new stop is
more protective than the one already there*. The ratchet is a comparison, not a
state machine.

This materially lowers the priority of Component D's state channel (D-3): it
remains a general capability, but it is no longer a prerequisite for the
trailing and breakeven behaviour actually required.

---

## 3. Direction — signed positions

### 3.1 Signal vocabulary

The current `buy` / `sell` / `none` conflates direction with intent: `sell`
means "close a long," which has no way to express "open a short." Replace with
an explicit pair — a **target direction** and the engine deriving the order:

| Signal | Flat | Long | Short |
|---|---|---|---|
| `long` | open long | hold | *(E12: refused — must flatten first)* |
| `short` | open short | *(E12: refused)* | hold |
| `flat` | no-op | close long | close short |
| `none` | no-op | no-op | no-op |

Keeping `buy`/`sell` as deprecated aliases for `long`/`flat` preserves existing
definitions; the rule-set `schema_version` (Component D §6.7) marks which
vocabulary a definition uses.

**PLACEHOLDER (E-P1): direct reversal.** E12 defers long→short in one step.
When it arrives, MT5 netting makes it a *single* order of size
`|current| + |target|` rather than close-then-open — atomic, one round trip,
never briefly flat. The table above should reject it explicitly today rather
than silently doing something surprising.

### 3.2 What becomes signed

Every place that currently assumes a long:

- `ExecutionEngine` exit sizing uses `Math.abs(ctx.position.size)` and refuses
  when `quantity <= 0` — needs to close in the correct direction instead.
- `Position.unrealized_pct` in `rule_strategy.py:142-147` already handles a
  negative size correctly. Good — no change.
- The net-exposure guard and position limits must compare **absolute** exposure
  while preserving sign for direction checks.
- Sizing returns a magnitude; direction comes from the signal.

---

## 4. Protective stops

### 4.1 Placement at entry

The entry order carries a stop derived from the rule-set at the moment of
entry. This requires:

- `OrderInput` / `ValidatedOrder` gain `stop_loss` (and later `take_profit`).
- The MT5 sidecar contract's `POST /orders` gains `sl` / `tp`. This is a
  **documented contract change** (`mt5_adapter.py:13-35`) requiring the
  out-of-repo sidecar to be updated in step — the one place in this plan where
  work lands outside this repository.
- **Fail closed:** if a strategy declares a stop and the venue rejects or omits
  it, the position must not be left open unprotected. Either the entry is
  refused, or the position is closed immediately and the run errored. An
  unprotected position is never an acceptable resting state.
- Brokers enforce a **minimum stop distance** from current price. A stop inside
  that band is rejected; the engine must read the connection's stop level
  (part of the instrument spec) and refuse the entry rather than send an order
  it knows will fail.

### 4.2 Management at bar close

Each bar close, for every open position:

1. Read the broker's position and its current stop.
2. Evaluate the rule-set's stop rule against the new bar (e.g. "2-bar low").
3. If the computed stop is **more protective** than the current one, issue a
   modify. Otherwise do nothing — this is the ratchet.
4. Respect the minimum stop distance; skip the modify rather than send a
   rejection.

At a 5-minute floor (E5) this is at most one modify per position per bar, which
keeps well inside broker modify-rate limits.

**PLACEHOLDER (E-P2): take-profit.** E8 defers TP. The order path should carry
`take_profit` from the start even while nothing populates it, so enabling it
later is a rule-set change rather than a contract change across the sidecar.

### 4.3 What the app cannot see

Between bar closes the app is blind. The broker-side stop is the *only*
protection in that window — which is precisely why E3 places it there. This is
a deliberate, accepted limit of E4, and it should be stated plainly in the
operator docs rather than discovered.

---

## 5. Sizing

**E9: risk-based sizing, budgeted as a percentage of equity, resolved once at
entry.** No re-sizing of an open position; no pyramiding.

A new `risk_pct` sizing type alongside the existing `fixed` / `notional` /
`pct_equity`. Risk a fixed fraction of equity per trade, with position size
falling out of the stop distance:

> **size = (equity × risk%) ÷ loss-per-unit-of-size-at-the-stop**

$100k equity at 1% risk with a 50-pip stop gives a position where 50 pips of
adverse movement costs exactly $1,000. **Position notional varies with stop
width; the loss does not.** That is the point — it is what makes a wide-stop
setup and a tight-stop setup comparable, and it is the reason to know the stop
at entry at all.

### 5.1 Compute the loss from the venue's tick value, not from contract size

The naive formula — `stop_distance × contract_size` — is correct only when the
instrument's quote currency matches the account currency. EURUSD in a USD
account works; EURJPY, XAUUSD in some configurations, and index CFDs do not,
because the price move is denominated in the quote currency and the risk budget
is in the account currency. Getting this wrong doesn't error — it silently
sizes positions wrong by the FX rate, which is exactly the kind of bug that is
invisible until it is expensive.

MT5 already solves this: `SymbolInfo` exposes **`trade_tick_value`** (the value
of one tick, *in account currency*) and `trade_tick_size`. So:

```
loss_per_unit_size = (stop_distance ÷ tick_size) × tick_value
size               = (equity × risk%) ÷ loss_per_unit_size
```

This is robust across quote currencies and instrument classes without the app
doing any FX arithmetic, and it delegates the conversion to the venue that
actually knows the rate.

**Contract change required.** `instrument_spec` currently returns `min_size`,
`size_step`, `max_size`, `contract_size` and `currency`
(`mt5_adapter.py:464-501`) — **not** tick value or tick size. Both must be
added to the adapter and to the sidecar's `/symbol` response. Absent them,
`risk_pct` must **refuse to size** rather than fall back to the contract-size
approximation, since a silently-wrong size is worse than a refused trade.

### 5.2 Sizing now depends on the stop — an ordering change

Today sizing resolves from the bar price alone. Under `risk_pct` the stop rule
must be **evaluated first**, so the engine's sequence becomes: evaluate entry →
evaluate stop rule → derive stop distance → size → place order with stop
attached. A strategy declaring `risk_pct` without a stop rule is a compile-time
error, not a runtime surprise.

### 5.3 A tight stop produces a large position — the caps stay binding

This is the failure mode of risk-based sizing, and it deserves stating plainly:
**as stop distance approaches zero, position size approaches infinity.** A 1%
risk budget with a 2-pip stop is an enormous notional. Three guards, all
fail-closed:

- The existing `ORDER_MAX_*` fat-finger caps remain binding and are **not**
  waived for risk-sized orders.
- Check **free margin** before placing; a risk-correct size that cannot be
  margined must be refused, not truncated silently.
- Enforce a minimum stop distance (§4.1) — which also bounds the maximum size
  this formula can produce.

Sizing still resolves to a magnitude in the venue's native unit (lots on MT5)
and the venue's `min_size` / `size_step` / `max_size` still bind. A computed
size below `min_size` is a **refusal**: rounding up would risk more than the
budget, which is the one thing this sizing type exists to prevent.

---

## 6. Kill switch

**E11: app-side, bar-close cadence, may begin as notification-only.**

Because everything evaluates at bar close (E4), the kill switch cannot prevent
a gap through a stop — by the time it looks, the fill has happened. It is a
**detection and halt** mechanism, not prevention. Being honest about that
shapes what it should do:

**Triggers** (each independently configurable, evaluated at bar close):
- A position closed materially worse than its stop implied — evidence of a gap
  or slippage event.
- Account equity below a floor, or a drawdown threshold from a high-water mark.
- A position found open **without** the protective stop the run expects.
- Broker-reported position disagrees with the app's expectation (§7).

**Actions**, in escalating order — start at the first, enable later ones as
confidence grows:
1. **Notify** (Telegram, §8) — no automated action.
2. **Halt** — stop the run or every run on the connection; take no new entries.
3. **Flatten** — close open positions on the connection.

Starting notification-only directly addresses the "hard to UAT" concern: it can
run in production against real conditions with zero blast radius, and its
trigger accuracy can be judged from the alerts it would have acted on before
anything is allowed to act.

**Scope note.** A kill switch inside the main service cannot fire when that
service is down. That is an accepted limitation of E11; the broker-side stop
is the protection that survives app failure. An independent watchdog is a
**PLACEHOLDER (E-P3)** if the notification-only phase shows the app itself is
the unreliable part.

---

## 7. Position truth and reconciliation

**Broker-reported position becomes the source of truth**, replacing the
fills-derived estimate — enabled by E10 (§2.1).

- At bar close, the run reads `(connection, symbol)` position from the adapter:
  signed size, average price, current stop.
- The fills-derived figure (`netPositionWithOpenOrders`) is retained as a
  **reconciliation check**, not the source. A persistent disagreement is a
  kill-switch trigger and an alert — it means fills are being missed, which is
  exactly the class of bug Component C's phase C-0 addresses.
- A position that appears with no run expecting it (manual trade on a
  systematic account) is reported, not adopted.

This is a behaviour change worth stating clearly: the run no longer isolates
itself from activity it did not initiate. Under E10 that isolation was
protecting against a scenario that can no longer occur, and its cost —
invisibility to broker-side and manual closes — is now the dominant term.

---

## 8. Alerting

**Telegram**, chosen for reachability over WhatsApp/Signal: a bot token and an
HTTPS call, versus Business API approval or a bridge process. Since the only
requirement is "reaches the operator's phone reliably," the simplest transport
that achieves it wins.

- A small notifier service in the backend, behind an interface so a second
  channel can be added without touching call sites.
- Events: kill-switch triggers, connection down / breaker open, cap breach, run
  errored, group canary failed, position/stop mismatch.
- Rate-limited and deduplicated — an alert channel that floods is an alert
  channel that gets muted.
- Credentials via env (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`), never in the
  manifest or DB, consistent with Component C.

---

## 9. Phasing

| Phase | Contents | Ships |
|---|---|---|
| **E-0** ✅ | Broker position as truth (§7) + reconciliation check | **Delivered.** Correct position tracking, prerequisite for everything else |
| **E-1** | Signed positions and the `long`/`short`/`flat` vocabulary (§3) | Shorts, without stops yet |
| **E-2** | Broker-side SL at entry (§4.1) + sidecar contract change + fail-closed protection | Every position protected at the venue |
| **E-3** | Bar-close stop management and the ratchet (§4.2) | Trailing stops as specified |
| **E-4** | `risk_pct` sizing (§5): tick-value fields on `instrument_spec` + sidecar `/symbol`, stop-before-sizing ordering, margin check | Constant risk per trade regardless of stop width |
| **E-5** | Telegram notifier (§8) + kill switch in notify-only mode (§6) | Observability of the downside, zero blast radius |
| **E-6** | Kill switch halt and flatten actions | Automated downside response |

E-0 first is deliberate: every later phase depends on the app knowing what
position it actually holds, and E-2 makes that question urgent by introducing
closes the app did not perform.

E-4 sits after E-2/E-3 by necessity rather than preference — `risk_pct` cannot
be computed until the stop rule exists and is evaluated before sizing (§5.2).
Until then, strategies size with the existing `pct_equity` type.

**Two sidecar contract changes land in this component** (E-2's `sl`/`tp` and
E-4's tick value/size). They are the only work in any of these plans that falls
outside this repository, so they are worth batching into a single update of the
Windows-side service rather than two.

> **E-0 delivered.** `getPosition` now reads the venue's reported position for
> the run's `(connection, native_symbol)` and returns it signed, with the
> venue's average price. The fills-derived figure is computed alongside as
> `derived_size` and compared, never used as the position.
>
> Two decisions carry the weight:
>
> - **An unreachable venue fails the evaluation; it does not report flat.** The
>   old code caught the error and returned `{size: 0}`, which was defensible
>   when the figure came from fills ("no fills" really does mean flat) and is
>   dangerous now: flat is an *actionable* state, and a strategy told it is flat
>   while holding a position will open a second one on top. The failure is
>   recorded on the run and counted against the connection's breaker, since an
>   unreadable position is nearly always the venue being unreachable.
> - **A reconciliation mismatch reports, it does not refuse.** Divergence is
>   expected and benign in two cases — a broker-side stop closed the position
>   (the app placed no order, so no fill is attributed) and a manual trade — but
>   a *persistent* mismatch means fills are being missed, which is what silently
>   corrupts realised P&L and therefore `max_daily_loss`. Surfaced in the runner
>   status and logs; C-4 turns it into a per-connection report.

---

## 10. Placeholders registered here

| ID | Deferred item | Trigger to revisit |
|---|---|---|
| **E-P1** | Direct long→short reversal in one order | When a strategy needs to flip without visiting flat |
| **E-P2** | Take-profit | When a strategy wants a fixed target alongside the trail |
| **E-P3** | Out-of-process kill-switch watchdog | If notify-only shows the app itself is the unreliable component |
| **E-P4** | Limit and stop entry orders | Confirmed future requirement; needs a working-order lifecycle (expiry, modify, partial fill) the engine does not model |
| **E-P5** | Pyramiding / re-sizing an open position | Explicitly excluded by E9 |
| **E-P6** | Hedging-mode accounts | Only if an account is opened that is not netting |

See [`FUTURE_DECISION_POINTS.md`](FUTURE_DECISION_POINTS.md) for the
consolidated register across all components.
