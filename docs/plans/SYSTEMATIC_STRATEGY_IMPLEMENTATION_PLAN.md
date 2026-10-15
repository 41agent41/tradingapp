# Strategy Implementation — Language, Authoring Model, and Price Action

**Status:** plan / not yet implemented
**Scope:** how systematic strategies are *written and evaluated* — the language
they live in, the authoring model, and how **price-action** logic joins the
**indicator** logic that exists today.
**Prerequisites:** Component A (rule engine, `broker_service/rule_strategy.py`)
— delivered.

This is Component **D** of [SYSTEMATIC_TRADING_ROADMAP.md](SYSTEMATIC_TRADING_ROADMAP.md).
Component C ([MULTI_PLATFORM_CONNECTION_PLAN.md](MULTI_PLATFORM_CONNECTION_PLAN.md))
covers *where* strategies execute and Component E
([TRADE_LIFECYCLE_PLAN.md](TRADE_LIFECYCLE_PLAN.md)) covers *what the engine
does with a decision*; this covers *what a strategy can say*.

### Settled parameters

Decided during planning; they constrain several sections below.

- **All evaluation at bar close.** Streamed prices are chart-only, so there is
  one evaluation loop and backtest parity is preserved. Tick-reactive logic
  would have broken it — you cannot honestly backtest tick behaviour on 5m bars.
- **5-minute minimum timeframe**, all strategies in a group sharing one.
- **Higher timeframes are constructed** from 5m bars rather than taken from the
  broker, which sidesteps the broker-server-midnight problem for daily bars —
  but relocates the choice to us. The day boundary is **17:00
  `America/New_York`**, implemented timezone-aware (it is 21:00 UTC in summer
  and 22:00 UTC in winter; a fixed offset silently misaligns every constructed
  bar for several weeks a year).
- **No static instrument catalogue.** Availability is discovered per connection
  at runtime.
- **Forward testing, not walk-forward.** See §9.7 — the existing signal-only
  mode is already this.

---

## 1. The language question, answered

**Python, in `broker_service`, extending the existing rule engine. No new
language, no new service, no new process.**

This is not a preference — it is forced by one property of the current design
that is worth more than any other consideration:

> `RuleStrategy` is a single object that serves **both** the backtester and the
> live runner.

`broker_service/rule_strategy.py:466` compiles a rule-set once. The backtest
path drives `prepare_stateful()` + `evaluate_bar()` per bar; the live path
drives `evaluate()` on the newest closed bar. **Both funnel through the same
`_prepared()` method** (`rule_strategy.py:534-541`) and the same
`evaluate_bar()`. The docstring at `rule_strategy.py:663-666` states the intent
outright: the two "share one implementation so they cannot drift."

That property is the most valuable thing in the systematic stack, and it is
extremely easy to lose. Any strategy logic implemented outside this module —
in TypeScript in the backend, in a separate strategy service, in the frontend —
becomes a **second implementation** that must agree with the first. It will not.
The failure mode is the worst one available: a backtest that says the strategy
is profitable and a live run that does something subtly different, with no
error to point at.

So the constraint that decides the language is: *strategy semantics must have
exactly one implementation, and it must be the one both the backtester and the
live runner call.* That implementation is Python today, and there is no reason
strong enough to move it.

### 1.1 What stays where

| Concern | Where | Language | Why |
|---|---|---|---|
| Feature computation (indicators, price-action structure) | `broker_service/indicators.py`, new `price_action.py` | Python + pandas/numpy | Where the data and the backtester already are |
| Rule semantics (operands, operators, groups, sessions) | `broker_service/rule_strategy.py` | Python | The one shared implementation |
| Strategy *definition* | `strategy_definitions.rule_set` | JSON | Data, not code — editable, versionable, diffable |
| Rule-set validation + builder UI | `frontend/app/lib/ruleSet.ts`, `StrategyBuilder.tsx` | TypeScript | Authoring ergonomics only — **never** evaluation |
| Orchestration, risk, routing, persistence | `backend/src/services/*` | TypeScript | Where the DB and the scheduler are |

