# Multi-Platform, Multi-Account — Systematic Trading Across Many Broker Connections

**Status:** C-0 through C-4 delivered; C-5 (UI/ops) planned
**Scope:** run the existing systematic stack against **N simultaneous broker
connections**, spanning multiple *platforms* (MT5, IB, Alpaca, OANDA) and
multiple *accounts per platform* — rather than the one-account-per-platform
model supported today. **This round of development targets MT5**, but the
structures are platform-generic by design and MT5 is the first consumer, not
the special case.
**Prerequisites:** Component A (systematic engine) and Component B (broker
seam + adapters) from [SYSTEMATIC_TRADING_ROADMAP.md](SYSTEMATIC_TRADING_ROADMAP.md)
— both delivered.

This document is Component **C** of that roadmap. It assumes B1/B2 vocabulary
(`adapters.py`, the adapter protocols, `source=`/`broker=`) throughout.

### Terminology

The word "broker" is overloaded in the existing code, which is the root of the
problem this document solves. Throughout, precisely:

- **Platform** — the protocol and integration: `ib`, `mt5`, `alpaca`, `oanda`.
  This is what `broker=` means in today's code.
- **Account** — one set of credentials at one firm on one platform:
  `pepperstone-live`, `icmarkets-demo`.
- **Connection** — the addressable pair `(platform, account)`, e.g.
  `mt5:pepperstone-live`. This is the unit the whole document is about.

---

## 1. Why this is net-new

The platform already trades MT5, IB, Alpaca and OANDA. It cannot trade **more
than one account on any of them**, and the reason is a single design decision
made in B1 that was correct then and is the binding constraint now:

> **`broker` is both the *platform* and the *account identity*.**

`broker='mt5'` names a platform, but the code uses it as if it named a
concrete, singular connection. Every layer inherits that assumption — and note
this is **not an MT5 problem**: `ib`, `alpaca` and `oanda` are each equally
locked to one account by the same code.

| Layer | File | The singular assumption |
|---|---|---|
| Config | `.env` | One `MT5_BRIDGE_URL`, one `MT5_BRIDGE_SECRET` |
| Registry | `broker_service/adapters.py:98-99` | `_broker: Dict[str, BrokerAdapter]` keyed by **provider name** — one slot for `"mt5"` |
| Bootstrap | `broker_service/adapters.py:169-185` | Constructs exactly one `MT5Adapter(bridge)` |
| Order type | `backend/src/services/orderTypes.ts:30` | `BROKERS = ['ib','mt5','alpaca','oanda']` — a closed enum of *providers* |
| Schema | `timescaledb-schema.sql` | `broker VARCHAR(16)` on `order_audit`, `order_executions`, `strategy_runs`, `strategy_definitions`, `contracts`, `data_collection_config` |
| Runner | `backend/src/services/strategyRunner.ts:172-230` | Caches keyed `broker` → one equity/positions/spec set per *provider* |
| Poller | `backend/src/services/executionsPoller.ts:197-199` | Iterates `activeBrokers()` — provider strings |

So "add a second account" has nowhere to go, in the same way "add MetaTrader"
had nowhere to go before B1. This plan introduces the equivalent seam one level
down: **connection identity**.

### 1.0 One firm, two platforms — the dual-path trap

Several firms are reachable **both** through their own API and through their
MT5 offering. OANDA is the sharpest case: this repo already implements
`oanda_adapter.py` against OANDA's native REST API, *and* OANDA offers MT5
accounts. IG Markets is the same shape. Pepperstone offers MT4/MT5 and cTrader.

So `oanda:live` and `mt5:oanda-live` may be **two routes to the same money**,
with different symbol names, different instrument specs, different fills and
different capabilities. The connection model handles this correctly — they are
simply two connections — but two hazards follow, and neither is hypothetical:

1. **Aggregate exposure double-counts.** The portfolio caps in C5 would see one
   account's position twice, or treat one account's equity as two accounts'
   worth of risk budget.
2. **Two runs can trade the same money believing they are independent.** Each
   sees "its" position and sizes accordingly; the firm sees one account being
   traded by two strategies at twice the intended size.

**Design response:** a connection manifest entry may declare a
`same_funds_as: <connection-id>` link. Connections so linked are treated as one
account for aggregate exposure and are **refused as simultaneous targets of the
same run group**. This is cheap to add now and expensive to retrofit after a
fleet is live — and it cannot be detected automatically, since nothing in
either API reveals that the accounts are the same underlying funds.

### 1.1 Three latent correctness bugs, not just a missing feature

Pointing a second MT5 terminal at the stack today would not merely fail to
work — it would corrupt state, silently. These are the acceptance tests that
matter most:

