# Systematic Trading & Multi-Broker Roadmap

_Authored: 2026-08-03 on branch `claude/roadmap-component-breakdown-33cfwo`._

This document is a **phased implementation plan**, not a status report. It
supersedes the "larger follow-on features" hand-wave in
[`GAP_ANALYSIS.md`](GAP_ANALYSIS.md) §7 and reframes the remaining roadmap
around two capabilities the platform does **not** have today:

1. **Systematic trading** — evaluate *defined criteria* against live data and
   place orders automatically (not just backtest, not just manual tickets).
2. **MetaTrader (MT5) as a first-class broker** — quote **and** trade through
   MT5 alongside Interactive Brokers.

The scope below reflects four decisions taken up front:

| Decision | Choice |
|---|---|
| Engine autonomy | **Full auto-execution** (paper-first, staged behind gates) |
| Strategy definition | **Config / rule-driven criteria** — sessions, multi-timeframe operands, position-aware rules; shared by backtest **and** live |
| MetaTrader role | **Data _and_ execution venue** (full parity with IB), broker-scoped instruments, broker-unit sizing |
| First deliverable | This written plan |

---

## 1. Why this is net-new (what exists vs. what's missing)

The raw materials already exist in the repo but are **not connected**:

| Building block | Where it lives today | Used for | Missing link |
|---|---|---|---|
| Signal logic | `ib_service/backtesting.py` — `TradingStrategy.should_buy/should_sell/generate_signals`, `SimpleMAStrategy`, `RSIStrategy`, `AVAILABLE_STRATEGIES` | **Backtest only** | Never evaluated against live bars |
| Indicators | `ib_service/indicators.py` — `indicator_calculator.calculate_indicators` | Charts + backtest | — |
| Order path | `backend/src/routes/orders.ts` + `ib_service/orders.py` — validated, gated (`LIVE_TRADING_ENABLED`), audited (`order_audit`), position-capped | **Manual tickets only** | Nothing generates orders programmatically |
| Tick stream | `ib_service/streaming.py` → Redis → `streamingBridge.ts` → Socket.IO | **Chart display only** | Not consumed by a strategy |
| Broker plumbing | `ib_service/ib_client.py`, `streaming.py`, `orders.py`, `ib_pool.py` | IB | **IB is hardcoded** — no adapter seam; `get_market_data_source()` is a cosmetic string |

**Gap A — no execution engine:** nothing turns a criterion into a live order.
**Gap B — no broker seam:** MetaTrader has nowhere to plug in.

---

## 2. Guiding principles

- **Paper-first, staged gates.** Auto-execution ships disabled. A new
  `SYSTEMATIC_EXECUTION_ENABLED` gate turns on the *engine*; the existing
  `LIVE_TRADING_ENABLED` still independently gates *live* (vs paper) orders.
  Both default off — same defence-in-depth pattern as §6 of `GAP_ANALYSIS.md`.
- **Backtest == live parity.** A strategy is **one definition object** that the
  backtest engine and the live runner both consume. If it can't be backtested,
  it can't be traded.
- **Fail closed.** Every risk check aborts *before* the IB/MT5 hop and before
  the audit write, exactly like the current position guard
  (`checkPositionLimit` in `orderTypes.ts`).
- **Reuse the audited order path.** The engine never talks to a broker
  directly — it submits through `/api/orders`, inheriting `validateOrder`, the
  gate, `order_audit`, `ORDER_MAX_*`, the position cap and `orderAuth`
  (RBAC/MFA).
- **Additive, not disruptive.** IB behaviour is unchanged until a caller opts
  in via an env var or a `source=`/`broker=` parameter.

---

## 3. Target architecture

