# Multi-Connection MT5 — Systematic Trading Across Many MT5 Accounts

**Status:** plan / not yet implemented
**Scope:** run the existing systematic stack against **N simultaneous MT5
broker connections** (IC Markets, Pepperstone, FTMO, a demo terminal, …)
rather than the single connection the platform supports today.
**Prerequisites:** Component A (systematic engine) and Component B (broker
seam + `MT5Adapter`) from [SYSTEMATIC_TRADING_ROADMAP.md](SYSTEMATIC_TRADING_ROADMAP.md)
— both delivered.

This document is Component **C** of that roadmap. It assumes B1/B2 vocabulary
(`adapters.py`, `MT5Adapter`, `source=`/`broker=`) throughout.

---

## 1. Why this is net-new

The platform already trades MT5. It cannot trade **more than one MT5 account**,
and the reason is a single design decision made in B1 that was correct then and
is the binding constraint now:

> **`broker` is both the *protocol* and the *account identity*.**

`broker='mt5'` names a provider *family*, but the code uses it as if it named a
concrete, singular connection. Every layer inherits that assumption:

| Layer | File | The singular assumption |
|---|---|---|
| Config | `.env` | One `MT5_BRIDGE_URL`, one `MT5_BRIDGE_SECRET` |
| Registry | `broker_service/adapters.py:98-99` | `_broker: Dict[str, BrokerAdapter]` keyed by **provider name** — one slot for `"mt5"` |
| Bootstrap | `broker_service/adapters.py:169-185` | Constructs exactly one `MT5Adapter(bridge)` |
| Order type | `backend/src/services/orderTypes.ts:30` | `BROKERS = ['ib','mt5','alpaca','oanda']` — a closed enum of *providers* |
| Schema | `timescaledb-schema.sql` | `broker VARCHAR(16)` on `order_audit`, `order_executions`, `strategy_runs`, `strategy_definitions`, `contracts`, `data_collection_config` |
| Runner | `backend/src/services/strategyRunner.ts:172-230` | Caches keyed `broker` → one equity/positions/spec set per *provider* |
| Poller | `backend/src/services/executionsPoller.ts:197-199` | Iterates `activeBrokers()` — provider strings |

So "add a second MT5 account" has nowhere to go, in the same way "add
MetaTrader" had nowhere to go before B1. This plan introduces the equivalent
seam one level down: **connection identity**.

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

Generalise `adapters.py` from provider-keyed to connection-keyed.

- `_broker` / `_market_data` become `Dict[tuple[str, str], Adapter]`.
- `get_broker_adapter(broker, account)` / `get_market_data_adapter(source, account)`;
  omitted account resolves to that provider's designated default connection,
  preserving current call sites.
- Configuration via a manifest that **references secrets by env-var name**
  rather than containing them:

  ```jsonc
  // MT5_CONNECTIONS (JSON, or a path via MT5_CONNECTIONS_FILE)
  [
    { "id": "icmarkets-live",  "url": "http://10.7.3.22:9100",
      "secret_env": "MT5_SECRET_ICMARKETS", "account_mode": "live",  "default": true },
    { "id": "ftmo-challenge",  "url": "http://10.7.3.23:9100",
      "secret_env": "MT5_SECRET_FTMO",      "account_mode": "live"  },
    { "id": "demo",            "url": "http://10.7.3.24:9100",
      "secret_env": "MT5_SECRET_DEMO",      "account_mode": "paper" }
  ]
  ```

- **Backwards compatibility:** an existing `MT5_BRIDGE_URL` /
  `MT5_BRIDGE_SECRET` with no manifest synthesises exactly one connection
  `mt5:default`. Setting both forms is a startup error, not a silent
  precedence rule.
- `account_mode` on the connection is a **binding constraint**, not a
  default: a `live` order addressed to a connection declared `paper` is
  refused. This makes "demo account accidentally traded live sizing", and its
  much worse inverse, a config-level impossibility rather than a discipline
  problem.
- `provider_health()` reports per connection, not per provider.
- The existing missing-secret warning (`adapters.py:174-183`) fires per
  connection, naming the connection.

**DoD:** three MT5 connections registered from a manifest; `/health` lists each
with its own reachability; `broker=mt5&account=demo` and
`broker=mt5&account=ftmo-challenge` reach different sidecars, proven against
two fakes.

---

### C3. Symbol mapping and per-connection instrument specs

The problem that makes multi-MT5 qualitatively different from multi-provider:
**the same instrument has a different symbol and different trading rules at
every MT5 broker.** EURUSD is `EURUSD` at one, `EURUSD.a` / `EURUSD_i` /
`EURUSD.pro` at others; contract size, `volume_min`, `volume_step`, stop level
and filling mode all vary. A definition written once must resolve correctly on
each connection or the fleet silently trades different things.

- `strategy_definitions` carries a **canonical** symbol; each connection
  resolves it to its native symbol at run-creation time.
- Resolution order: explicit per-connection override (a `symbol_map` on the
  connection manifest) → suffix-rule match against the connection's own
  `/symbols` catalogue → exact match → **refuse to start the leg**. Never a
  fuzzy best-effort match; picking the wrong instrument is worse than not
  running.
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