1. **Fill de-duplication collides across accounts.**
   `order_executions` is unique on `(broker, exec_id)`
   (`timescaledb-schema.sql:541`). MT5 deal tickets are allocated **per
   terminal**, starting low. Two MT5 accounts will both produce deal `12345`
   within days of each other. The second one is silently swallowed as a
   duplicate — the fill never lands, the position is wrong, realised P&L is
   wrong, and the `max_daily_loss` cap that reads from it
   (`executionEngine.ts:135-163`) under-counts losses **and therefore keeps
   trading**. This is the single highest-severity item in this plan.

2. **The net-exposure position limit sums unrelated accounts.**
   `OrderAuditRepository.netExposure` and its index are keyed
   `(broker, symbol, account_mode)` (`timescaledb-schema.sql:406-409`). Three
   MT5 accounts each 1 lot long EURUSD present as **3 lots** against a limit
   meant to be per-account. The guard fails *closed*, so the symptom is
   entries mysteriously refused on accounts that are nowhere near their
   limit — an availability failure that looks like a bug and invites someone
   to raise the limit, which then removes the protection from all three.

3. **One dead sidecar stalls every other connection.**
   `StrategyRunner.runOnce` iterates runs strictly sequentially
   (`strategyRunner.ts:409-411`) and `fetchHistory` uses a 60 s timeout
   (`strategyRunner.ts:269`). One MT5 host that is powered on but not
   responding — the common failure, since the terminal is a GUI app that can
   sit at a login dialog — costs 60 s **per run on that connection, per
   tick**. With the default 60 s interval, three stuck runs mean the healthy
   accounts stop evaluating entirely. Multi-connection makes a single-venue
   annoyance into a fleet-wide outage.

None of the three are visible with one connection, which is exactly why they
are still here.

---

## 2. Guiding principles

Carried from the roadmap, plus two specific to this component:

- **Fail closed.** Every new check aborts before the sidecar hop. An
  unresolvable connection is a refusal, never a fallback to a *different*
  account. Routing an order to the wrong MT5 account is the worst outcome this
  system can produce and must be structurally impossible, not merely unlikely.
- **Additive schema.** New columns with defaults that reproduce today's
  behaviour; no destructive migration. A deployment with one MT5 connection
  must behave byte-for-byte as it does now, before and after.
- **Reuse the per-run risk machinery, don't rebuild it.** The engine already
  has fail-closed daily order caps, loss caps, kill switches and sizing, all
  scoped per run. Multi-connection should ride on that, not grow a parallel
  fan-out executor with its own half-complete copy of the guards.
- **Secrets stay in env.** Connection *topology* may live in config or the DB;
  connection *credentials* never do.
- **The sidecar contract does not change.** Each MT5 connection is the same
  HTTP contract documented in `mt5_adapter.py:13-35`, at a different URL. No
  new sidecar work is required to start.

---

## 3. Target architecture

```
                        ┌──────────────────────────────────────────────┐
   strategy_definitions │  one rule-set, instrument-scoped             │
            │           └──────────────────────────────────────────────┘
            │  deploy to N connections  (one run_group)
            ▼
   strategy_runs ──┬── run#1  broker=mt5  account=icmarkets-live
                   ├── run#2  broker=mt5  account=pepperstone-live
                   ├── run#3  broker=mt5  account=ftmo-challenge
                   └── run#4  broker=ib   account=default
                          │
                          │  each run keeps its OWN position, caps, sizing
                          ▼
              ExecutionEngine  (unchanged decision tree)
                          │
                          ▼
        /api/orders  { broker: 'mt5', broker_account: 'ftmo-challenge' }
                          │
                          ▼
      broker_service  connection registry  (provider, account) ──▶ adapter
              │                │                    │
              ▼                ▼                    ▼
       MT5 sidecar A    MT5 sidecar B        MT5 sidecar C
       (Windows host)   (Windows host)       (same host, 2nd terminal)
```

**The central design choice:** a connection is addressed by the pair
`(broker, broker_account)`, and **one `strategy_runs` row still means one
instrument on one connection**. Deploying a definition to five accounts creates
five runs sharing a `run_group_id`.

### 3.1 Why runs-per-connection rather than a fan-out executor

The tempting alternative is one run that places N orders. Rejected, because
every risk guard in `ExecutionEngine` is *per run*: `max_orders_per_day`,
`max_daily_loss` measured from that run's fills
(`strategyRunner.ts:160`), the kill-switch status re-check, position sizing
from `netPositionWithOpenOrders({ runId })`. A fan-out executor would have to
reimplement all of them per-leg, and each reimplementation is a new place for a
cap to become a silent no-op — the exact failure the roadmap already fixed once
for `max_daily_loss`.

With runs-per-connection, all of that machinery is **already correct** and
already unit-tested; a leg that breaches its own daily loss cap stops on its
own account while its siblings continue, which is also the behaviour you
actually want across prop-firm accounts with different rules. The group is then
a thin reporting and lifecycle layer (start/stop/aggregate all legs together),
not a risk layer.