```
                 ┌──────────────────────── frontend ────────────────────────┐
                 │  /systematic  (rule builder · run list · live signals ·   │
                 │                positions · P&L · KILL SWITCH)             │
                 └───────────────┬──────────────────────────┬───────────────┘
                                 │ REST + Socket.IO          │
                 ┌───────────────▼──────────────────────────▼───────────────┐
   backend       │  strategyRunner (opt-in timer, per active run)            │
   (has DB +     │     ├─ pulls latest CLOSED bar per run                    │
    order path)  │     ├─ calls ib_service /strategies/evaluate  ───────────┐│
                 │     ├─ persists strategy_signals                          ││
                 │     ├─ RISK LAYER → OrderInput → /api/orders (existing)   ││
                 │     └─ reconciles strategy_runs / _state                  ││
                 └───────────────┬──────────────────────────────────────────┘│
                                 │ order path (audited, gated)                │
                 ┌───────────────▼───────────── ib_service ──────────────────▼┐
                 │  BrokerAdapter registry  ── source/broker = ib | mt5        │
                 │     ├─ IBAdapter   (ib_client / streaming / orders)         │
                 │     └─ MT5Adapter  ── HTTP ──▶ MT5 sidecar (Windows)        │
                 │  rule evaluator: calculate_indicators → generate_signals    │
                 └─────────────────────────────────────────────────────────────┘
```

Two rules of placement drive this split:

- **Evaluation lives in `ib_service`** — that's where indicators and the
  strategy classes already are. Add a stateless `POST /strategies/evaluate`
  (bars + rule-set → latest signal); no new IB coupling.
- **Orchestration, state and execution live in the backend** — only it has the
  database and the audited order path.

---

## 4. Component A — Systematic execution engine

### A1. Rule-driven strategy definitions (foundational)

Today a strategy is a Python subclass with hardcoded thresholds
(`SimpleMAStrategy(fast_period, slow_period)`). Replace *authoring* with a
declarative rule-set that compiles to a `RuleStrategy(TradingStrategy)` whose
`should_buy` / `should_sell` evaluate the rules against the current bar — so it
drops straight into the existing `BacktestEngine.run_backtest` **and** the live
runner unchanged.

Sketch of the definition (persisted as JSON, editable in the UI):

```jsonc
{
  "name": "MA + RSI, higher-TF confirmation, pyramiding",
  "symbol": "MSFT",
  "broker": "ib",
  "timeframe": "5min",          // the run's primary (execution) timeframe
  "indicators": ["sma_20", "sma_50", "rsi"],
  "sessions": [                 // time-of-day windows (rules only fire inside)
    { "tz": "America/New_York", "days": ["Mon","Tue","Wed","Thu","Fri"],
      "from": "09:45", "to": "15:30" }
  ],
  "entry": { "all": [
    { "left": "sma_20", "op": "crosses_above", "right": "sma_50" },
    { "left": { "indicator": "rsi", "timeframe": "1hour" },   // multi-TF operand
      "op": "<", "right": 60 },
    { "left": "position.size", "op": "<", "right": 300 }      // position-aware (pyramiding cap)
  ]},
  "exit":  { "any": [
    { "left": "sma_20", "op": "crosses_below", "right": "sma_50" },
    { "left": "rsi",    "op": ">", "right": 70 },
    { "left": "position.unrealized_pct", "op": "<=", "right": -2.0 }  // position-aware stop
  ]},
  "scale_out": [                // optional partial exits (position-aware)
    { "when": { "left": "position.unrealized_pct", "op": ">=", "right": 3.0 },
      "reduce_pct": 50 }
  ],
  "sizing": { "type": "fixed", "unit": "broker_default", "size": 100 },
  "risk":   { "max_orders_per_day": 4, "stop_loss_pct": 2.0 }
}
```

The model is deliberately richer than a flat comparison list, per the confirmed
requirements:

- **Operands** — indicator columns, bar fields (`close`, `volume`), constants,
  **position-aware** fields (`position.size`, `position.avg_price`,
  `position.unrealized_pct`), and **multi-timeframe** operands
  (`{ "indicator": "rsi", "timeframe": "1hour" }` reads a higher-TF value while
  the run executes on its primary timeframe).
- **Operators** — `>` `<` `>=` `<=` `crosses_above` `crosses_below`.
- **`sessions`** — time-of-day / day-of-week windows (in an explicit tz);
  entry/exit rules only evaluate inside them, with an optional
  `flat_at_session_end` to force-close.
- **`scale_out`** — position-aware partial exits (pyramiding is expressed on the
  entry side via a `position.size` cap; scale-outs on the exit side).
- `all` / `any` groups nest. The compiler resolves the full indicator set
  **per timeframe** and feeds each to `calculate_indicators` (same path
  backtest uses).
- **Parity guarantee:** a test asserts a JSON rule-set mirroring
  `SimpleMAStrategy` produces the identical backtest result.