The frontend's `ruleSet.ts` already holds a *vocabulary mirror*
(`OPERATORS`, `OPERAND_SUGGESTIONS`) for the builder UI. That mirror is
authoring-only and must stay that way. It is also a duplication hazard in its
own right — see §8.3.

---

## 2. What the engine can express today, and what it cannot

The current model, read from the code:

- An **operand** resolves to **one float at one bar** (`Operand.value(ctx)`,
  `rule_strategy.py:173-181`).
- The evaluation context holds `row`, `prev` (exactly **one** bar back) and
  `position` (`EvalContext`, `rule_strategy.py:150-166`).
- Operators are `>` `<` `>=` `<=` `crosses_above` `crosses_below`.
- Groups are nestable `all` / `any`.
- Indicators are **precomputed as dataframe columns** before evaluation, then
  referenced by column name.
- Each operand **declares what it needs** via `primary_requests()` /
  `higher_tf_columns()`, and `RuleStrategy.__init__` walks every operand to
  compute the union (`rule_strategy.py:504-521`).

That last point is the important one. **The plugin seam for new feature types
already exists** — it was built for multi-timeframe indicators. An operand
declares a requirement, the strategy collects requirements, `_prepared()`
materialises them as columns, and evaluation reads columns pointwise.

### 2.1 Where price action does not fit

Price action is not shaped like an indicator. An indicator is a stateless
function of a rolling window returning a scalar per bar. Price action is
mostly:

| Price-action concept | Why the current model struggles |
|---|---|
| Engulfing, pin bar, inside bar | Needs 2–3 bars; `EvalContext` exposes 1 |
| Swing high / swing low | Needs a *confirmation window* — and is the source of the look-ahead bug in §5 |
| Support/resistance level | A level **persists across many bars** and has attributes (age, touch count, strength). Not a per-bar scalar |
| Supply/demand zone, order block | A price *region*, not a value; "inside" is a relation, not a comparison |
| Fair value gap / imbalance | Created at bar *i*, referenced at bar *i+30*, invalidated when filled — stateful over arbitrary distance |
| Market structure (BOS / CHoCH) | A state machine over swing sequence, carried forward indefinitely |
| Trendline | Geometry fitted over a variable window |

Every one of these can be *projected* to a per-bar scalar (see §6.2), and that
projection is what makes the cheap path work. But the projection is lossy, and
knowing where it loses is what keeps the plan honest.

---

## 3. The actual requirement: accommodate a plan nobody has written yet

The trading plan is **not fixed**. It will combine indicators and price action,
and beyond that it should be assumed to change. So the deliverable is not a
feature catalogue matching one strategy — it is a set of **structures general
enough that a future plan lands in one of them** rather than requiring the
engine to be reopened.

That changes what "done" means. Success is not "the engine can express our
strategy"; it is "for any rule someone writes on a whiteboard, there is a
known place it goes, or a loud answer that it does not fit yet." A plan that
optimises for a guessed strategy shape fails the moment the strategy changes,
which — for a discretionary trader systematising their process — is
continuously.

### 3.1 Expressiveness classes

Sorting strategy logic by *shape* rather than by concept gives the checklist
the architecture actually has to satisfy. This is the table to review, because
the honest entries are the bottom four:

| # | Class | Example | Status today | Projectable to per-bar float? |
|---|---|---|---|---|
| 1 | Per-bar scalar | `rsi < 30`, `body_pct > 60` | ✅ works | Native |
| 2 | Fixed multi-bar pattern | engulfing, 3-bar reversal | ⚠️ needs bar offsets (§6.3, item 1) | Yes — precompute |
| 3 | Confirmed-later structure | swing points, BOS | ⚠️ needs causal features + lag | Yes, with lag |
| 4 | Persistent objects | S/R levels, zones, FVGs, order blocks | ⚠️ lossy projection | **Partially** — see §3.2 |
| 5 | Carried state | trailing stop, high-water mark, "bars since X" | ❌ **impossible today** | No — needs state |
| 6 | Event sequences | "sweep, *then* BOS within 5 bars, *then* retrace" | ❌ **impossible today** | No — needs state + ordering |
| 7 | Multi-instrument | DXY filter on EURUSD; correlation; spreads | ❌ **impossible today** | No — one run is one symbol |
| 8 | Non-bar inputs | tick/order flow, DOM, economic calendar | ❌ out of scope | No — different data pipeline |