Cost of this choice: N× the evaluation traffic, since each run fetches its own
history. §5 (C6) addresses that with a shared bar cache — bars for the *same*
canonical instrument and timeframe are broker-specific data but only need one
fetch per connection per bar, not one per run per tick.

---

## 4. Components

### C1. Connection identity — the enabling refactor

The B1-equivalent for this component. Nothing else in the plan can land first.

- Introduce `broker_account` (VARCHAR(64), `NOT NULL DEFAULT 'default'`)
  alongside `broker` on: `order_audit`, `order_executions`, `strategy_runs`,
  `strategy_definitions`, `contracts`, `data_collection_config`.
  `'default'` reproduces today's single-connection semantics exactly.
- Canonical string form for logs, request ids and UI: `mt5:icmarkets-live`;
  `ib` alone remains valid shorthand for `ib:default`. Parsing lives in one
  helper on each side, never inline.
- Extend uniqueness and indexes to the pair — **this is bug ①'s fix**:
  - `order_executions`: `UNIQUE (broker, exec_id)` → `UNIQUE (broker, broker_account, exec_id)`
  - `contracts`: broker-scoped key gains `broker_account`
  - `data_collection_config`: same
  - `order_audit` net-exposure index → `(broker, broker_account, symbol, account_mode, submitted_at DESC)` — **bug ②'s fix**
- `orderTypes.ts`: keep `BROKERS` as the provider enum, add a separate
  `broker_account` field to `OrderInput`/`ValidatedOrder` with its own
  validation (charset `[a-z0-9-_]`, length ≤ 64, lowercased). Do **not**
  overload the `broker` enum with `mt5:alias` strings — every `isBroker()`
  call site would silently start rejecting valid input, and the column is
  `VARCHAR(16)`.

**Migration note.** The `order_executions` unique-key change must be applied
before a second MT5 connection is configured, not after — once colliding
tickets are in the table, the new constraint can be created but the already-lost
fills cannot be recovered without a re-poll window. Sequence the deploy
accordingly, and treat "second connection configured while schema is old" as a
startup-refusal condition (C7).

**DoD:** every persisted row carries a connection identity; a single-connection
deployment is unchanged; `UNIQUE (broker, broker_account, exec_id)` proven by a
test that ingests the same `exec_id` from two accounts and gets two rows.

---

### C2. Connection registry (`broker_service`)

Generalise `adapters.py` from platform-keyed to connection-keyed.

- `_broker` / `_market_data` become `Dict[tuple[str, str], Adapter]`.
- `get_broker_adapter(platform, account)` /
  `get_market_data_adapter(source, account)`; omitted account resolves to that
  platform's designated default connection, preserving current call sites.
