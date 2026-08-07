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
| Signal logic | `broker_service/backtesting.py` — `TradingStrategy.should_buy/should_sell/generate_signals`, `SimpleMAStrategy`, `RSIStrategy`, `AVAILABLE_STRATEGIES` | **Backtest only** | Never evaluated against live bars |
| Indicators | `broker_service/indicators.py` — `indicator_calculator.calculate_indicators` | Charts + backtest | — |
| Order path | `backend/src/routes/orders.ts` + `broker_service/orders.py` — validated, gated (`LIVE_TRADING_ENABLED`), audited (`order_audit`), position-capped | **Manual tickets only** | Nothing generates orders programmatically |
| Tick stream | `broker_service/streaming.py` → Redis → `streamingBridge.ts` → Socket.IO | **Chart display only** | Not consumed by a strategy |
| Broker plumbing | `broker_service/ib_client.py`, `streaming.py`, `orders.py`, `ib_pool.py` | IB | **IB is hardcoded** — no adapter seam; `get_market_data_source()` is a cosmetic string |

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
    order path)  │     ├─ calls broker_service /strategies/evaluate  ───────────┐│
                 │     ├─ persists strategy_signals                          ││
                 │     ├─ RISK LAYER → OrderInput → /api/orders (existing)   ││
                 │     └─ reconciles strategy_runs / _state                  ││
                 └───────────────┬──────────────────────────────────────────┘│
                                 │ order path (audited, gated)                │
                 ┌───────────────▼───────────── broker_service ──────────────────▼┐
                 │  BrokerAdapter registry  ── source/broker = ib | mt5        │
                 │     ├─ IBAdapter   (ib_client / streaming / orders)         │
                 │     └─ MT5Adapter  ── HTTP ──▶ MT5 sidecar (Windows)        │
                 │  rule evaluator: calculate_indicators → generate_signals    │
                 └─────────────────────────────────────────────────────────────┘
