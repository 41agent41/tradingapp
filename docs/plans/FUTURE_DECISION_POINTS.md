# Future Decision Points

Deferred items across the systematic trading roadmap. Each was **considered and
consciously deferred** during planning — none is an oversight, and each records
what would trigger revisiting it.

The purpose of this register is that a deferred decision stays visible. The
failure this guards against is the one the roadmap already hit once with
`max_daily_loss`: a capability accepted by the schema, accepted by the UI, and
implemented nowhere — a silent no-op that looked like a feature.

**Convention:** an item is a placeholder only if deferring it does not leave the
system *incorrect*. Anything whose absence would make live trading unsafe is a
phase in a component plan, not an entry here.

---

## Component C — [Multi-platform connections](MULTI_PLATFORM_CONNECTION_PLAN.md)

| ID | Deferred | Why deferred | Revisit when |
|---|---|---|---|
| **C-P1** | Normalising session windows across brokers on different server clocks | Each broker's server time is accepted as authoritative for its own legs. Recorded per connection (`server_timezone`) so the divergence is visible | Running session-sensitive strategies across brokers whose server offsets differ, or when a group's legs must open at the same wall-clock moment |
| **C-P2** | Cross-instrument exposure limits (correlation grouping) | Out of plan — the fleet trades a single instrument per account | Trading correlated instruments simultaneously, where six EUR-pair longs are one bet rather than six |
| **C-P3** | Multi-strategy sharing one instrument on one account | Excluded by E10. Under netting, two runs on one symbol share a net position neither controls; needs a position-ownership layer | When a second strategy must trade an instrument another strategy already holds on the same account |
| **C-P4** | Work-queue runner model | Bounded concurrency is sufficient under ~10 connections | Fleet grows materially beyond a dozen connections |
| **C-P5** | Multiplexing MT5 sidecar (one process, many terminals) | One sidecar per terminal is the supported shape and keeps routing testable in-repo | If Windows host or port count becomes the operational constraint |
| **C-P6** | Formal change control for strategy edits | Managed manually; C4a's canary staging is the only gate | If more than one person can edit a live strategy |

---

## Component D — [Strategy authoring](SYSTEMATIC_STRATEGY_IMPLEMENTATION_PLAN.md)

| ID | Deferred | Why deferred | Revisit when |
|---|---|---|---|
| **D-P1** | Expression DSL as rule notation | A better *notation* for the problem, not a solution to it; JSON plus a feature library is the shape the code is already in | When composing rules in JSON becomes the authoring bottleneck |
| **D-P2** | Multi-instrument operands (class 7) | Seam built, implementation deferred — the compiler refuses clearly. Reinforced by C-P2 | Same trigger as C-P2 |
| **D-P3** | Non-bar inputs (order flow, DOM, economic calendar) | Different data pipeline entirely | See C10-equivalent below (news filtering) |
| **D-P4** | Parameter optimisation | Deliberately avoided as the dominant overfitting vector | Only with a holdout-discipline mechanism in place first, since optimisation without one is how backtests stop meaning anything |
| **D-P5** | Live path for code-defined Python strategies | Would be arbitrary code execution beside the order router. Backtest-only research use stays supported | Should stay closed; if ever needed, requires a sandboxing design, not a config flag |

---

## Component E — [Trade lifecycle](TRADE_LIFECYCLE_PLAN.md)

| ID | Deferred | Why deferred | Revisit when |
|---|---|---|---|
| **E-P1** | Direct long→short reversal | Not currently required; flat is always visited between directions | A strategy needs to flip without going flat. Under netting this is one atomic order, not close-then-open |
| **E-P2** | Take-profit | Trail-only for now. Order path carries `take_profit` from the start so enabling it is a rule change, not a contract change | A strategy wants a fixed target alongside the trail |
| **E-P3** | Out-of-process kill-switch watchdog | The in-app kill switch cannot fire when the app is down; broker-side stops cover that case | If notify-only operation shows the app itself is the unreliable component |
| **E-P4** | Limit and stop entry orders | Confirmed future requirement. Needs a working-order lifecycle — expiry, modification, partial fills — the engine does not model | When entries must rest at a price rather than execute at bar close |
| **E-P5** | Pyramiding / re-sizing an open position | Excluded by E9: size resolves once at entry | If scaling into a position becomes a strategy requirement |
| **E-P6** | Hedging-mode MT5 accounts | All accounts are netting; hedging is a different position data model, not a flag | If an account is opened that is not netting |

---

## Risk and compliance

| ID | Deferred | Why deferred | Revisit when |
|---|---|---|---|
| **R-P1** | **Prop-firm account rules** | No challenge or funded accounts currently in scope | Before any prop account goes live. ⚠️ These are **not** the per-run caps already planned: max daily loss is typically measured against start-of-day balance *including floating P&L*, and max trailing drawdown ratchets against a high-water mark. Neither is expressible as the realised-P&L cap that exists. Breaching them fails the account outright rather than costing money |
| **R-P2** | **News-event trading restrictions** | Not currently required; commonly mandated by prop firms | Alongside R-P1, or if a strategy needs to avoid high-impact releases. Requires an economic-calendar feed (D-P3) |
| **R-P3** | Weekend and rollover handling | FX gaps over the weekend; broker-side stops cover the exposure | If strategies should flatten before the weekly close rather than carry through it |

---

## Operations

| ID | Deferred | Why deferred | Revisit when |
|---|---|---|---|
| **O-P1** | Additional alert channels (WhatsApp, Signal) | Telegram chosen for reachability; the notifier sits behind an interface so a channel is additive | If Telegram proves insufficient — the design cost was already paid |
| **O-P2** | Broker comparison / selection research | The app carries **no static instrument catalogue** by design — availability is discovered per connection at runtime. Choosing which firms to open accounts with is a separate business question | When selecting new brokers to add to the fleet |

---

## How to close a placeholder

1. Move the item into the owning component plan as a numbered phase with a DoD.
2. Delete the row here, and note the closure in the component plan.
3. If the item turns out to be *required for correctness* rather than optional,
   it was mis-filed — promote it to a phase immediately rather than leaving it
   registered as deferred.