Classes 1–3 are what the current plan already handled. Classes **5, 6 and 7 are
structural gaps**, not missing features: no amount of feature-writing reaches
them, because the engine has nowhere to keep the information they need. Under a
fixed strategy they might never have come up. Under "any plan," they are close
to certain — trailing stops (5) and sequenced setups (6) are staples of exactly
the price-action trading this system is for.

**This is the substantive change from the previous draft.** Feature phasing by
concept (candles → swings → zones) was the wrong axis; phasing by capability
class is the one that determines whether an unwritten plan fits.

### 3.2 Where the per-bar projection genuinely loses

Class 4 is the subtle one, because projection *appears* to work. Reducing zones
to `dist_to_demand_pct` / `in_demand_zone` handles "enter when price reaches
demand" perfectly, and hides three limits:

- **Nearest-only.** "The second untested demand zone below" has no expression;
  the projection collapses a collection to one number.
- **No object identity.** "The order block created by the impulse that broke
  structure" requires referring to a *specific* object, not the closest one.
- **Attributes beyond the projection are gone.** Age, touch count and strength
  each need their own column, decided in advance by whoever wrote the feature.

The fix is not to abandon the projection — it is the right default and covers
most rules. It is to let a feature publish **objects with attributes**, and
give operands a way to select among them (§6.5). The projection then becomes
the common shorthand rather than the only option.

---

## 4. The options

### Option 1 — Extend the declarative rule-set with price-action features

Add price-action columns to the precompute pass and new operands that read
them. JSON stays the strategy definition. No new grammar.

- **Pros:** backtest/live parity is free (both go through `_prepared()`);
  UI-editable; no code deploy to create a strategy; all existing risk, sizing,
  session and scale-out machinery applies unchanged; smallest diff.
- **Cons:** expressiveness ceiling — anything not reducible to a per-bar float
  needs a new feature to be written first. Strategy authors depend on engineers
  to add vocabulary.

### Option 2 — Python strategy classes

Subclass `TradingStrategy` directly, as `SimpleMAStrategy` does; register in
`AVAILABLE_STRATEGIES`.

- **Pros:** unlimited expressiveness; full pandas available; the mechanism
  already exists for backtesting.
- **Cons:** **no live path today.** The live runner posts a `rule_set` to
  `/strategies/evaluate` (`strategyRunner.ts:311-316`); a code-defined strategy
  has no representation there. It would need one, which means either
  code-by-reference (deploy coupling: every strategy edit is a service
  redeploy) or shipping user Python into a process that holds broker
  credentials — an arbitrary-code-execution surface in the trading path. Also
  no UI, and no reuse of the validation the builder gives.

### Option 3 — An expression DSL

A safe expression language over the feature columns:
`close > swing_high[1] and atr_pct > 0.2`.

- **Pros:** far more expressive than nested JSON without being arbitrary code;
  much more pleasant to write than the current operand trees; indexing (`[1]`)
  naturally solves the one-bar-lookback limit.
- **Cons:** a real grammar to build, parse, validate, sandbox and error-report
  well; a second thing to keep synchronised with the builder UI; and it does
  **not** by itself solve price action — you still need the underlying features
  to exist. It is a better *notation* for the same problem, not a solution to
  it.

### Option 4 — Declarative rules over a pluggable feature library *(recommended)*

Option 1 plus an explicit, first-class **feature plugin seam**. Composition
stays JSON; *detection* lives in reviewed, tested, versioned Python features.

- **Pros:** everything from Option 1, plus a clean division of labour —
  engineers add capability, strategy authors compose it, and the boundary is a
  registry rather than an ad-hoc collection of `if` branches. Adding a feature
  is a small, testable, independently-shippable unit.
- **Cons:** still the Option 1 ceiling in the short run; needs a genuine
  registry rather than the informal dict that exists today.

### Recommendation

**Option 4, with Option 3 kept open as a later notation change.**