```

Two rules of placement drive this split:

- **Evaluation lives in `broker_service`** — that's where indicators and the
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

> **Parity closed — position-aware rules now simulate in backtest.** The first
> cut of A1 ran `generate_signals` once *up front*, before any trade existed, so
> every `position.*` operand read a flat position on every bar. A declared stop
> (`position.unrealized_pct <= -2.0`) or pyramiding cap (`position.size < 300`)
> therefore **could never fire in a backtest** even though it fires live —
> silently, with no error, which is the worst possible failure mode for a
> strategy you are about to deploy. `RuleStrategy` now exposes
> `prepare_stateful()` + `evaluate_bar()`, and `BacktestEngine.run_backtest`
> drives them **per bar** with its running position and open-trade entry price.
> `generate_signals` is reimplemented on top of `evaluate_bar` so the batch and
> stateful paths cannot drift, and a strategy without the stateful hooks keeps
> the original one-shot pass. Regression tests assert a -2% stop actually
> triggers and that `position.avg_price` reaches the operands — both fail
> against the old engine.

**DoD:** rule-sets register alongside `AVAILABLE_STRATEGIES`; `/backtest`
selects and parametrises them, including a multi-TF + session + position-aware
example; unit tests cover the compiler, each operand class, and the
`SimpleMAStrategy` parity case.

### A1b. Backtesting a *saved* definition (closes the authoring loop) — ✅ delivered

A1 let a rule-set be *compiled*, but only the strategies baked into
`AVAILABLE_STRATEGIES` could actually be **run** through the backtester — a
definition a user authored in the `/systematic` rule builder had no route into
`/backtest` at all. The create → backtest → deploy loop was broken at its first
hop: you could save a strategy and start trading it live, but you could not
test it first. Closed by:

- **`POST /backtesting/run` accepts a `rule_set` body** (the same shape
  `/strategies/evaluate` takes), compiled on the fly via
  `compile_rule_strategy`. Exactly one of the `strategy` query parameter or a
  `rule_set` body selects the strategy; a rule-set that fails to compile is a
  400, not a 500.
- **`POST /api/backtesting/run` accepts `definition_id` or `rule_set`**
  alongside the original `strategy` key — exactly one, validated. A
  `definition_id` loads the saved row and adopts its rule-set, symbol,
  timeframe, broker and instrument fields (each overridable per request).
- **Persistence keeps the provenance**: rule-set runs are stored under a
  `rules:def:<id>` / `rules:inline` strategy label with the rule-set itself in
  the run's `params`, so a persisted run is reproducible.
- **UI**: the `/backtest` strategy picker groups *Saved rule-sets* above
  *Built-in strategies*, selecting one adopts its instrument fields, and each
  row of the `/systematic` definitions list gains a **Backtest** link
  (`/backtest?definition=<id>`) that preselects it.

**DoD:** a definition authored in the rule builder can be backtested from the
UI without being re-keyed, and the run is persisted and replayable.

### A1c. Instrument scope — any instrument, any venue — ✅ delivered

Both the backtester and the live runner were hardwired to US stocks:
`/backtesting/run` built its contract as a literal `STK`/`SMART`/`USD`, and the
runner fetched history with no `source=`, so **every** run read IB data
regardless of the run's broker. A futures, FX or non-USD strategy — or any
strategy on MT5/Alpaca/OANDA — could be defined and started but would evaluate
against the wrong instrument or the wrong venue.

- `strategy_definitions` gains `sec_type` / `exchange` / `currency` (with
  `ADD COLUMN IF NOT EXISTS` so existing rows default to the previously-implied
  `STK`/`SMART`/`USD`), surfaced through the repository, the create route
  (validated against the same sec-type whitelist the market-data routes use)
  and the rule builder.
- `/backtesting/run` takes `sec_type`/`exchange`/`currency` and **qualifies the
  contract** via `reqContractDetails` before requesting bars — the same
  resolution `/market-data/history` performs — and takes `source=` to dispatch
  non-IB venues through the adapter registry instead of IB.
- `StrategyRunner.fetchHistory` now receives the whole run and forwards the
  instrument fields plus `source=run.broker`, so a run's data comes from the
  venue it will trade on.

**DoD:** a run on a non-STK instrument or a non-IB venue evaluates against that
instrument's bars from that venue.

### A2. Live signal runner (signal-only first)

A backend `strategyRunner` service modelled on the opt-in
`backfillScheduler.ts` timer:

- Reads active `strategy_runs`; for each, on its **primary** `timeframe`
  cadence pulls the **latest closed bar** (via `useHistoricalData`'s backend
  route / cache) — scoped to the definition's instrument and fetched from the
  run's own broker (`source=`, see A1c) — plus the latest closed bar of any
  **higher timeframe** the rule-set references (multi-TF operands).
- Passes the run's current **position state** and the wall clock (for
  `sessions`) into the evaluation call. Size comes from the `order_audit` net
  exposure; **average entry price** comes from the venue's reported average
  cost (`/account/positions`, cached ~30s so one lookup serves every run rather
  than one per run per tick), because without it `position.unrealized_pct`
  reads a constant 0 and a live stop-loss rule can never fire. It is fail-soft
  — an unreachable positions endpoint degrades to `avg_price = 0` rather than
  failing the evaluation — and IB-only for now, since `/account/positions` has
  no adapter dispatch yet (see §9).
- Calls `broker_service` `POST /strategies/evaluate` → `{signal, reason}` for the
  newest bar only (debounced: one decision per closed bar, never mid-bar;
  rules outside an active session return no signal).
- Writes a `strategy_signals` row and emits it on a `strategy:<runId>`
  Socket.IO room (reuses the streaming bridge fan-out).
- **No orders in this phase** — proves the criteria fire correctly with zero
  execution risk.

**DoD:** live signals appear in the UI and persist; a run can be started and
stopped; nothing can place an order yet.

### A3. Execution + risk layer (turns on auto-execution) — ✅ delivered (paper)

Maps a signal → `OrderInput` → the **existing** `/api/orders`. The engine adds
no new broker code; it adds *guards* on top of the ones the order path already
enforces:

> **Landed.** The audited create-order core was extracted to
> `backend/src/services/orderService.ts` (`submitCreateOrder`) and is shared by
> the HTTP route **and** the new `executionEngine.ts`, so the engine reuses the
> exact position-limit guard, `order_audit` write-before-send and IB hop. The
> runner (`strategyRunner.ts`) hands each newly-recorded actionable signal to
> the engine; sizing resolves in `orderSizing.ts` (IB shares — MT5 lots wait for
> B2). All guards below are unit-tested fail-closed. **Paper-only:** the engine
> is off unless `SYSTEMATIC_EXECUTION_ENABLED=true`, and a `live` order still
> needs `LIVE_TRADING_ENABLED` on top.

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
- **Per-run risk caps** — `max_orders_per_day` and `max_daily_loss` are both
  enforced (`max_daily_loss` against realised P&L from the run's own fills,
  gating entries only and failing closed); optional `stop_loss_pct` /
  `take_profit_pct` brackets are still expressed as exit rules rather than as
  broker-side bracket orders.
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

### A5. Monitoring UI (`/systematic`) — ✅ delivered

- **Rule builder** — form over the A1 schema (indicator · operator · value,
  add/remove conditions), with a "Backtest this" link to `/backtest`.
  Serialization is a pure, unit-tested helper (`app/lib/ruleSet.ts`).
- **Run dashboard** — definitions list (start a run), a runs table (status,
  last-eval, per-run **Stop**), and a per-run detail with a summary strip
  (net position, signals, orders placed, latest signal + reason).
- **Chart with signal markers** — `<Chart>` gained a `markers` prop; the run
  detail overlays buy/sell markers from `strategy_signals` (acted orders render
  bolder), delivering the §6 "order-history overlay" for free.
- **Live feed** — `useStrategySignals` subscribes to the `strategy:<runId>`
  Socket.IO room and merges live events with the REST history.

> **Landed.** New page `app/systematic/page.tsx` + components under
> `app/components/systematic/`. Consumes the existing `/api/strategies/*`
> endpoints only — no backend change. Vitest covers the rule-set builder, the
> signal socket hook, the merge/marker helpers and the `<Chart>` marker prep.

---

## 5. Component B — Multi-broker abstraction + MetaTrader + Alpaca + OANDA

### B1. Broker/data-source interface (enabling refactor) — ✅ delivered

> **Landed (broker_service seam).** New `broker_service/adapters.py` defines the
> `MarketDataAdapter` / `BrokerAdapter` protocols + a registry keyed by
> provider (`ib` | `mt5` | `alpaca` | `oanda`); `broker_service/ib_adapter.py`
> is the concrete `IBAdapter`, a thin delegation layer over the existing sync
> workers so `source=ib` / `broker=ib` are byte-for-byte identical. Orders,
> contract search and realtime/tick now dispatch through the registry; a
> `source=` / `broker=` parameter (default `ib`) is validated — unknown →
> 400, a recognised-but-unconfigured provider → a clean 501.
> `get_market_data_source()`'s cosmetic string is superseded by
> `provider_health()`, surfaced at `/health` and a new `/providers`.
>
> **Landed (backend broker dimension).** `order_audit` gains a `broker` column
> (default `ib`, with an `ADD COLUMN IF NOT EXISTS` for existing deployments);
> `validateOrder` validates `broker` (default from `DEFAULT_BROKER`); the
> `ORDER_MAX_POSITION` net is now keyed per `(broker, symbol, account_mode)` so
> exposure never nets across venues; the order path forwards `broker` to the IB
> service and the systematic engine threads each run's broker through sizing +
> the net key. `/api/orders/config` surfaces `brokers` + `default_broker`; the
> blotter can filter by `broker`.
>
> **Follow-on — done.** Historical bars now route through the data adapter for
> non-IB sources (landed with B2a), and the persisted `contracts` catalogue is
> broker-scoped: the table gains a `broker` column and its uniqueness is re-keyed
> to `(broker, symbol, sec_type, exchange, currency, expiry, strike, right)`, so
> `MSFT@ib` and a same-named instrument on another venue never collide. The
> market-data search + history routes accept a `source=`/`broker=` selector
> (default `ib`), tag stored contracts with it and forward it to the IB service;
> `getDataCollectionStats` is broker-aware. B1 is fully closed out.

Define two Python protocols in `broker_service` and make the current IB code
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
cannot `pip install` into `broker_service`.

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
the HTTP boundary would not ripple into `broker_service` or the backend.

- **B2a — data:** `MT5Adapter` implements `MarketDataAdapter`; map MT5 symbols
  (`MSFT`, `EURUSD`) and timeframes (`M1`…`D1`) to the app's `_TIMEFRAME_MAP`;
  normalise timezone/timestamps to the app's UTC convention. — ✅ **delivered**
- **B2b — execution:** implement `BrokerAdapter`; `/api/orders` `broker=mt5`
  routes here; `order_audit`, the gate, and all guards apply unchanged. — ✅ **delivered**

> **B2b landed.** `MT5Adapter` now also implements the `BrokerAdapter` side —
> `place_order` / `cancel_order` / `modify_order` / `positions` /
> `account_summary` over the sidecar's order endpoints. Placement runs the
> **same** `_validate_common` order validation + `LIVE_TRADING_ENABLED` gate the
> IB path uses (a live order without the gate is refused before anything reaches
> the bridge), and the result is shaped like the IB path so `order_audit`
> reconciles uniformly. The registry registers MT5's broker side alongside its
> data side when `MT5_BRIDGE_URL` is set, so a backend `broker=mt5` order flows
> end-to-end: backend validates + audits + net-caps (per-`(broker,symbol,mode)`)
> → `broker_service /orders` → `MT5Adapter.place_order` → sidecar. pytest covers
> placement (paper), the live gate failing closed, cancel, positions and
> account. No backend change was needed — the `broker=` plumbing from B1 already
> carries it.

> **B2a landed.** `broker_service/mt5_adapter.py` is the Linux-side thin HTTP client
> for the sidecar: a data-only `MarketDataAdapter` that forwards `search`,
> `historical_bars`, `realtime_quote` and `tick` to `MT5_BRIDGE_URL` and
> normalises responses into the app's shapes (UTC unix-second bars,
> `CandlestickBar`/`RealTimeQuote`, indicators via the shared calculator). It
> registers under `mt5` **only when `MT5_BRIDGE_URL` is set** — otherwise `mt5`
> stays a recognised-but-unavailable source (501). The historical/realtime/tick
> and contract-search routes dispatch non-IB sources to it; `source=ib` is
> untouched. pytest fakes the HTTP layer to cover the timeframe map, timestamp
> coercion, response shaping, indicator parity and error translation (bridge
> down → 503, 5xx → 502). The Windows sidecar itself (the `MetaTrader5` server)
> is deployed out-of-repo against the contract documented in the adapter.

**DoD (data):** a symbol charts + streams live via `source=mt5`.
**DoD (exec):** a **paper** order places through MT5 end-to-end, gated and
audited identically to IB.

### B3. Alpaca and OANDA adapters — ✅ delivered

Unlike MT5, both are cloud REST APIs reachable directly from Linux — no
Windows terminal, no sidecar host, no separate deployment topology. Each is
an in-process `httpx` client in `broker_service`, implementing the identical
`MarketDataAdapter` + `BrokerAdapter` surface as MT5, gated by API
credentials instead of a bridge URL:

- **`broker_service/alpaca_adapter.py`** — `AlpacaAdapter`, registered when
  `ALPACA_API_KEY` and `ALPACA_API_SECRET` are both set (`ALPACA_PAPER`
  selects paper vs. live). Order types map 1:1 to IB's vocabulary
  (`MKT/LMT/STP/STP_LMT`), so no order type is unsupported.
- **`broker_service/oanda_adapter.py`** — `OANDAAdapter`, registered when
  `OANDA_API_TOKEN` and `OANDA_ACCOUNT_ID` are both set (`OANDA_ENVIRONMENT`
  selects practice vs. live). Two OANDA-specific quirks the rest of the
  codebase doesn't see: symbols are normalised to OANDA's underscore form
  (`EUR.USD` ↔ `EUR_USD`), and direction is a *signed* `units` value rather
  than a separate side field. OANDA has a native 8-hour candle (an advantage
  over MT5, which has none), so every app timeframe maps cleanly; `STP_LMT`
  has no OANDA equivalent and is rejected with a 400.

Both follow B1's registry pattern exactly — an unconfigured provider
resolves to a clean 501, not a 404/400 — and both reuse the same
`_validate_common` order-validation + `LIVE_TRADING_ENABLED` gate as
IB/MT5 before anything reaches the broker. Position sizing for Alpaca
resolves through the same share-based path as IB (`orderSizing.ts`); OANDA's
`units` sizing is out of scope for now, same as MT5's `lots`.

**DoD (data):** a symbol charts + streams live via `source=alpaca` /
`source=oanda`. **DoD (exec):** a **paper** order places through each venue
end-to-end, gated and audited identically to IB.

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
| **3** | A3 auto-execution + risk layer, **paper** ✅ | 2 | gated, paper-only |
| **4** | A5 `/systematic` monitoring UI + chart markers ✅ | 3 | none |
| **5** | B1 broker abstraction (IB refactored behind interface) ✅ | — (parallelisable) | none (`source=ib` unchanged) |
| **6** | B2a MetaTrader **data** source ✅ | 5 | none (read-only) |
| **7** | B2b MetaTrader **execution** venue ✅ | 5, 6 | gated, paper-only |
| **8** | B3 Alpaca + OANDA data **and** execution venues ✅ | 5 | gated, paper-only |
| **9** | A1b/A1c: backtest saved definitions; instrument + venue scope; position-aware backtest parity ✅ | 1–5 | none (backtest + read paths) |

Phases 1–4 (systematic engine) and 5–8 (broker venues) are largely
independent; 5 can start in parallel with 1. Live (non-paper) auto-trading is
deliberately the *last* switch flipped, after phases 3, 7 and 8 have proven
out on paper.

---

## 8. New environment variables

| Var | Default | Purpose |
|---|---|---|
| `SYSTEMATIC_ENABLED` | `false` | Enable the strategy runner at all (signal-only from phase 2) |
| `SYSTEMATIC_EXECUTION_ENABLED` | `false` | Allow the engine to place orders (phase 3+) |
| `SYSTEMATIC_MAX_ORDERS_PER_DAY` | `0` (off) | Global backstop across all runs |
| `MT5_BRIDGE_URL` | _unset_ | HTTP endpoint of the MT5 sidecar (phase 6+) |
| `MT5_BRIDGE_SECRET` | _unset_ | Shared secret sent as `X-MT5-Bridge-Secret` on every sidecar request; the sidecar must enforce it |
| `ALPACA_API_KEY` / `ALPACA_API_SECRET` | _unset_ | Alpaca credentials — both required to register the adapter |
| `ALPACA_PAPER` | `true` | Alpaca paper vs. live trading endpoint |
| `OANDA_API_TOKEN` / `OANDA_ACCOUNT_ID` | _unset_ | OANDA credentials — both required to register the adapter |
| `OANDA_ENVIRONMENT` | `practice` | OANDA practice vs. live endpoint |
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
  dedicated parity test suite as A1 lands. *(Position-aware operands are now
  simulated — see A1's parity note. Sessions and multi-TF share one code path
  between the two engines. Intrabar fills remain a known divergence: the
  backtest fills at the bar close, live fills at the market.)*
- **MT5 account/equity source** for `pct_equity` sizing — confirm the sidecar
  exposes live account equity per run.

**Open — highest-priority remaining gaps for systematic deployment:**

1. ~~**`/account/positions` is IB-only.**~~ ✅ **Closed.** The route now takes
   `broker=` and dispatches through `get_broker_adapter()`; `broker=ib` keeps
   the existing synchronous IB path byte-for-byte, an unknown broker is a 400
   and an unconfigured one a 501. Each adapter's `positions()` — previously
   dead code returning the raw venue payload — now normalises to the app's
   `models.Position` shape, which is where the per-venue quirks live: Alpaca
   signs `qty` directly, OANDA splits an instrument into independent long/short
   legs that must be netted (taking the average price from whichever leg is
   open, since averaging the prices would be meaningless) and reports
   underscore instruments that map back to the app's dotted form, and the MT5
   sidecar is read defensively for either MT5's native `volume`/`type`/
   `price_open` fields or the app's own vocabulary. The runner's avg-cost
   lookup is now keyed per broker, so `position.unrealized_pct` rules fire on
   every venue rather than IB alone.
   ✅ **Now fully closed.** `/account/summary`, `/account/orders` and
   `/account/all` also take `broker=` and dispatch through the registry, and
   each adapter's `account_summary()` / new `open_orders()` normalise to
   `models.AccountSummary` / `models.Order`. That normalisation made
   `pct_equity` sizing reachable for the first time — it had been rejected
   outright because nothing supplied an equity figure; the engine now reads net
   liquidation from the run's own venue. (`models.Order.order_id` widened to a
   string: IB's ids are numeric, Alpaca's are UUIDs, OANDA's are numeric
   strings.) The run's *size* still comes from the audit log — see 3.
2. ~~**`risk.max_daily_loss` is accepted but never enforced.**~~ ✅ **Closed.**
   The `ExecutionEngine` now measures it against **realised P&L from the run's
   own fills** — a loss is only a loss once it has traded, which is why (3) had
   to land first. It gates **entries only**: blocking an exit would strand the
   position in the very trade that caused the loss. It **fails closed**, like
   the position-limit guard — a declared cap with no P&L source, an unreachable
   database, or a non-finite result all block the order.
3. ~~**The position model is built on submitted orders, not fills.**~~
   ✅ **Feed shipped.** `GET /account/executions?broker=&days=` normalises every
   venue's execution reports into one shape (IB `execDetails` +
   `commissionReport`, Alpaca `FILL` activities, OANDA `ORDER_FILL`
   transactions, MT5 sidecar deals), and an opt-in backend poller
   (`EXECUTIONS_SYNC_ENABLED`) syncs them into `order_executions`. The window
   overlaps deliberately — a fill can be reported late and IB delivers a fill's
   commission on a separate callback — with `(broker, exec_id)` making
   re-delivery a no-op and a `COALESCE` conflict path letting a late value fill
   a NULL without a later poll erasing one. Fills are attributed back to
   `order_audit` and thence to the run, with a re-link pass for fills polled
   before their order id was recorded. Realised P&L is a pure average-cost
   reducer handling partial exits, reversals through flat and commissions.
   Exposed at `/api/account/executions` and `/api/account/pnl`.

   **The one carry-over:** a run's `position.size` still reads the order-audit
   net. The venue's size *is* fill-derived and now trivially available — but it
   reports the whole **account's** exposure, so a second run on the same symbol,
   or a manual trade, would silently fold into this run's position and change
   what its sizing and pyramiding rules do. Making runs venue-authoritative
   needs a decision on how to attribute account-level exposure to individual
   runs (per-run sub-accounts, an attribution ledger keyed off
   `order_executions`, or simply accepting account-level semantics and
   documenting it). That decision, not the plumbing, is what is left.
4. ~~**Sizing is ignored by the backtester.**~~ ✅ **Closed.** `BacktestEngine`
   resolves the definition's `sizing` block through `broker_service/sizing.py`
   (kept semantically identical to the live `orderSizing.ts`) and drives
   `scale_out` rungs per bar via a new `RuleStrategy.evaluate_scale_out`,
   following the same one-way-dependency pattern as `evaluate_bar`. Each rung
   fires at most once per open trade — a threshold rung would otherwise re-fire
   on every subsequent bar past its level and bleed the position out — and a
   firing rung closes a slice as its own `Trade`, leaving the remainder open at
   the same entry price so the trade list and every metric stay coherent. A
   strategy declaring no sizing keeps the all-in behaviour, so the built-ins
   are unchanged.

**Position attribution — decided ✅.** Of the three options named above, the
**attribution ledger** is the one that ships. Per-run sub-accounts need
venue-side provisioning not every broker offers, and accepting account-level
semantics is wrong the moment a second run touches the same instrument. The
ledger was already latent in the data: each fill carries the `run_id` of the
signal that caused it.

What made it correct rather than merely available was recognising that neither
source is sufficient alone. **Fills lag** — the poller runs on its own timer, so
an order placed seconds ago reads as flat and a strategy could re-enter a
position it already holds. **Submitted orders are wrong** — that is the estimate
this work replaced, blind to a partial fill and dropping a
partially-filled-then-cancelled order entirely, losing shares genuinely held.

So a position is **fills plus the unfilled remainder of still-working orders**.
Every fill counts whatever became of its order; every alive order contributes
only what has *not* yet filled. An order therefore transitions smoothly from
"in flight" to "filled" without ever being double-counted or briefly invisible.
With the fills feed off this degrades *exactly* to the old estimate, so enabling
the feed — not deploying this — is what changes behaviour.

The scope of the ledger is the decision itself: **with** a run id it is that
run's own exposure (so a second run on the same symbol, or a manual trade,
cannot change its sizing and pyramiding); **without** one it is whole-account
exposure at that venue, which is the right basis for a fat-finger cap like
`ORDER_MAX_POSITION`. Per-run attribution can still drift from the account — a
manual trade belongs to no run, a corporate action to no order — so that drift
is made *visible* at `GET /api/account/reconciliation` rather than hidden.

**Open — what is actually left:**

1. **Intrabar fills.** The backtester fills at the bar close, live fills happen
   at the market. Sessions, multi-timeframe operands, position-aware rules,
   sizing and scale-outs now share one code path between the two engines, so
   this is the main remaining source of backtest↔live drift.
2. **Futures/options contract multipliers on IB.** `IBAdapter.instrument_spec`
   returns the whole-share constant rather than calling `reqContractDetails`,
   which is right for the STK path the app trades and would need revisiting to
   size a futures contract natively.
3. **The MT5 sidecar's own auth.** `MT5Adapter` sends `X-MT5-Bridge-Secret`
   when configured; the sidecar rejecting requests that lack it has to be
   implemented on the Windows host, outside this repo. The sidecar contract now
   also expects `GET /orders`, `GET /deals` and `GET /symbol` — likewise
   implemented there.

~~**MT5 `lots` / OANDA `units` sizing**~~ ✅ **Closed.** Both resolve to a
broker-native quantity now. The venue supplies an `InstrumentSpec`
(`GET /instrument/spec?symbol=&broker=`) carrying `contract_size` (what one
quantity unit controls — 1 for a share and for an OANDA unit, typically 100000
for a standard FX lot), `size_step` and `min_size`. Notional and
percent-of-equity sizing divide by `price × contract_size`, which is exactly
the factor that made lot sizing un-approximable: getting it wrong is a
five-order-of-magnitude error, not a rounding one. Sizes **floor** onto the
step and are refused below the minimum — rounding up would place a larger order
than the strategy asked for. The live sizer (`orderSizing.ts`) and the
backtester (`sizing.py`) share the semantics, and an exit closes the position
rounded onto the step rather than floored to a whole number, which would have
stranded a fractional lot open forever.

---

_Update this document as phases land; move completed phases into
`FEATURES.md` under "Currently Available" and cross-reference from
`GAP_ANALYSIS.md`._
