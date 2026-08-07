# Strategy Implementation — Language, Authoring Model, and Price Action

**Status:** plan / not yet implemented
**Scope:** how systematic strategies are *written and evaluated* — the language
they live in, the authoring model, and how **price-action** logic joins the
**indicator** logic that exists today.
**Prerequisites:** Component A (rule engine, `broker_service/rule_strategy.py`)
— delivered.

This is Component **D** of [SYSTEMATIC_TRADING_ROADMAP.md](SYSTEMATIC_TRADING_ROADMAP.md).
Component C ([MT5_MULTI_CONNECTION_PLAN.md](MT5_MULTI_CONNECTION_PLAN.md))
covers *where* strategies execute; this covers *what they can say*.

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
own right — see §7.3.

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
| Swing high / swing low | Needs a *confirmation window* — and is the source of the look-ahead bug in §4 |
| Support/resistance level | A level **persists across many bars** and has attributes (age, touch count, strength). Not a per-bar scalar |
| Supply/demand zone, order block | A price *region*, not a value; "inside" is a relation, not a comparison |
| Fair value gap / imbalance | Created at bar *i*, referenced at bar *i+30*, invalidated when filled — stateful over arbitrary distance |
| Market structure (BOS / CHoCH) | A state machine over swing sequence, carried forward indefinitely |
| Trendline | Geometry fitted over a variable window |

Every one of these can be *projected* to a per-bar scalar (see §3.2), and that
projection is what makes the cheap path work. But the projection is lossy, and
knowing where it loses is what keeps the plan honest.

---

## 3. The options

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

## 4. The hazard that matters most: look-ahead in price-action features

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

## 5. Recommended design

### 5.1 A feature registry alongside the indicator calculator

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

### 5.2 Projecting price action onto per-bar floats

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

### 5.3 Small operand-model extensions

Two additions, both contained:

1. **Bar offset on operands** — `{"field": "close", "offset": 2}`. Removes the
   one-bar lookback limit that `EvalContext` currently imposes and is needed by
   nearly every multi-bar pattern rule. This is the single highest-value
   grammar change and should land early.
2. **`in_range` / `crosses_level` operators** — expressing "price entered the
   zone" cleanly rather than as a two-condition `all` group.

Both are additive; existing rule-sets keep compiling.

### 5.4 What is deliberately *not* changed

- No new service, process, or language runtime.
- No user-authored Python in the live path.
- No change to the operator grammar beyond §5.3.
- No new indicator library dependency (TA-Lib / pandas-ta). The existing
  `indicators.py` covers 12 indicators hand-rolled with tests; price-action
  libraries in the wild are mostly low-quality and would need the same
  look-ahead auditing as writing them, without the test coverage. **The audit
  is the work, not the arithmetic.**

---

## 6. Phasing

| Phase | Contents | Ships |
|---|---|---|
| **D-0** | Look-ahead test harness (§4.3) + feature registry skeleton + bar-offset operands (§5.3.1) | The safety net and the grammar gap, before any feature exists to get it wrong |
| **D-1** | Candle-geometry + single/two-bar patterns: `body_pct`, wicks, `pin_bar`, `engulfing`, `inside_bar`, `atr_pct` | Real price-action rules, all confirmation-lag 0 — no repaint risk at all |
| **D-2** | Causal swing detection + `bars_since_*`; structure state (BOS/CHoCH) | The first features with a confirmation lag; harness earns its keep |
| **D-3** | Levels and zones: S/R, supply/demand, FVG, order blocks + `in_range` operator | The stateful, longest-lived features |
| **D-4** | Builder UI vocabulary, feature introspection endpoint (§7.3), backtest-vs-live replay diff | Authorable and verifiable by a non-engineer |

D-0 before D-1 is the point of the ordering: the harness must exist before
there is a feature to be wrong, or the first repainting feature will be found
in production.

---

## 7. Consequences to plan for

### 7.1 Per-tick cost, and the interaction with Component C

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

### 7.2 Backtest realism gets more load-bearing

Indicator strategies on closed bars are relatively forgiving. Price-action
strategies trade at levels, which is exactly where spread widens, stops cluster
and slippage is worst — and on the MT5 CFD venues in Component C, spread is the
broker's variable, differing across the very connections running the same
strategy. A fill model that ignores spread will flatter a price-action backtest
substantially more than it flatters an indicator one. Whether
`backtesting.py`'s fill model is adequate for this should be assessed at D-2,
before the results are trusted for sizing decisions.

### 7.3 The frontend vocabulary mirror becomes a real duplication cost

`ruleSet.ts` hand-mirrors the Python vocabulary. That is tolerable for 16
indicator columns and 6 operators. With a growing feature library it becomes a
drift source — a feature added in Python but missing from the builder is
invisible to authors; one removed leaves a UI option that fails validation.

**Recommendation:** serve the vocabulary from the feature registry
(`GET /strategies/vocabulary`) and have the builder consume it, keeping
`ruleSet.ts` for *shape* validation only. This makes the registry the single
source of truth for what a strategy can say — the same principle that put rule
semantics in one place in §1.

---

## 8. Open questions

1. **Which price-action concepts do you actually trade?** The D-1→D-3 ordering
   assumes the common progression (candles → swings → structure → zones). If
   the strategy centres on, say, order blocks and FVGs specifically, D-3 should
   be pulled forward and D-2 trimmed to only the swing detection those need.
   This is the one answer that would most change the plan.
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