The decisive argument is that Option 4 is *the shape the code is already in*.
`INDICATOR_COLUMN_TO_REQUEST` (`rule_strategy.py:77-95`) is a hand-maintained
column→requirement map, and `primary_requests()` is already a
declare-your-dependency protocol. Option 4 is what that becomes when it is
made explicit and given a second implementation to prove the abstraction.

Option 3 is worth revisiting once the feature library is rich enough that
composing it in JSON becomes the bottleneck — which is a good problem, and not
today's. Option 2 should be reserved for research and backtest-only
exploration; it should not gain a live path, because the version that has one
is an arbitrary-code-execution hole next to the order router.

---

## 5. The hazard that matters most: look-ahead in price-action features

**This section is the reason to be careful, and it deserves to outrank
everything else in review.**

Almost every naive swing-point implementation looks like this:

```python
# WRONG — uses future bars
from scipy.signal import argrelextrema
swings = argrelextrema(highs, np.greater, order=5)
```

A swing high at bar *i* identified with `order=5` is only knowable at bar
*i+5*. Marking it on bar *i* means the backtest can act on information that did
not exist yet. Every structure concept inherits this: BOS, CHoCH, order blocks,
and support/resistance are all *defined by* what happened after the bar they
are attached to.

The consequence is specific and severe: **the backtest looks excellent and the
live run does not reproduce it**, with no error anywhere. Indicator strategies
mostly avoid this because a rolling mean is causal by construction. Price
action does not get that for free — and this codebase has *already been careful
about it once*, in the higher-timeframe merge (`_merge_higher_timeframe`,
flagged "no look-ahead" at `rule_strategy.py:667`). The same discipline has to
extend to every price-action feature.

**Mitigations, all mandatory:**

1. **Causal by construction.** Every feature function computes bar *i* using
   only bars ≤ *i*. No `argrelextrema`, no centred windows, no `shift(-n)`.
2. **Explicit confirmation lag.** A swing confirmed after *k* bars is published
   on bar *i+k*, carrying `bars_since` so a rule can reference the swing's
   real age. The lag is part of the feature's contract and is documented and
   tested.
3. **A look-ahead test harness, not just unit tests.** For every feature:
   compute it over the full series; then recompute it incrementally over
   growing prefixes; assert the value at bar *i* is **identical** both ways.
   Any feature that peeks fails this test. It is cheap, mechanical, and catches
   the entire bug class — this should be a shared test helper every feature is
   automatically run through, not a per-feature obligation.
4. **The live path is the tiebreaker.** `evaluate()` sees only history, so if
   backtest and live disagree on the same bar, the feature peeks. Worth
   building as a diagnostic: replay a definition through both and diff.

---

## 6. Recommended design

### 6.1 A feature registry alongside the indicator calculator

New module `broker_service/price_action.py`, structured like
`indicators.py`'s `IndicatorCalculator`:

```python
@dataclass(frozen=True)
class Feature:
    name: str                     # column name, e.g. "swing_high"
    columns: tuple[str, ...]      # columns produced (some emit several)
    confirmation_lag: int         # bars until knowable — 0 for same-bar
    compute: Callable[[pd.DataFrame, dict], pd.DataFrame]

FEATURES: dict[str, Feature] = {}   # registered, introspectable, testable
```

`RuleStrategy.__init__` gains a third requirement channel beside
`primary_requests()` / `higher_tf_columns()` — `price_action_features()` —
collected the same way, and `_prepared()` materialises them. Because
`_prepared()` is the shared path, **backtest and live get the features
identically, by construction**. That is the whole reason to put them there
rather than anywhere else.

### 6.2 Projecting price action onto per-bar floats

Every feature reduces to numeric columns so the existing operators work
unchanged. Booleans become 0/1; regions become distances; state machines become
signed states:

| Concept | Column(s) | Type |
|---|---|---|
| Pin bar / engulfing / inside bar | `pin_bar`, `engulfing`, `inside_bar` | 0/1 |
| Candle geometry | `body_pct`, `upper_wick_pct`, `lower_wick_pct` | float |
| Swing points | `swing_high`, `swing_low`, `bars_since_swing_high` | price / count |
| Market structure | `structure_state` (+1 bull, −1 bear, 0 none), `bars_since_bos` | signed / count |
| S/R level | `dist_to_resistance_pct`, `resistance_touches`, `resistance_age_bars` | float / count |
| Zone / order block / FVG | `in_demand_zone` (0/1), `dist_to_demand_pct`, `zone_age_bars` | 0/1 / float |
| Volatility context | `atr_pct`, `range_pct_of_atr` | float |