> **Scope note.** Multi-timeframe operands, sessions and position-aware rules
> push A1 from *M* to *L*: `generate_signals` currently sees one bar at a time
> with no position/clock context, so the evaluator gains (a) a per-timeframe
> indicator cache, (b) a session clock, and (c) live position state threaded in
> from the runner. This context is also what backtest must simulate, so it is
> built once and shared.

**DoD:** rule-sets register alongside `AVAILABLE_STRATEGIES`; `/backtest`
selects and parametrises them, including a multi-TF + session + position-aware
example; unit tests cover the compiler, each operand class, and the
`SimpleMAStrategy` parity case.

### A2. Live signal runner (signal-only first)

A backend `strategyRunner` service modelled on the opt-in
`backfillScheduler.ts` timer:

- Reads active `strategy_runs`; for each, on its **primary** `timeframe`
  cadence pulls the **latest closed bar** (via `useHistoricalData`'s backend
  route / cache), plus the latest closed bar of any **higher timeframe** the
  rule-set references (multi-TF operands).
- Passes the run's current **position state** and the wall clock (for
  `sessions`) into the evaluation call.
- Calls `ib_service` `POST /strategies/evaluate` → `{signal, reason}` for the
  newest bar only (debounced: one decision per closed bar, never mid-bar;
  rules outside an active session return no signal).
- Writes a `strategy_signals` row and emits it on a `strategy:<runId>`
  Socket.IO room (reuses the streaming bridge fan-out).
- **No orders in this phase** — proves the criteria fire correctly with zero
  execution risk.

**DoD:** live signals appear in the UI and persist; a run can be started and
stopped; nothing can place an order yet.

### A3. Execution + risk layer (turns on auto-execution)

Maps a signal → `OrderInput` → the **existing** `/api/orders`. The engine adds
no new broker code; it adds *guards* on top of the ones the order path already
enforces:

Reused (already in `orderTypes.ts` / `orderAuth.ts`): `validateOrder`,
`LIVE_TRADING_ENABLED`, `order_audit` write-before-send, `ORDER_MAX_QUANTITY`
/ `ORDER_MAX_PRICE`, `checkPositionLimit` / `ORDER_MAX_POSITION`, RBAC
(`TRADING_TOKENS`) + TOTP MFA (`ORDER_MFA_SECRET`).

New, engine-level:
- **`SYSTEMATIC_EXECUTION_ENABLED` gate** (default off) — distinct from
  `LIVE_TRADING_ENABLED`; paper auto-trading needs only the former.
- **Signal→order dedupe** — one order per (run, bar, signal); a restart can't
  double-fire.
- **Position sizing — broker-unit-aware (confirmed).** Sizing resolves in the
  target broker's native unit: **shares** for IB equities, **lots** for MT5
  FX/CFD (with contract-size/min-lot/step honoured per instrument). The sizing
  block carries a `unit` (`broker_default` | `shares` | `lots` | `notional` |
  `pct_equity`); the broker adapter is the authority that converts an abstract
  size into a valid, rounded order quantity and rejects sub-minimum sizes. The
  same `fixed` / `notional` / `pct_equity` *type* therefore means different
  concrete quantities on IB vs MT5 — resolution lives in the adapter, not the
  rule.
- **Per-run risk caps** — `max_orders_per_day`, `max_daily_loss`, optional
  `stop_loss_pct` / `take_profit_pct` bracket.
- **Kill switch** — a run flips to `stopped` and the runner refuses new orders
  within one cycle; a global env kill (`SYSTEMATIC_EXECUTION_ENABLED=false`)
  halts everything.
- **Restart reconciliation** — on boot, rebuild each run's net position from
  `order_audit` (reuse `OrderAuditRepository.netExposure`) before acting.

**DoD:** end-to-end **paper** auto-execution; every cap enforced fail-closed
with a unit test; kill switch verified to stop within one evaluation cycle.

### A4. State & persistence

New tables (canonical `timescaledb-schema.sql`, mirroring the `backtest_runs` /
`order_audit` conventions):

- `strategy_definitions` — the rule-set JSON, versioned.
- `strategy_runs` — `{definition_id, broker, account_mode, status, sizing,
  risk, started_at, stopped_at}`. `broker` fixes both the data source and the
  execution venue for the run (§5 B1).