- **One manifest for all platforms**, not one env var per platform. Secrets are
  **referenced by env-var name** rather than contained:

  ```jsonc
  // BROKER_CONNECTIONS (JSON, or a path via BROKER_CONNECTIONS_FILE)
  [
    { "id": "pepperstone-live", "platform": "mt5",
      "url": "http://10.7.3.22:9100", "secret_env": "MT5_SECRET_PEPPERSTONE",
      "account_mode": "live", "currency": "USD", "default": true,
      "server_timezone": "Etc/GMT-2" },

    { "id": "icmarkets-demo",   "platform": "mt5",
      "url": "http://10.7.3.23:9100", "secret_env": "MT5_SECRET_ICMARKETS",
      "account_mode": "paper", "currency": "USD" },

    { "id": "oanda-mt5",        "platform": "mt5",
      "url": "http://10.7.3.24:9100", "secret_env": "MT5_SECRET_OANDA",
      "account_mode": "live", "currency": "USD",
      "same_funds_as": "oanda-native" },          // see §1.0

    { "id": "oanda-native",     "platform": "oanda",
      "token_env": "OANDA_API_TOKEN", "account_env": "OANDA_ACCOUNT_ID",
      "account_mode": "live", "currency": "USD" }
  ]
  ```

  A platform-generic manifest is the point: adding a second IB or Alpaca
  account later is a manifest entry, not another round of this work.
  Platform-specific fields (`url` for MT5's sidecar, `token_env` for OANDA)
  are validated per platform.
- **Backwards compatibility:** the existing single-account env vars
  (`MT5_BRIDGE_URL`/`MT5_BRIDGE_SECRET`, `ALPACA_API_KEY`/`_SECRET`,
  `OANDA_API_TOKEN`/`_ACCOUNT_ID`, and IB's host/port) each synthesise one
  connection named `<platform>:default` when no manifest is present. Setting
  both forms is a startup error, not a silent precedence rule.
- `account_mode` on the connection is a **binding constraint**, not a
  default: a `live` order addressed to a connection declared `paper` is
  refused. This makes "demo account accidentally traded live sizing", and its
  much worse inverse, a config-level impossibility rather than a discipline
  problem.
- `server_timezone` is recorded per connection. **PLACEHOLDER (C-P1):** the
  fleet currently accepts each broker's own server clock as authoritative for
  its session windows, which means legs of one group can open and close at
  different wall-clock moments when brokers sit on different offsets. Recording
  the timezone now makes that divergence *visible* and makes normalising it
  later a behaviour change rather than a schema change. Revisit before running
  session-sensitive strategies across brokers on differing offsets.
- `provider_health()` reports per connection, not per platform.
- The existing missing-secret warning (`adapters.py:174-183`) fires per
  connection, naming the connection.

**DoD:** three connections spanning at least two platforms registered from one
manifest; `/health` lists each with its own reachability;
`broker=mt5&account=icmarkets-demo` and `broker=mt5&account=pepperstone-live`
reach different sidecars, proven against two fakes.

---

### C3. Symbol mapping and per-connection instrument specs

The problem that makes many accounts qualitatively different from many
platforms: **the same instrument has a different symbol and different trading
rules at every broker.** EURUSD is `EURUSD` at one, `EURUSD.a` / `EURUSD_i` /
`EURUSD.pro` at others; contract size, `volume_min`, `volume_step`, stop level
and filling mode all vary. A definition written once must resolve correctly on
each connection or the fleet silently trades different things.

**No static instrument catalogue.** The app must not ship a hardcoded list of
what each broker offers — that list is stale the day it is written and differs
per account tier. Availability is **discovered at runtime** from each
connection's own `/symbols`, cached, and surfaced in the deploy UI. This is
also why symbol resolution is a deploy-time step with a visible result rather
than a config file someone maintains.

- `strategy_definitions` carries a **canonical** symbol; each connection
  resolves it to its native symbol at run-creation time.
- Resolution order: explicit per-connection override (a `symbol_map` on the
  connection manifest) → suffix-rule match against the connection's own
  discovered `/symbols` catalogue → exact match → **refuse to start the leg**.
  Never a fuzzy best-effort match; picking the wrong instrument is worse than
  not running.
- The resolved native symbol is stored on the `strategy_runs` row, so a live
  run's instrument is a recorded fact, not re-derived per tick.
- `instrument_spec` caching in `strategyRunner.ts:183-212` re-keys from
  `broker:symbol` to `broker:account:symbol`. This is load-bearing, not
  hygiene: `min_size`/`size_step` genuinely differ per broker for the same
  pair, and the current cache would serve account A's lot step to account B —
  producing orders the second broker rejects, or worse, silently rounds.
- Surface the resolution in the UI at deploy time: "EURUSD → EURUSD.a
  (icmarkets-live), EURUSD_i (pepperstone-live), ✗ unavailable (ftmo)" — a
  reviewable mapping before anything starts, rather than a discovery made from
  a rejected order.

**DoD:** one definition on a canonical `EURUSD` deploys to three connections
with three different native symbols and three different lot steps; a connection
that cannot resolve the symbol refuses its leg and reports why, while the other
legs start.

---

### C4. Run groups — deploying one definition to N connections

- `strategy_runs` gains `run_group_id` (nullable BIGINT) and the resolved
  `native_symbol`.
- `POST /api/strategies/:id/deploy` accepts a list of connection targets, each
  with its own sizing/risk block (they *must* differ — a $10k FTMO challenge
  and a $200k live account cannot share a fixed lot size), and creates one run
  per target inside one group, transactionally: either every leg starts or
  none does.
- Group-level lifecycle: stop-group, and a **panic stop** that stops all runs
  on a connection or all runs everywhere. The existing per-run kill-switch
  re-check (`executionEngine.ts:98-101`) means an in-flight tick honours it
  without extra work.
- Group-level *reporting* aggregates legs. Group-level *risk* is C5.

#### C4a. Blast radius — the cost of one strategy on every account

With the fleet confirmed as **the same strategy on all accounts** (§8, item 3), the
group is not just a convenience: it is a shared failure domain, and two
consequences follow that a per-account fleet would not have.

- **Every leg fires the same signal at the same instant.** There is no
  diversification and no netting — N accounts long the same pair is N times
  the real exposure at N brokers, and slippage, rejections and requotes
  correlate across the fleet. This is precisely what C5's portfolio cap is
  for, which is a second reason it should not have waited for a later phase.
- **A bad rule-set edit deploys everywhere at once.** Today a mistake costs one
  account; grouped, it costs the fleet simultaneously. So a group deploy must
  be **staged, not atomic-all**: land the definition on one nominated canary
  connection, require it to evaluate cleanly for a configurable settle period,
  then admit the rest. Note this deliberately contradicts the transactional
  all-or-nothing deploy above — that rule is right for *creating* legs
  (partial group creation is just broken state) and wrong for *starting* them.
  Create all legs transactionally; start them in stages.
- Group edits are versioned against `strategy_definitions.version`, and a
  running group pins its version so an in-flight edit cannot half-apply across
  legs mid-session.

**DoD:** a group deploy starts its canary first and admits the remaining legs
only after the settle period; a rule-set edit to a running group does not take
effect on any leg until the group is redeployed.

**DoD:** one definition deployed to three connections yields three runs, one
group; stopping the group stops all three; a leg erroring does not stop its
siblings.

---

### C5. Fleet risk — per-connection and cross-connection caps

Today's caps are per-run and global (`SYSTEMATIC_MAX_ORDERS_PER_DAY`). Two
levels are missing, and multi-connection makes both load-bearing:

- **Per-connection caps.** A connection hosting several runs needs its own
  `max_orders_per_day`, `max_daily_loss` and net-exposure ceiling. This is the
  level a prop firm actually enforces — their rules are per account, not per
  strategy — so it is the level a breach must be detected at.
- **Cross-connection portfolio caps.** Aggregate exposure to one canonical
  instrument across all connections, and aggregate daily loss. Note this is
  *reporting-and-refusal*, not netting: three accounts long EURUSD are three
  real positions at three brokers, not one.
- Both evaluate in `ExecutionEngine` as additional fail-closed guards, in the
  same style as the existing ones — an unavailable input refuses the order
  rather than waiving the check (`executionEngine.ts:144-153` is the pattern).

**Currency: resolved — all accounts share one denomination** (§8, item 4), so
aggregate caps need no FX conversion and ship alongside the per-connection
caps rather than in a later phase.

That homogeneity is an *assumption to enforce, not to trust*. A connection
opened later in a different denomination would make every aggregate silently
wrong — the numbers still add up, they just mean nothing. So:

- Each connection declares its `currency` in the manifest, and the registry
  asserts the adapter's reported `account_summary().currency` matches it at
  startup and on reconnect. A mismatch marks the connection unusable rather
  than letting it join the pool.
- Any cross-connection aggregation asserts a single currency across its
  inputs, and **refuses to produce a number** if that does not hold. A refused
  aggregate fails the cap closed, consistent with every other guard.
- `PORTFOLIO_BASE_CURRENCY` records the expected denomination so the assertion
  has something to check against, rather than inferring it from whichever
  connection happens to register first.

This keeps the FX work genuinely out of scope while making the day a
second currency appears a loud failure instead of a quiet miscalculation.

**DoD:** a connection-level daily loss cap halts every run on that connection
while other connections continue trading; a portfolio-level cap halts new
entries fleet-wide; a breach is visible in the UI with the connection named; a
connection reporting an unexpected currency is refused at registration and its
runs never start.

---

### C6. Runner scheduling, isolation and caching

Fixes bug ③ and pays for C4's N× traffic.

- **Per-connection concurrency.** Group active runs by connection; process
  connections concurrently with a bounded pool, runs within a connection
  sequentially (one sidecar, one terminal — do not hammer it).
- **Circuit breaker per connection.** Consecutive failures open the breaker;
  the runner skips that connection with a recorded reason and probes it on a
  backoff instead of paying the full timeout on every tick. Runs on a broken
  connection are marked degraded, not errored-and-forgotten.
- **Tighter timeouts** for the per-tick path, distinct from the generous
  one-shot chart-history timeout.
- **Shared bar cache** keyed `(connection, native_symbol, timeframe)` with a
  TTL below the bar cadence, so ten runs on one instrument on one connection
  cost one history fetch per tick, not ten.
- Existing equity/avg-cost/spec caches (`strategyRunner.ts:172-212`) re-key to
  include the account — see C3.

**DoD:** with one connection's sidecar black-holing requests, runs on the other
connections continue evaluating on schedule; the breaker state is visible in
`/api/systematic/status`.

---

### C7. Fills, reconciliation and startup safety

- `executionsPoller` iterates **connections**, not providers
  (`executionsPoller.ts:197-199`, `executionRepository.ts:422`), and writes
  `broker_account` on every row.
- Per-connection poll isolation: one unreachable sidecar must not abort the
  sweep for the rest (the current per-broker try/catch shape already suits
  this — it needs the loop widened, not restructured).
- **Startup refusal:** if more than one connection is configured for a provider
  while the schema still has the old `UNIQUE (broker, exec_id)`, refuse to
  start. This is the guardrail that makes C1's migration-ordering hazard
  non-silent.
- Reconciliation report per connection: adapter-reported positions vs
  fills-derived positions, so a divergence is attributable to one account.

**DoD:** two MT5 connections emitting the same deal ticket produce two distinct
`order_executions` rows attributed to the right accounts; a stale-schema
multi-connection deployment fails fast with an actionable message.

---

### C8. UI and operations

- Connection picker throughout (`TradingAccountContext`, `OrderTicket`,
  `StrategyBuilder`, blotters), showing connection **health and declared
  account_mode** at the point of order entry — the live/demo distinction must
  be visible where the mistake would be made.
- `/systematic` gains a group view: one definition, N legs, per-leg position,
  P&L, cap headroom and connection health.
- Aggregate positions view across connections, with per-connection breakdown
  and no cross-account netting.
- Per-connection metrics/labels in Prometheus + Grafana (`ops/`), and alerts
  on connection down, breaker open, and cap breach.

**DoD:** an operator can see, on one screen, every connection's health and
every leg of every group, and can panic-stop a connection from there.

---

## 5. Phased delivery

Each phase is independently shippable and leaves the system correct.

| Phase | Contents | Ships |
|---|---|---|
| **C-0** ✅ | Bug ① and ② fixes alone: `broker_account` column + widened unique keys/indexes, defaulted to `'default'` | **Delivered.** Correctness fix; no behaviour change on one connection. **Deploy before any second connection exists.** |
| **C-1** ✅ | C1 remainder + C2 registry + manifest config | **Delivered.** Two MT5 connections addressable manually via `/api/orders`, `/account/*`, charts |
| **C-2** ✅ | C3 symbol mapping + per-connection specs | **Delivered.** A definition resolves correctly on each connection |
| **C-3** ✅ | C4 run groups + staged deploy (C4a) + C6 scheduling/isolation | **Delivered.** One definition trading on N connections, fault-isolated, canary-staged |
| **C-4** ✅ | C5 per-connection **and** portfolio caps + C7 reconciliation | **Delivered.** Fleet-safe; per-account and fleet-wide limits enforced |
| **C-5** | C8 UI/ops | Operable at fleet scale |

Phase C-0 is worth shipping on its own even if the rest is deferred: it is
small, it is a latent-data-loss fix, and it is the migration that is painful to
apply late.

> **C-0 delivered.** `broker_account VARCHAR(64) NOT NULL DEFAULT 'default'` on
> `order_audit`, `order_executions`, `strategy_runs`, `strategy_definitions`
> and `contracts`; `order_executions` re-keyed to
> `UNIQUE (broker, broker_account, exec_id)`; the net-exposure index and query
> re-keyed to include the account. `Connection` (`{broker, brokerAccount}`) is
> the in-code type, with `connectionOf()` mapping persisted rows onto it and
> `connectionLabel()` producing `platform:account` for logs. The poller
> iterates connections and stamps each fill with the connection it polled,
> never a value from the payload. Runner caches (equity, average cost,
> instrument spec) and the execution engine's sizing deps re-keyed from
> platform to connection.
>
> Two things worth recording from the implementation:
>
> - **`data_collection_config` needed no column.** It keys on `contract_id`, so
>   it inherits connection scoping through `contracts` — the plan listed it, but
>   adding the column would have been redundant denormalisation.
> - **Renamed indexes and constraints rather than redefining in place.**
>   `CREATE INDEX IF NOT EXISTS` against an existing name silently keeps the old
>   definition, which would have left the bug in place on exactly the
>   deployments that need the fix. The old names are dropped and the new
>   definitions created under new names. The `ALTER TABLE … ADD COLUMN`
>   statements must also precede the indexes that reference them, since
>   `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table.

> **C-1 delivered.** `broker_service/connections.py` parses one
> `BROKER_CONNECTIONS` manifest spanning all platforms, with secrets referenced
> by env-var name and never held in the manifest. `adapters.py` is re-keyed
> from platform to `(platform, account)`; `resolve_connection()` returns the
> connection and `get_broker_adapter(broker, account, account_mode=…)` enforces
> the declared mode. `account=` threads through every account, market-data,
> backtesting, contract and order route, and through the backend's proxy routes
> and venue helpers. `/health` and `/providers` report per connection, with
> `same_funds_groups()` surfacing declared overlaps. Legacy per-platform env
> vars synthesise `<platform>:default`, so an untouched deployment is unchanged.
>
> Three decisions worth recording:
>
> - **Mode mismatch is 409, not 400.** The request is well-formed and the
>   connection exists — they are simply incompatible. Rerouting it to a
>   "compatible" connection would be the dangerous outcome, so it refuses.
> - **An unknown account is 400, never a fall-through to the platform default.**
>   Silently defaulting is precisely how an order reaches the wrong account, so
>   the error names the accounts that *are* configured instead.
> - **Manifest plus a legacy variable is a startup error.** Supporting both
>   needs a precedence rule, and the cost of guessing wrong is an order on the
>   wrong account. `provider_health()` still reports a broken manifest rather
>   than 500ing, so the operator can see why nothing registered.

> **C-2 delivered.** `broker_service/symbol_resolution.py` resolves a canonical
> symbol to each connection's native one — manifest override, then exact match,
> then a *single* suffix match against the connection's own discovered
> catalogue, then refusal. `GET /instrument/resolve` does one connection;
> `POST /instrument/resolve/preview` does N and reports each independently, so
> a deploy shows "these legs resolve, this one does not, here is why" rather
> than one error hiding the rest. `strategy_runs.native_symbol` records the
> result, and the runner and execution engine trade *that* symbol via
> `runSymbol()`.
>
> Three decisions, all following from "a wrong instrument is worse than no run":
>
> - **Ambiguity refuses.** A connection offering both `EURUSD.a` and
>   `EURUSD.pro` gets a 422 naming both, not a guess. Only the operator knows
>   which tier the account trades, and a guess produces a plausible-looking run
>   on the wrong contract. The fix is a one-line `symbol_map` entry.
> - **The resolved symbol is stored, not re-derived.** Re-resolving each tick
>   would let a catalogue change silently move a running strategy onto another
>   contract mid-position.
> - **The spec is fetched for the native symbol.** Asking a venue about
>   `EURUSD` when it trades `EURUSD.a` either errors or describes a different
>   contract — and lot step, minimum and contract size are exactly what sizing
>   divides by.
>
> Worth recording: the first draft of the suffix rule matched any short
> continuation, so canonical `EUR` "matched" `EURUSD`, `EURGBP` and `EURJPY` —
> and three matches read as *ambiguity* rather than as the mistake it was. The
> rule now requires either a separator (`.a`, `_i`, `-ECN`) or at most two bare
> characters (`EURUSDm`), so a currency-pair continuation never qualifies.

> **C-3 delivered.** `strategy_run_groups` plus `run_group_id` / `is_canary` on
> `strategy_runs`, and a new `pending` run status. `POST
> /api/strategies/definitions/:id/deploy` resolves every leg's symbol first
> (C-2), refuses the deploy if any leg cannot resolve unless `allow_partial` is
> passed, then creates all legs in one transaction with only the canary
> `running`. The runner admits the rest once the canary has both evaluated
> cleanly *and* been running for `settle_seconds`, and **abandons** the group
> if the canary failed. Group stop and per-connection panic stop are exposed as
> routes.
>
> Scheduling changed shape: runs are grouped by connection, connections
> processed concurrently under a bounded pool, runs within a connection kept
> sequential (one sidecar is one terminal). A per-connection circuit breaker
> skips a connection after repeated failures and probes it after a cooldown —
> closing bug ③, where one unresponsive host cost its full timeout per run per
> tick and starved every healthy account.
>
> Decisions worth recording:
>
> - **Atomic creation, staged starting.** These pull in opposite directions and
>   both are right: a half-created group is broken state, but starting every leg
>   at once means a bad edit reaches every account simultaneously.
> - **A failed canary abandons the group.** It must never fall through to
>   admission — stopping the remaining accounts from taking the risk is the
>   entire purpose of having a canary.
> - **Admission needs a clean evaluation *and* elapsed time.** Time alone would
>   admit a leg that started and immediately errored; a clean evaluation alone
>   would admit before a full bar closed on the slowest timeframe.
> - **The canary is named, never defaulted.** It is the account that takes the
>   first real risk from an unproven rule-set. If the nominated canary is the
>   leg that fails to resolve, the deploy refuses rather than silently promoting
>   another account into that role.
> - **E10 is enforced in the schema.** A partial unique index allows only one
>   active run per `(connection, native_symbol)`: under netting, two runs on one
>   instrument at one account each size against exposure neither controls.

> **C-4 delivered.** The execution engine gained two guard tiers above the
> per-run ones: **per-connection** order and loss caps (the level a broker or
> prop firm actually enforces at, and the level a connection hosting several
> runs can breach while each run sits inside its own), and a **portfolio**
> daily-loss cap. Both fail closed — an unreadable cap blocks the order — and
> both gate entries only, since blocking an exit would strand the position in
> the trade that caused the loss.
>
> The connection loss cap counts fills with no `run_id`: a manual trade is a
> real loss against an account budget even though it belongs to no strategy.
>
> **The currency assumption is enforced, not trusted.** `currency_consistency()`
> checks every connection's reported currency against `PORTFOLIO_BASE_CURRENCY`
> and surfaces it on `/providers`; the portfolio cap **refuses to aggregate**
> on a mismatch rather than summing mixed denominations into a number that adds
> up and means nothing. An unreadable topology reports *inconsistent*, not
> consistent — a cap that cannot verify its own units must not wave orders
> through.
>
> Reconciliation: `/api/account/reconciliation/all` reports every connection in
> one call and never fails as a whole, because "four are fine, this one is
> unreachable" is the actionable answer. This also fixed a real bug introduced
> in C-1 — the single-connection route compared one account's venue positions
> against the **default** account's recorded ones, reporting mismatches that
> were purely an artefact of the scope mismatch.
>
> `schemaGuard.ts` closes C-0's migration hazard: more than one connection on
> the pre-C-0 schema now refuses to start the systematic services, because
> colliding fills are dropped silently and widening the constraint afterwards
> recovers nothing. An unreadable database is reported as *indeterminate*
> rather than unsafe, so a transient outage is not a refusal to boot.

---

## 6. New environment variables

| Variable | Purpose |
|---|---|
| `BROKER_CONNECTIONS` | JSON array of connection descriptors, all platforms (id, platform, credentials-by-env-name, account_mode, currency, default, symbol_map, server_timezone, same_funds_as) |
| `BROKER_CONNECTIONS_FILE` | Path alternative to the above, for larger manifests |
| `MT5_SECRET_<ID>` | Per-connection MT5 sidecar shared secret, referenced by `secret_env` |
| `SYSTEMATIC_MAX_CONNECTION_CONCURRENCY` | Bounded pool width for the runner |
| `SYSTEMATIC_CONNECTION_BREAKER_THRESHOLD` / `_COOLDOWN_SECONDS` | Circuit breaker tuning |
| `PORTFOLIO_BASE_CURRENCY` | The denomination every connection is asserted to report; a mismatch refuses the connection and any aggregate that would span it |
| `SYSTEMATIC_GROUP_CANARY_SETTLE_SECONDS` | How long a group's canary leg must evaluate cleanly before the remaining legs are admitted |
| `BAR_DAY_BOUNDARY_TIMEZONE` / `_HOUR` | Where a trading day starts for constructed higher timeframes. Defaults `America/New_York` / `17` — **timezone-aware, never a fixed UTC offset**, since 17:00 New York is 21:00 UTC in summer and 22:00 UTC in winter |

The existing single-account env vars (`MT5_BRIDGE_URL` / `MT5_BRIDGE_SECRET`,
`ALPACA_API_KEY` / `_SECRET`, `OANDA_API_TOKEN` / `_ACCOUNT_ID`, IB host/port)
remain supported as the one-connection shorthand for their platform and are
**deprecated, not removed**.

---

## 7. Decisions taken in this plan

| Question | Decision | Rationale |
|---|---|---|
| Encode account in `broker` (`mt5:alias`) or a new column? | **New `broker_account` column** | `broker` is `VARCHAR(16)` and gates a closed enum; overloading breaks every `isBroker()` call site |
| One run fanning out, or one run per connection? | **One run per connection, grouped** | Reuses the entire tested per-run risk machinery; avoids reimplementing every cap per leg |
| Connection config in DB or env/manifest? | **Manifest for topology, env for secrets** | Secrets must not reach the DB or the settings endpoint; topology benefits from review in version control |
| Symbol resolution on mismatch | **Refuse the leg** | A fuzzy match silently trades the wrong instrument |
| Portfolio-level caps | **In scope at C-4, asserted single-currency** | All accounts share a denomination (§8, item 4), so no FX is needed — but the assumption is enforced, not trusted |
| Group deploy | **Legs created atomically, started in canary stages** | One strategy on every account means one bad edit hits the whole fleet at once |
| `account_mode` per connection | **Binding constraint, enforced at the registry** | Makes live/demo misrouting a config impossibility |

## 8. Resolved scope questions

Answered 2026-08-07; each confirms an assumption the plan had already made,
except item 4, which pulled portfolio caps forward a phase.

1. **Sidecar per terminal.** One sidecar process per MT5 terminal — the
   officially-supported shape, since each `MetaTrader5` binding attaches to one
   terminal. Costs N Windows processes and N ports; keeps account routing
   in-repo and testable, rather than pushing it into out-of-repo sidecar code
   this repo cannot cover. The multiplexing alternative is not pursued.
2. **Under 10 connections.** The bounded-pool design in C6 is sufficient at
   this scale; the work-queue alternative is dropped from scope. Revisit only
   if the fleet grows past roughly a dozen — it changes C6 and nothing else.
3. **Same strategy across all accounts.** Confirms C3 (symbol mapping) and C4
   (run groups) as the critical path, and the C-2 → C-3 phase order stands. It
   also makes the group a shared failure domain, which is what C4a's staged
   canary deploy and version pinning exist to contain.
4. **All accounts in one currency.** No FX conversion is required, so
   cross-connection aggregate caps move out of the deferred bucket and ship
   with the per-connection caps in C-4. The homogeneity is enforced as a
   startup and reconnect assertion (see C5) so a future second denomination
   fails loudly rather than quietly corrupting every aggregate.

### Still open

- **Live trading scope.** The engine remains gated to paper
  (`SYSTEMATIC_EXECUTION_ENABLED` + `LIVE_TRADING_ENABLED`). Nothing in this
  plan changes those gates, and the fleet should run paper across all
  connections before any live enablement is considered.
- **Canary settle period.** `SYSTEMATIC_GROUP_CANARY_SETTLE_SECONDS` needs a
  default. It should span at least one full bar of the slowest timeframe the
  fleet trades, so "evaluated cleanly" means the leg actually produced a
  decision rather than merely started without error.