Note the deliberate choice of **percentage distances over absolute prices**: a
rule written on EURUSD must behave the same on XAUUSD, and — given Component
C's fleet runs one strategy across many brokers — the same rule meets slightly
different quotes on each connection. Absolute-price thresholds would need
per-instrument, per-connection retuning; percentages do not.

### 6.3 Small operand-model extensions

Two additions, both contained:

1. **Bar offset on operands** — `{"field": "close", "offset": 2}`. Removes the
   one-bar lookback limit that `EvalContext` currently imposes and is needed by
   nearly every multi-bar pattern rule. This is the single highest-value
   grammar change and should land early.
2. **`in_range` / `crosses_level` operators** — expressing "price entered the
   zone" cleanly rather than as a two-condition `all` group.

Both are additive; existing rule-sets keep compiling.

### 6.4 Strategy state — the structural gap that unlocks classes 5 and 6

**The most important addition in this plan, and the one with the most ways to
get it wrong.**

Classes 5 (carried state) and 6 (event sequences) are impossible today for one
reason: `evaluate()` is deliberately **stateless**, described in its own
docstring as "the stateless signal the live runner polls per closed bar"
(`rule_strategy.py:689-699`). Each evaluation sees bars, position and nothing
else. There is no place to record that a high-water mark was set, that a
liquidity sweep happened four bars ago, or that the strategy is waiting for
leg two of a three-leg setup.

Almost every trailing-stop and multi-leg-setup rule needs exactly that.

**Design: a per-run state dict, derived and reproducible.**

- A run carries `strategy_state` — a small JSON object, persisted per run and
  updated on each evaluated bar.
- Rules read it through a `state.<key>` operand namespace, mirroring the
  existing `position.<field>` namespace, which is the precedent to copy.
- Rule-sets declare state transitions declaratively — `set`, `max`, `min`,
  `increment`, `clear`, each conditional on the same rule groups already
  supported. A trailing stop is then `state.high_water = max(state.high_water,
  high)` plus an exit condition against it, with no new evaluation model.
- Sequence operators (`happened_within(N)`, `then_within(N)`) compile down to
  state transitions rather than being a separate mechanism.

**The three hazards, because state is where this design can quietly break:**

1. **Backtest/live divergence.** State makes evaluation order-dependent, so the
   parity that §1 protects is no longer free. The backtest already drives
   `evaluate_bar()` bar-by-bar with running position, so state fits that loop —
   but `generate_signals()`'s batch pass and the live path must be proven to
   produce identical state sequences over the same bars. This deserves the same
   treatment as the look-ahead harness: a replay test, not a code review.
2. **Restart and warmup.** A run restarting mid-session must rebuild state.
   **Make it derivable by replay** — state is a pure function of the bar
   history and the rule-set, so a restart recomputes it over the warmup window
   rather than trusting a persisted snapshot. Persist it as a cache and a
   diagnostic, never as the source of truth. Otherwise a crash mid-setup
   produces state that no history explains.
3. **Unbounded growth.** State keys must be declared in the rule-set and bounded
   in size. A strategy that accumulates a list per bar becomes a memory leak
   with a per-run blast radius.

Note the interaction with Component C: state is **per run**, and one run is one
connection, so a fleet of legs each keeps its own. That is correct — each
account's trailing stop tracks its own fills — and it falls out of the
run-per-connection choice made there rather than needing new machinery.

### 6.5 Feature objects and selectors — closing class 4 properly

Beyond emitting columns, a feature may publish a **collection of objects** for
the current bar: zones, levels, gaps, each with attributes and a lifecycle
(created, tested, invalidated). Operands then select from a collection instead
of reading a pre-flattened column:

```jsonc
{ "feature": "demand_zone", "select": "nearest_below",
  "where": { "untested": true }, "attr": "distance_pct" }
```

This recovers exactly what §3.2 said the projection loses — the second zone
down, an object's age or touch count, a specific object rather than the closest
— without abandoning the column shorthand, which stays the common case. The
selector vocabulary (`nearest_above` / `nearest_below` / `nth` / `most_recent`,
plus attribute filters) is small and closed, so it stays declarative and
UI-representable.

### 6.6 Multi-instrument operands — the seam, not the implementation

Class 7 (an index filter, a correlated pair, a spread) needs the runner to
fetch more than one series per run, which is a real change to
`fetchHistory`/`getPosition` in `strategyRunner.ts` and to the caching in C6.

**Recommendation: build the seam, defer the implementation.** Define the
operand form now — `{"symbol": "DXY", "indicator": "sma_50"}` — so that
`RuleStrategy.__init__`'s requirement walk collects *symbols* alongside
indicators and timeframes, exactly as it already collects
`higher_tf_columns()`. Reject it at compile time with a clear "not yet
supported" until the runner can satisfy it.

This is the cheapest way to honour "accommodate any plan": the vocabulary and
the requirement-collection admit it, the compiler says plainly that it is not
wired up, and enabling it later touches the runner rather than the rule model.
A rule-set written against it stays valid.

### 6.7 Schema versioning and capability reporting

If the grammar is going to grow, stored definitions must survive its growth:

- `rule_set.schema_version`, with the compiler accepting known older versions.
  Definitions are persisted rows that outlive deploys.
- A **capability endpoint** the builder and a human can query: which features,
  operators, selectors and classes this build supports. This makes "can the
  engine express my plan?" an answerable question rather than a code-reading
  exercise, which is the practical form of the §3 requirement.
- **Compile-time rejection over silent non-firing** — see §8.4, which is the
  trap this closes.

### 6.8 What is deliberately *not* changed

- No new service, process, or language runtime.
- No user-authored Python in the live path.
- No change to the operator grammar beyond §6.3, §6.4 and §6.5.
- No new indicator library dependency (TA-Lib / pandas-ta). The existing
  `indicators.py` covers 12 indicators hand-rolled with tests; price-action
  libraries in the wild are mostly low-quality and would need the same
  look-ahead auditing as writing them, without the test coverage. **The audit
  is the work, not the arithmetic.**

---

## 7. Phasing

Phased by **capability class** (§3.1), not by price-action concept. Each phase
opens a *shape* of rule; the individual features inside it are then small,
independent additions that need no further architectural work. This is what
makes the plan robust to a trading plan nobody has written yet — a new idea
lands in an existing class rather than reopening the engine.

| Phase | Opens | Contents | Unblocks |
|---|---|---|---|
| **D-0** | *safety + the grammar floor* | Look-ahead harness (§5, mitigation 3), feature registry skeleton, bar-offset operands (§6.3, item 1), `schema_version`, compile-time rejection of unknown vocabulary (§8.4) | Everything after it, safely |
| **D-1** | classes 1–2 | Candle geometry and fixed multi-bar patterns: `body_pct`, wicks, `pin_bar`, `engulfing`, `inside_bar`, `atr_pct` | All same-bar price action — zero confirmation lag, so no repaint risk at all |
| **D-2** | class 3 | Causal swing detection, `bars_since_*`, structure state (BOS/CHoCH) | Every confirmed-later structure concept; the harness earns its keep here |
| **D-3** | class 5–6 | Strategy state channel (§6.4) + sequence operators, with the replay-parity test | Multi-leg sequenced setups. **Demoted:** trailing stops and breakeven no longer need this — see the note below |
| **D-4** | class 4 | Feature objects + selectors (§6.5), zones/levels/FVG/order blocks, `in_range` | Object-level rules, not just nearest-distance shorthand |
| **D-5** | authoring | Capability endpoint (§6.7), builder vocabulary served from the registry (§8.3), backtest-vs-live replay diff | A non-engineer can author and verify |
| **D-6** | class 7 | Multi-instrument implementation behind the D-0 seam (§6.6) | Index filters, correlation, spreads |

Two ordering choices worth challenging in review:

- **D-0 before everything** is non-negotiable: the harness must exist before
  there is a feature to be wrong, or the first repainting feature is found in
  production rather than in CI.
- **D-3 (state) has been demoted below D-4 (objects).** The earlier draft
  ranked state first because trailing stops and breakeven moves appeared to
  require it. With Component E's broker-side stops
  ([TRADE_LIFECYCLE_PLAN.md](TRADE_LIFECYCLE_PLAN.md) §2.1) **the broker holds
  the ratchet**: each bar close the app computes the desired stop and modifies
  only when the new one is more protective, so "never move the stop backwards"
  is a comparison rather than carried state. That removes the concrete driver.
  State remains genuinely necessary for **sequenced setups** (class 6), which
  no external system can hold on our behalf — so it stays in the plan, just no
  longer ahead of everything else.

  This is worth noting as a general pattern: before adding state to the engine,
  check whether some component already outside it — the broker, the fills
  record, the position itself — is a more reliable holder of that fact.

---

## 8. Consequences to plan for

### 8.1 Per-tick cost, and the interaction with Component C

`evaluate()` recomputes indicators over the **whole window** on every poll
(`rule_strategy.py:711`). Price-action features add to that, and the stateful
ones (zones, levels) are the expensive kind — they scan history rather than
applying a rolling window.

Component C multiplies this: one strategy × N connections × per-tick
full-window recompute. Two mitigations, both already implied by C6's shared bar
cache:

- Cache computed features per `(connection, native_symbol, timeframe, bar_time)`
  so runs sharing an instrument on a connection compute once.
- Bound the live window explicitly. `historyPeriodFor()`
  (`strategyRunner.ts:129-143`) fetches up to `1Y` of daily bars; zone
  detection over that on every tick is wasteful when a bounded lookback would
  do. Make the window a declared property of the feature.

Worth measuring before optimising — but worth measuring *early*, because the
answer changes C6's cache design and it is cheaper to know now.

### 8.2 Backtest realism gets more load-bearing

Indicator strategies on closed bars are relatively forgiving. Price-action
strategies trade at levels, which is exactly where spread widens, stops cluster
and slippage is worst — and on the MT5 CFD venues in Component C, spread is the
broker's variable, differing across the very connections running the same
strategy. A fill model that ignores spread will flatter a price-action backtest
substantially more than it flatters an indicator one. Whether
`backtesting.py`'s fill model is adequate for this should be assessed at D-2,
before the results are trusted for sizing decisions.

### 8.3 The frontend vocabulary mirror becomes a real duplication cost

`ruleSet.ts` hand-mirrors the Python vocabulary. That is tolerable for 16
indicator columns and 6 operators. With a growing feature library it becomes a
drift source — a feature added in Python but missing from the builder is
invisible to authors; one removed leaves a UI option that fails validation.

**Recommendation:** serve the vocabulary from the feature registry
(`GET /strategies/vocabulary`) and have the builder consume it, keeping
`ruleSet.ts` for *shape* validation only. This makes the registry the single
source of truth for what a strategy can say — the same principle that put rule
semantics in one place in §1.

### 8.4 A rule that cannot fire fails silently — and a growing vocabulary makes that worse

`Condition.evaluate` returns `False` when either side is non-finite
(`rule_strategy.py:303-312`), and `EvalContext._column` returns `NaN` for a
column that is not present (`rule_strategy.py:158-165`). Today an unknown
operand *name* is caught at compile time by `parse_operand`, so the exposure is
small. But the runtime behaviour is that **a condition referencing a column
that failed to materialise never fires, forever, with no error** — it simply
evaluates false on every bar.

That is correct during indicator warmup, where NaN genuinely means "not enough
data yet." It is dangerous everywhere else, and an extensible feature library
adds exactly the cases where it bites: a feature whose computation failed, a
feature that returned the wrong column name, a feature unavailable in this
build, a state key never initialised. The strategy looks alive — it evaluates,
it records signals, it reports no error — and one leg of its entry condition is
permanently false. This is the same failure shape as the `max_daily_loss`
no-op the roadmap already had to fix once.

**Recommendations:**