- `strategy_signals` — every evaluation: `{run_id, bar_time, signal, reason,
  acted}` (links to the resulting `order_audit` row when acted).

### A5. Monitoring UI (`/systematic`)

- **Rule builder** — form over the A1 schema (indicator · operator · value,
  add/remove conditions), with a "Backtest this" button reusing `/backtest`.
- **Run dashboard** — active runs, latest signal + reason, live net position,
  realised/unrealised P&L, per-run **Stop**.
- **Chart with signal markers** — `<Chart>` gains buy/sell markers from
  `strategy_signals` (this also delivers the §6 "order-history overlay"
  stretch item for free).
- Reuses `DataframeViewer` (signal/fill tables) and `OrderBlotter`.

---

## 5. Component B — Multi-broker abstraction + MetaTrader

### B1. Broker/data-source interface (enabling refactor)

Define two Python protocols in `ib_service` and make the current IB code
implement them — **no behaviour change; `source=ib` stays the default**:

- `MarketDataAdapter` — `search_contracts`, `historical_bars`,
  `subscribe_ticks`, `unsubscribe`.
- `BrokerAdapter` — `place_order`, `cancel_order`, `modify_order`,
  `positions`, `account`.

Refactor `ib_client.py` / `streaming.py` / `orders.py` behind `IBAdapter`;
turn `get_market_data_source()` into a real registry keyed by `source`. Add a
`source=ib|mt5` request parameter (and a `broker=` field on `/api/orders`),
defaulting to `ib`. Per-provider health surfaces under `/api/health`.

**Broker-scoped instrument universes (confirmed).** The two brokers trade
**different instruments** (IB is equities-centric here; MT5 is FX/CFD-centric),
so the abstraction is *segmented*, not *unified*: there is no cross-broker
symbol reconciliation. Concretely —

- **Contract search / catalogues are broker-scoped.** Each adapter owns its own
  symbol universe; the UI's search and the `contracts` table are keyed by
  `broker` so `MSFT@ib` and an FX pair `@mt5` never collide.
- **A strategy run targets exactly one broker.** `strategy_runs.broker` fixes
  both the data source and the execution venue for that run; a definition's
  symbol is resolved against that broker's universe.
- **Positions and the `ORDER_MAX_POSITION` net are tracked per
  `(broker, symbol, account_mode)`** — the existing guard already keys on
  symbol + account_mode; add `broker` to the key so exposure never nets across
  venues.

This *simplifies* the abstraction (no symbol-mapping layer between brokers) at
the cost of threading a `broker` dimension through search, `order_audit`,
positions and the run model.

**DoD:** all existing IB flows route through the interface; `source=ib` is
byte-for-byte identical; tests green.

### B2. MetaTrader (MT5) adapter — the deployment decision

**Constraint:** the official `MetaTrader5` Python package is **Windows-only**
and attaches to a running terminal; this stack is Linux/Docker. MT5 therefore
cannot `pip install` into `ib_service`.

**Resolved — Option A (Windows sidecar).** A dedicated host is available for
MT5 (and for IB), so the plan commits to a small FastAPI service on that
Windows host running the MT5 terminal + `MetaTrader5`, exposing bars / ticks /
orders over HTTP in the adapter shape. The Linux `MT5Adapter` is a thin HTTP
client pointed at `MT5_BRIDGE_URL`. This is the officially-supported path and
keeps the Linux stack clean; the alternatives below are recorded only as
fallbacks if the sidecar proves impractical.

| Option | How | Status |
|---|---|---|
| **A. Windows sidecar** | FastAPI service on the dedicated Windows host running MT5 + `MetaTrader5`; HTTP adapter boundary. | **Chosen** |
| B. Third-party Linux bridge | A community MT5↔REST/socket gateway. | Fallback only |
| C. REST-EA in-terminal | An Expert Advisor exposing an HTTP endpoint from inside MT5. | Fallback only |

The `MT5Adapter` interface is identical regardless, so a later change behind
the HTTP boundary would not ripple into `ib_service` or the backend.

- **B2a — data:** `MT5Adapter` implements `MarketDataAdapter`; map MT5 symbols
  (`MSFT`, `EURUSD`) and timeframes (`M1`…`D1`) to the app's `_TIMEFRAME_MAP`;
  normalise timezone/timestamps to the app's UTC convention.
