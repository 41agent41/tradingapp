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
| Strategy definition | **Config / rule-driven criteria** (declarative, shared by backtest **and** live) |
| MetaTrader role | **Data _and_ execution venue** (full parity with IB) |
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
  "name": "MA + RSI confirmation",
  "symbol": "MSFT",
  "timeframe": "1hour",
  "indicators": ["sma_20", "sma_50", "rsi"],
  "entry": { "all": [
    { "left": "sma_20", "op": ">",  "right": "sma_50" },
    { "left": "rsi",    "op": "<",  "right": 35 }
  ]},
  "exit":  { "any": [
    { "left": "sma_20", "op": "<",  "right": "sma_50" },
    { "left": "rsi",    "op": ">",  "right": 70 }
  ]},
  "sizing": { "type": "fixed_qty", "quantity": 100 },
  "risk":   { "max_orders_per_day": 4, "stop_loss_pct": 2.0 }
}
```

- **Operands** are indicator column names, bar fields (`close`, `volume`), or
  constants; **operators** `>` `<` `>=` `<=` `crosses_above` `crosses_below`.
- `all` / `any` groups nest. The compiler resolves the required indicator list
  and feeds it to `calculate_indicators` (same path backtest uses).
- **Parity guarantee:** the plan includes a test asserting a JSON rule-set that
  mirrors `SimpleMAStrategy` produces the identical backtest result.

**DoD:** rule-sets register alongside `AVAILABLE_STRATEGIES`; `/backtest`
selects and parametrises them; unit tests cover the compiler + parity.

### A2. Live signal runner (signal-only first)

A backend `strategyRunner` service modelled on the opt-in
`backfillScheduler.ts` timer:

- Reads active `strategy_runs`; for each, on its `timeframe` cadence pulls the
  **latest closed bar** (via `useHistoricalData`'s backend route / cache).
- Calls `ib_service` `POST /strategies/evaluate` → `{signal, reason}` for the
  newest bar only (debounced: one decision per closed bar, never mid-bar).
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
- **Position sizing** — `fixed_qty`, `fixed_notional`, `pct_equity`.
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
  risk, started_at, stopped_at}`.
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

**DoD:** all existing IB flows route through the interface; `source=ib` is
byte-for-byte identical; tests green.

### B2. MetaTrader (MT5) adapter — the deployment decision

**Constraint:** the official `MetaTrader5` Python package is **Windows-only**
and attaches to a running terminal; this stack is Linux/Docker. MT5 therefore
cannot `pip install` into `ib_service`. Options:

| Option | How | Trade-off |
|---|---|---|
| **A. Windows sidecar (recommended)** | Small FastAPI service on a Windows host/VM running the MT5 terminal + `MetaTrader5`; exposes bars/ticks/orders over HTTP matching the adapter shape. Linux `MT5Adapter` is a thin HTTP client. | One extra host; officially supported; keeps the Linux stack clean |
| **B. Third-party Linux bridge** | A community MT5↔REST/socket gateway. | No Windows host; unofficial, varies in reliability |
| **C. REST-EA in-terminal** | An Expert Advisor exposing an HTTP endpoint from inside MT5. | Trades within MT5's own runtime; EA maintenance, still needs the terminal running |

The plan assumes **Option A** unless a short spike says otherwise; the
`MT5Adapter` interface is identical regardless, so the choice only affects what
sits behind the HTTP boundary.

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

## 9. Open decisions to confirm before Phase 1

1. **MT5 deployment** — Option A (Windows sidecar) unless the spike finds a
   solid Linux bridge. Confirm you can provide a Windows host for the terminal.
2. **Rule expressiveness** — is the `all`/`any` + comparison/cross model
   enough, or do you need time-of-day windows, multi-symbol conditions, or
   position-aware rules (e.g. pyramiding) in v1?
3. **Instruments** — IB is equities-centric here (MSFT brief); MT5 is
   FX/CFD-centric. Which instruments must v1 trade — same symbols on both, or
   different universes per broker?
4. **Sizing default** — `fixed_qty` for v1, with `pct_equity` behind account
   valuation later?

---

_Update this document as phases land; move completed phases into
`FEATURES.md` under "Currently Available" and cross-reference from
`GAP_ANALYSIS.md`._