**Currency is an open problem here.** Accounts denominated in USD, AUD and EUR
cannot have their equity or realised P&L summed without an FX rate, and a
portfolio-level cap that sums raw numbers across denominations is wrong in a
way that looks plausible. **Recommendation:** ship per-connection caps first
(no conversion needed — each cap is evaluated in its own account's currency),
and gate cross-connection aggregate caps behind an explicit
`PORTFOLIO_BASE_CURRENCY` plus a rate source, refusing to aggregate rather than
mixing units when no rate is available. Per-connection caps deliver most of the
protection; the aggregate is a second increment.

**DoD:** a connection-level daily loss cap halts every run on that connection
while other connections continue trading; a breach is visible in the UI with
the connection named; mixed-currency aggregation refuses rather than
mis-reporting.

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
| **C-0** | Bug ① and ② fixes alone: `broker_account` column + widened unique keys/indexes, defaulted to `'default'` | Correctness fix; no behaviour change on one connection. **Deploy before any second connection exists.** |
| **C-1** | C1 remainder + C2 registry + manifest config | Two MT5 connections addressable manually via `/api/orders`, `/account/*`, charts |
| **C-2** | C3 symbol mapping + per-connection specs | A definition resolves correctly on each connection |
| **C-3** | C4 run groups + C6 scheduling/isolation | One definition trading on N connections, fault-isolated |
| **C-4** | C5 per-connection caps + C7 reconciliation | Fleet-safe; prop-firm-style per-account limits enforced |
| **C-5** | C8 UI/ops + cross-connection aggregate caps (currency-gated) | Operable at fleet scale |

Phase C-0 is worth shipping on its own even if the rest is deferred: it is
small, it is a latent-data-loss fix, and it is the migration that is painful to
apply late.

---

## 6. New environment variables

| Variable | Purpose |
|---|---|
| `MT5_CONNECTIONS` | JSON array of connection descriptors (id, url, secret_env, account_mode, default, symbol_map) |
| `MT5_CONNECTIONS_FILE` | Path alternative to the above, for larger manifests |
| `MT5_SECRET_<ID>` | Per-connection shared secret, referenced by `secret_env` |
| `SYSTEMATIC_MAX_CONNECTION_CONCURRENCY` | Bounded pool width for the runner |
| `SYSTEMATIC_CONNECTION_BREAKER_THRESHOLD` / `_COOLDOWN_SECONDS` | Circuit breaker tuning |
| `PORTFOLIO_BASE_CURRENCY` | Enables cross-connection aggregate caps; absent ⇒ aggregation refuses rather than mixes units |

`MT5_BRIDGE_URL` / `MT5_BRIDGE_SECRET` remain supported as the one-connection
shorthand and are **deprecated, not removed**.

---

## 7. Decisions taken in this plan

| Question | Decision | Rationale |
|---|---|---|
| Encode account in `broker` (`mt5:alias`) or a new column? | **New `broker_account` column** | `broker` is `VARCHAR(16)` and gates a closed enum; overloading breaks every `isBroker()` call site |
| One run fanning out, or one run per connection? | **One run per connection, grouped** | Reuses the entire tested per-run risk machinery; avoids reimplementing every cap per leg |
| Connection config in DB or env/manifest? | **Manifest for topology, env for secrets** | Secrets must not reach the DB or the settings endpoint; topology benefits from review in version control |
| Symbol resolution on mismatch | **Refuse the leg** | A fuzzy match silently trades the wrong instrument |
| Cross-currency portfolio caps | **Deferred behind explicit base currency** | Summing mixed denominations is wrong in a way that looks right |
| `account_mode` per connection | **Binding constraint, enforced at the registry** | Makes live/demo misrouting a config impossibility |

## 8. Open questions for review

1. **Sidecar-per-terminal or one sidecar, many terminals?** This plan assumes
   one sidecar process per MT5 terminal (each `MetaTrader5` binding attaches to
   one terminal), which is the officially-supported shape but means N Windows
   processes and N ports. A multiplexing sidecar is possible but pushes account
   routing into out-of-repo code, where this repo cannot test it. **Recommend
   one-per-terminal**; revisit only if host count becomes the constraint.
2. **How many connections realistically?** Under ~10 the bounded-pool design in
   C6 is ample. Materially beyond that and the runner should move to a work-queue
   model — worth knowing the target now, since it changes C6 but nothing else.
3. **Do the accounts run identical strategies or different ones?** Identical
   (copy-trading / prop-firm scaling) makes C3 symbol mapping and C4 groups the
   critical path. Different strategies per account makes C5 per-connection caps
   the critical path. The phase order above assumes the former; it is cheap to
   swap C-3 and C-4 if the latter.
4. **Live trading scope.** The existing engine is gated to paper
   (`SYSTEMATIC_EXECUTION_ENABLED` + `LIVE_TRADING_ENABLED`). Nothing in this
   plan changes those gates, and the fleet should run paper across all
   connections before any live enablement.