- **B2b — execution:** implement `BrokerAdapter`; `/api/orders` `broker=mt5`
  routes here; `order_audit`, the gate, and all guards apply unchanged.

**DoD (data):** a symbol charts + streams live via `source=mt5`.
**DoD (exec):** a **paper** order places through MT5 end-to-end, gated and
audited identically to IB.

---

## 6. Risk & safety summary (because this auto-trades)

| Layer | Control | Source |
|---|---|---|
| Global gates | `SYSTEMATIC_EXECUTION_ENABLED`, `LIVE_TRADING_ENABLED` (both default off) | new + existing |
| Per-order | `validateOrder`, `ORDER_MAX_QUANTITY/PRICE` | existing |
| Per-symbol | `ORDER_MAX_POSITION` net-exposure cap | existing |
| Per-run | `max_orders_per_day`, `max_daily_loss`, dedupe, bracket stops | new (A3) |
| Auth | `TRADING_TOKENS` (RBAC), `ORDER_MFA_SECRET` (TOTP) | existing |
| Operational | kill switch (per-run + global env), restart reconciliation | new (A3) |
| Audit | every order in `order_audit`; every decision in `strategy_signals` | existing + new |

---

## 7. Phased delivery (each phase independently shippable)

| Phase | Deliverable | Depends on | Risk while shipping |
|---|---|---|---|
| **0** | Finalise A1 rule schema + tables; MT5 deployment spike (Option A/B/C) | — | none (design) |
| **1** | A1 rule-driven strategies, **backtest-only** | 0 | none (no live orders) |
| **2** | A2 live signal runner, **signal-only** | 1 | none (no orders) |
| **3** | A3 auto-execution + risk layer, **paper** | 2 | gated, paper-only |
| **4** | A5 `/systematic` monitoring UI + chart markers | 3 | none |
| **5** | B1 broker abstraction (IB refactored behind interface) | — (parallelisable) | none (`source=ib` unchanged) |
| **6** | B2a MetaTrader **data** source | 5 | none (read-only) |
| **7** | B2b MetaTrader **execution** venue | 5, 6 | gated, paper-only |

Phases 1–4 (systematic engine) and 5–7 (MetaTrader) are largely independent;
5 can start in parallel with 1. Live (non-paper) auto-trading is deliberately
the *last* switch flipped, after phases 3 + 7 have proven out on paper.

---

## 8. New environment variables

| Var | Default | Purpose |
|---|---|---|
| `SYSTEMATIC_ENABLED` | `false` | Enable the strategy runner at all (signal-only from phase 2) |
| `SYSTEMATIC_EXECUTION_ENABLED` | `false` | Allow the engine to place orders (phase 3+) |
| `SYSTEMATIC_MAX_ORDERS_PER_DAY` | `0` (off) | Global backstop across all runs |
| `MT5_BRIDGE_URL` | _unset_ | HTTP endpoint of the MT5 sidecar (phase 6+) |
| `DEFAULT_BROKER` | `ib` | Default `broker=`/`source=` when unspecified |

All default to today's behaviour; nothing here changes an existing deployment
until explicitly set.

---

## 9. Decisions

All four framing decisions are now resolved:

1. **MT5 deployment** — ✅ **Option A (Windows sidecar)** on a dedicated host
   provided for MT5 (and IB). See §5 B2.
2. **Rule expressiveness** — ✅ **rich model in v1**: time-of-day/session
   windows, multi-timeframe operands, and position-aware rules (pyramiding
   caps + scale-outs). See A1.
3. **Instruments** — ✅ **different universes per broker**; broker-scoped
   abstraction, no cross-broker symbol reconciliation. See §5 B1.
4. **Sizing** — ✅ **broker-unit-aware**: shares (IB) vs lots (MT5), resolved
   in the broker adapter. See A3.

**Follow-on questions (not blocking Phase 1):**

- **Backtesting fidelity for the richer rules** — sessions and multi-TF
  operands must be simulated identically in backtest; intrabar fills and
  higher-TF alignment are the usual sources of backtest↔live drift. Worth a
  dedicated parity test suite as A1 lands.
- **MT5 account/equity source** for `pct_equity` sizing — confirm the sidecar
  exposes live account equity per run.

---

_Update this document as phases land; move completed phases into
`FEATURES.md` under "Currently Available" and cross-reference from
`GAP_ANALYSIS.md`._