- **Distinguish "not ready" from "broken."** Warmup NaN is expected and stays
  false; a column that should exist and does not is a **run error**, not a
  false condition.
- **Reject at compile time whatever can be rejected there** — unknown features,
  unknown selectors, unknown state keys, unsupported classes (§6.6). The
  capability endpoint (§6.7) and the compiler must agree.
- **Report per-condition evaluation counts** in the run diagnostics. A
  condition that has never once been true over thousands of bars is worth
  surfacing to the author; it is occasionally the strategy, and often a bug.

---

## 9. Open questions

1. **~~Which price-action concepts do you actually trade?~~ Answered: the plan
   is not fixed and must be assumed to change.** That is what §3 and the
   capability-class phasing now reflect. The follow-on question is narrower but
   still worth an answer: is the *first* plan to go live sequence-heavy
   (favouring D-3 before D-4) or zone-heavy (the reverse)? The architecture
   accommodates both; only the order changes.
2. **Discretionary rules that resist formalisation.** Some price-action
   judgement ("a clean level", "a decisive break") has no crisp definition.
   Each needs pinning to something measurable — touch count, close-beyond
   margin in ATR units — and that is strategy design, not engineering. Worth
   identifying early which rules are fuzzy, because they set the feature
   parameters.
3. **Confirmation lag vs. entry timing.** A structure break confirmed *k* bars
   late may have missed the entry. Does the strategy enter on confirmation
   (safe, worse fills), or on a provisional break with invalidation (better
   fills, and a genuinely harder thing to backtest honestly)? This is a
   strategy decision with a large engineering consequence, and it should be
   made before D-2.
4. **Multi-timeframe price action.** The higher-timeframe merge exists for
   indicators. Price action is frequently multi-timeframe (4H structure, 15m
   entry). Extending the merge to feature columns is mechanical but needs the
   same no-look-ahead care the indicator merge already has — assume it is in
   scope at D-2 unless the strategy is genuinely single-timeframe.
5. **Where is the escape hatch when a plan genuinely does not fit?** §3 promises
   "a known place it goes, or a loud answer that it does not fit yet." The loud
   answer is the compiler plus the capability endpoint. But some plan will
   eventually need something no class covers, and the options are: extend a
   class (slow, correct), or allow a reviewed Python strategy for
   **backtest-only** research while the declarative version is built. The
   latter already exists via `AVAILABLE_STRATEGIES` and is worth keeping open
   deliberately — provided it never acquires a live path (§4, Option 2).
6. **How much unknown-plan generality is worth paying for up front?** D-3
   (state) and D-4 (objects) are real engineering, justified by classes the
   current plan cannot express *at all*. **D-6 (multi-instrument) is now
   deferred outright** — cross-instrument trading is out of plan
   (`FUTURE_DECISION_POINTS.md` C-P2/D-P2), so only the compile-time refusal
   seam is built.

### 9.7 Forward testing, not walk-forward — a terminology correction

Recorded because the distinction changes what gets built.

**Walk-forward analysis** (Pardo) *is* rolling re-optimisation: optimise on an
in-sample window, test on the following out-of-sample window, roll, repeat.
Re-optimisation is intrinsic — walk-forward exists specifically to validate
that an optimisation procedure generalises. **If you are not optimising, you do
not need walk-forward.**

What is actually wanted here — running a strategy against newly-arriving live
data without executing — is **forward testing** (paper trading). Different
technique, far simpler, and **already implemented**: `SYSTEMATIC_ENABLED=true`
without `SYSTEMATIC_EXECUTION_ENABLED` runs the evaluator against live bars and
records signals while placing nothing. The work here is naming it and surfacing
its results, not building it.

**Caveat worth designing around.** Declining formal parameter optimisation
(D-P4) removes the dominant overfitting vector but not overfitting itself.
Hand-iterating — "14 didn't work, try 20" — is optimisation performed manually,
with no record of how many variants were tried, which is *worse* for
assessing significance than the automated kind. The defence is holdout
discipline: reserve a slice of history untouched until the strategy is
otherwise finished. That is a feature of the backtest UI, not a matter of
willpower, and it should land alongside forward-test reporting.
