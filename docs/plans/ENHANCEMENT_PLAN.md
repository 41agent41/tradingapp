# TradingApp review and enhancement plan

Approved by Sean on 10 Nov 2026. Review of `master` at PR #102. Item IDs (E-, S-, D-) are referenced from pull requests and commits.

## Summary

The app is solid, but stored data cannot yet drive replay or backtests. Backtests download bars from the broker on every run. Live prices are never written to the database. A 2-year retention policy silently deletes the deep history the app collects. Fixing that data path is the first priority. Next come the outdated broker-service dependencies with known vulnerabilities, then streaming for the brokers that are still polled, then the chart upgrade.

This review covers the repository at `master` after PR #102 (IG and cTrader adapters). Nothing has been changed yet.

**Scope decisions from Sean (9 Nov 2026)**

- Brokers in scope: OANDA, IG, cTrader (IC Markets, Pepperstone, FP Markets, Fusion), MT5 (Axi, Eightcap, Vantage), Interactive Brokers and Alpaca. Paper accounts first.
- Connection order: web API first, then MT5, then IB Gateway. MCP servers and MT4 are on hold (see the last section).
- Each broker firm gets exactly one connection type. For example, IC Markets connects only through cTrader, never through MT5.
- Stored data: 1-minute bars built from the live stream, 5-second bars where the broker offers them, and raw ticks kept for a limited number of days.
- The app is LAN only and never internet facing. The security review still reports anything critical.
- This document is reviewed here first, then committed to `docs/plans/` once approved.
- Proxmox remains the main install path. Every instruction step gets the exact command, its expected output, and what to do if it fails.

**Top 6, in order**

1. Stop the retention policy from deleting deep history (E-01).
2. Run backtests from bars stored in the database, and add bar replay (E-02, E-03, E-04).
3. Build bars from the live stream and save them, plus raw ticks for a set number of days (E-05, E-06).
4. Upgrade FastAPI, Starlette and python-multipart, and add lockfiles (S-01, S-02).
5. Stream prices and fills from IG, Alpaca and OANDA instead of polling (E-10 to E-14).
6. Move the charts to Lightweight Charts v5, with live candles on any symbol (E-20 to E-25).

## How to read the model ratings

Each enhancement names the cheapest model that can handle it reliably, the model to use for it, and any model that should not do it alone. The ratings are judgement calls based on how much reasoning, cross-file context and safety risk each task carries. They are not measured benchmarks.

| Model | API price, in / out per 1M tokens | Use it for |
| --- | --- | --- |
| Claude Fable 5.2 | $8 / $40 | The hardest design work: the market-data storage and replay architecture, order-path changes where a mistake trades real money, and the security review sign-off. |
| Claude Opus 5.5 | $4 / $20 | Most multi-file features: streaming adapters, backtest-from-database, the chart upgrade, dependency upgrades with test fixes. This is the default. |
| Claude Sonnet 5.5 | $2 / $10 | Well-specified, contained work: one adapter endpoint, a migration, a form field, documentation rewrites from an agreed outline. |
| Claude Haiku 5.5 | $0.10 / $0.50 | Mechanical work only: lockfile generation, renames, lint fixes, link checks, copying a pattern that already exists. |

**Rating key used in the register**

- **Capable**: the model can do the whole task from this document and the repo, with normal review.
- **Recommended**: the best balance of reliability and cost for this task.
- **Supervised**: the model can do it only with a detailed plan from a stronger model and a careful human review.
- **Not suitable**: the risk or the reasoning needed is too high for this model.

Any task that touches order placement, live trading or secrets needs a human review before merge, whichever model does it.

## Broker connection policy

Every firm gets exactly one connection type: its web API if it has one, MT5 if it does not, and IB Gateway only for Interactive Brokers. Today the app ranks Alpaca last, behind IB Gateway, although Alpaca is a web API. Firms that offer both cTrader and MT5 can also be added through the generic MT5 form. Both conflict with Sean's order (E-30, E-31).

The default priority is set in `broker_service/connections.py` line 85 and mirrored in `backend/src/services/orderTypes.ts`: `oanda, ig, ctrader, mt5, ib, alpaca`.

| Firm | The one connection type | Why | Change needed |
| --- | --- | --- | --- |
| OANDA | Web API (v20 REST and streaming) | Full trading and pricing API | Block OANDA MT5 accounts on the MT5 form |
| IG | Web API (REST and Lightstreamer) | Full trading and streaming API | None for the type; add streaming (E-11) |
| IC Markets, Pepperstone, FP Markets, Fusion | Web API (cTrader Open API) | Full trading and streaming API | Block these firms on the MT5 form |
| Alpaca | Web API (Trading, Market Data, WebSocket streams) | Full trading and streaming API | Move it to fifth in priority, ahead of MT5 |
| Axi, Eightcap, Vantage | MT5 through the sidecar | No public trading web API | None |
| Interactive Brokers | IB Gateway (TWS API) | See note below | Keep, and revisit after E-36 |

**Proposed default priority:** `oanda, ig, ctrader, alpaca, mt5, ib`.

**How "one type per firm" is enforced (E-31)**

1. Add a `firm` field to each stored connection, chosen from the firm presets in `frontend/app/lib/brokerConnections.ts`.
2. Map each firm to its one platform in a single shared table, used by both the backend validation and the form.
3. The backend refuses to save a connection whose platform does not match its firm's platform, with a message that names the right one.
4. A migration sets `firm` on existing rows and lists any that break the rule on the Getting started checklist.

**Interactive Brokers note.** IBKR offers a Client Portal Web API, but for an individual account it still needs a locally run, logged-in gateway, and its OAuth access is aimed at institutions and third-party vendors. That is unverified for Sean's account. E-36 checks whether IBKR's Web API with OAuth is open to Sean's account. If it is, IB moves to the web API and the IB Gateway container can be retired.

## Web API capabilities not yet used

The adapters cover the request-and-response half of each web API well, but mostly skip the streaming half. Only OANDA prices and cTrader spots are streamed. IG and Alpaca prices are polled every 2 seconds (`STREAM_POLL_SECONDS`), and fills from every broker are polled. Bid and ask history is also missing, so backtests cannot model the spread.

| Broker | Used today | Not used yet | Item |
| --- | --- | --- | --- |
| OANDA | Instruments, mid candles (`price=M`), pricing and pricing stream, orders with stop and take-profit on fill, trades, positions, summary, transactions (polled) | Transaction stream for instant fills; bid and ask candles (`price=BA`) for spread-aware backtests; trailing stop on fill; partial close of a trade | E-10, E-15, E-16 |
| IG | Session, markets, search, prices (candles), deal confirms, positions and working orders, activity history (polled) | Lightstreamer streaming for prices, 1-minute and 5-second candles, trade confirms and account updates; trailing and guaranteed stops; client sentiment; transaction history for realised P&L | E-11, E-16, E-17 |
| cTrader Open API | App and account auth, symbols, trendbars, spot subscription (streamed), orders, amend stop and target, reconcile, deals, unrealised P&L, execution events | Live trendbar subscription (broker-built 1-minute bars); tick data history for tick replay; depth of market; trailing stop flag | E-12, E-16, E-18 |
| Alpaca | Assets, stock bars, latest quote and trade (polled), orders, positions, account, fill activities | Market data WebSocket for trades, quotes and 1-minute bars; `trade_updates` WebSocket for fills; bracket, OCO and trailing-stop orders; crypto and options data and trading; SIP feed choice | E-13, E-14, E-16, E-19 |
| MT5 (sidecar) | Symbols, bars, tick, orders, stop and target, positions, account, history deals | `copy_ticks_range` for tick history; pushed ticks from the sidecar instead of polling | E-18 |
| IB (Gateway) | Contracts, historical bars, `reqMktData` ticks, orders, positions, account, executions | `reqRealTimeBars` (5-second bars); `reqHistoricalTicks`; `reqContractDetails` for futures multipliers (already on the roadmap) | E-18 |

**What "fully exploited" means for this app.** Every web API broker should stream prices, bars and fills through one interface, with polling kept only as a fallback. Adapters should report what they support (streaming, bid and ask bars, tick history, order types) so the app offers only what the connection can actually do (E-19).

## Streaming, storage, replay and backtesting

The recommended design adds a recorder in the backend. It turns the live stream into stored 1-minute bars and short-lived ticks. Backtests and bar replay then read only from the database, and the broker's own history overwrites the stream-built bars each night.

**What happens today**

- Live ticks go from the broker service to Redis pub/sub, then to the browser. Nothing is written to the database. The `tick_data` table exists but no code writes to it.
- Bars reach `candlestick_data` only through the backfill scheduler, on a timer, from the broker's history endpoint.
- Backtests ignore the database. `broker_service/routes/backtesting.py` downloads bars from the broker on every run (`_fetch_ib_bars`, `_fetch_adapter_bars`). Results change when the broker's history window moves, and runs fail when the broker is offline.
- **Bug (E-01):** `timescaledb-schema.sql` adds a TimescaleDB retention policy that drops every `candlestick_data` chunk older than 2 years. It ignores `history_start`, so deep history collected by PR #99 rolls off as it ages past two years, and the scheduler's cursor has already moved past it, so it is never fetched again. The same policy is why `history_start` is capped at 730 days. The app's own `cleanOldData` already respects `history_start`, so the TimescaleDB policy is redundant as well as harmful.
- Live streams exist only while a browser has the chart open. The bridge reference-counts browser sockets, so closing the tab stops the stream.
- Only one continuous aggregate exists (daily). Each other timeframe is collected and stored separately.

**Recommended design**

1. **Fix retention first (E-01).** Remove the 2-year TimescaleDB retention policy in a migration, keep `cleanOldData` as the only deletion path, and lift the 730-day cap on `history_start`. TimescaleDB compression for bars older than 7 days (typically about 90% smaller) moves to E-06, where it is tested against the upserts the recorder and backfill make into older chunks.
2. **Record without a browser (E-05).** Add a `record_live` flag to `data_collection_config`. The backend holds a server-side subscription for every recorded instrument, independent of browser sockets.
3. **Durable transport (E-05).** Switch broker-service publishing from Redis pub/sub to Redis Streams (`XADD`, capped with `MAXLEN`). The recorder reads with a consumer group, so a backend restart resumes where it stopped instead of losing ticks.
4. **Build and store bars (E-05).** The recorder builds 1-minute bid, ask and mid bars from ticks and upserts them with `source = 'stream'`. Where the broker publishes its own live bars (cTrader live trendbars, IG Lightstreamer candles, Alpaca bar stream, IB 5-second real-time bars), those are stored instead of built.
5. **Store ticks for a limited time (E-06).** Batch-insert ticks into `tick_data` with bid, ask and last columns, compressed after 1 day. Retention is set on the Settings page, defaulting to 30 days.
6. **Nightly reconciliation (E-07).** The backfill scheduler re-fetches the last 2 days of 1-minute history from the broker and overwrites stream-built bars (`source = 'broker'`). It records any gaps it fills in `data_quality_metrics`.
7. **Higher timeframes from 1 minute (E-08).** Continuous aggregates build 5-minute, 15-minute, 1-hour, 4-hour and daily bars from the 1-minute base, so every timeframe agrees. (Built with 30-minute bars as well. Backtests use them for 5 minutes to 1 hour when the broker's own bars are missing; 4-hour and daily built bars start on UTC boundaries, unlike a broker's, and wait for bar replay. See `E-05-live-recorder.md` section 12.)
8. **Backtest from the database (E-02).** The backend reads the stored bars and sends them to the broker service with the run. (The first version of this plan gave the broker service a read-only database role; Sean chose the simpler route on 10 November 2026, see `E-05-live-recorder.md` section 11.) Backtests read stored bars by default. A coverage check runs before each backtest. If bars are missing, the user chooses: fetch the gap from the broker and store it, then run; or run on what is stored. The run record saves the exact bar range and a hash of the data, so a result can be reproduced.
9. **Intrabar fills (E-03).** With 1-minute bars stored, a 1-hour strategy fills against the 1-minute path inside each bar. This closes the main backtest-to-live drift already listed in the roadmap. (Built as: the rule-set's protective stop, which the backtester used to ignore, is set, trailed and filled inside the bar along the stored 1-minute bars; `risk_pct` sizing is simulated from it. Entries and rule exits still fill at the signal bar's close.)
10. **Bar replay (E-04).** A replay mode on the chart page: pick an instrument, a timeframe and a start time. Then play, pause, step one bar, or set the speed (1x to 100x). Higher-timeframe bars form live from stored 1-minute bars, so the last candle grows as it would have. Optional: run a saved rule-set alongside the replay to show its signals and simulated fills. (Built as its own page, `/replay`, with the strategy's trades included. Indicators on the replay chart and trading by hand against the replay are not part of it.)

**Why this approach.** It keeps the existing split, where only the backend writes to the database. It reuses the backfill scheduler and `candlestick_data` instead of adding a second store. It uses TimescaleDB features the stack already runs. The alternatives were writing from the broker service directly, which breaks that split, or storing only ticks and building every bar on read, which is slow for multi-year backtests.

**Storage estimate.** One instrument's 1-minute bars come to about 370,000 rows a year for 24-hour FX, or about 100,000 for US stocks in regular hours. That is roughly 30 to 60 MB a year before compression and 3 to 6 MB after. Ticks are far larger: a busy FX pair can reach 100,000 ticks a day, about 15 to 25 MB a day uncompressed. That is why ticks are kept for 30 days by default. Ten FX pairs therefore need about 0.6 GB a year for bars and about 5 GB for a rolling 30 days of ticks. These figures are estimates to confirm against Sean's actual database after E-05 ships.

The diagram below shows the proposed flow.

```
Brokers ──▶ Broker service ──▶ Redis Streams ──▶ Backend (recorder + live bridge) ──live──▶ Charts
(web APIs,   (adapters,         (durable tick       │ 1m bars, ticks
 MT5, IB)     streams)           log)               ▼
                 │ broker history              TimescaleDB (bars, ticks, rollups)
                 ▼                                   │                 │
             Backfill job ──broker bars overwrite──▶ │                 │
             (nightly reconcile)                     ▼                 ▼
                                               Backtester         Charts (replay)
                                               (read-only role)
```

The recorder writes bars and ticks as they arrive. The nightly job replaces stream-built bars with the broker's own. Backtests and replay read only from the database.

## Lightweight Charts review

The shared chart component is sound: it sorts and de-duplicates bars, resizes correctly, and has tests. But it draws static history only. Live prices update a price badge, not the candles. The live page works only for MSFT. The library is one major version behind (v4.1, while v5.2 is current).

**What works**

- `frontend/app/components/Chart.tsx` is a single shared wrapper with candles, volume, indicator lines and signal markers. It sorts and de-duplicates input (`sortAndDedupe`), which avoids the library's ordering exceptions.
- `useChartResize` handles container resizing, and `Chart.test.tsx` covers the wrapper.
- Oscillators (MACD, RSI) get their own price scales, so they do not distort the price axis.

**Gaps**

| Gap | Effect | Item |
| --- | --- | --- |
| Live ticks update only the bid, ask and last badge in `MSFTRealtimeChart.tsx`; the last candle never moves | The chart is not live | E-20 |
| The live page, its history request and its stream are all hard-coded to `MSFT` | No live chart for FX, indices or any other broker's symbols | E-21 |
| On v4.1; v5 adds multiple panes, a smaller bundle, and markers and watermarks as plugins | Oscillators overlay the price pane instead of sitting in their own pane | E-22 |
| No loading of older bars on scroll-back (`subscribeVisibleLogicalRangeChange`) | Only the first page of history is reachable | E-23 |
| Times show in UTC, with no exchange or local time-zone option | FX sessions and stock opens are hard to read | E-23 |
| No bar replay controls | Needed for E-04 | E-04 |
| Open positions, working orders, stop and target levels are not drawn as price lines (`createPriceLine`) | Traders cannot see orders on the chart | E-24 |
| Light theme only, with hard-coded colours | No dark mode | E-25 |
| Five chart components overlap: `Chart`, `TradingChart` (not imported anywhere), `EnhancedTradingChart`, `HistoricalChart`, `MSFTRealtimeChart` | Duplicated logic and dead code | E-25 |
| No bid and ask view, and no spread display | FX traders cannot see the cost of trading | E-15 |

**Taking full advantage of the brokers.** After E-19, each connection reports what it supports. The chart should use that list to offer the right timeframes, including 5-second bars where the broker streams them, to show bid, ask or mid candles, and to show tick replay only where ticks are stored. One live chart page, driven by any symbol on any connection, replaces the MSFT page.

**Upgrade notes for v5 (E-22).** v5 replaces `addCandlestickSeries()` with `addSeries(CandlestickSeries, …)`, moves `setMarkers` to the `createSeriesMarkers` plugin, and adds a pane index to `addSeries`. All chart calls already go through `Chart.tsx` and `EquityCurveChart.tsx`, so the migration touches two files plus their tests. Pin an exact version (for example `5.2.1`) rather than a caret range. [Migration guide](https://tradingview.github.io/lightweight-charts/docs/migrations/from-v4-to-v5) · [v5 announcement](https://www.tradingview.com/blog/en/tradingview-lightweight-charts-version-5-50837)

## Security review

I found no critical vulnerability for a LAN-only deployment. Three findings are high: outdated broker-service web libraries with published CVEs, no lockfiles, so every rebuild installs unreviewed package versions, and a Node.js 20 runtime that is past end of life. The authentication design is good and needs only small fixes.

**Already sound:** scrypt password hashing; HMAC-signed, HttpOnly, SameSite=Lax session cookies; constant-time comparisons; login and setup-code lockout; a first-run setup code; AES-256-GCM encryption of stored secrets; a shared token between the backend and the broker service, with the broker service bound to 127.0.0.1; a password on Redis; a required secret on the MT5 sidecar when it is not on loopback; parameterised SQL; order MFA and an order audit log.

| ID | Severity (LAN only) | Finding | Fix |
| --- | --- | --- | --- |
| S-01 | High | `broker_service` and `mt5_sidecar` pin FastAPI 0.104.1, which brings Starlette 0.27.0, plus python-multipart 0.0.6 and anyio 3.7.1. `pip-audit` reports 25 advisories, mostly denial of service in request and multipart parsing. Fixed in Starlette 0.40 and later, python-multipart 0.0.18 and later. | Upgrade to current FastAPI, Starlette, python-multipart and anyio. Drop the `<0.28` httpx and `<7` instrumentator caps that held them back. Re-run the test suites. |
| S-02 | High | No `package-lock.json` in `backend` or `frontend`. Dockerfiles and CI run `npm install` against caret ranges, so each build can pull different code, including a compromised release. Python requirements also use `>=` ranges. | Commit lockfiles, use `npm ci` in Dockerfiles and CI, pin Python versions (or add a hashed lock), and add `npm audit` and `pip-audit` to CI. |
| S-03 | High | Images use `node:20-alpine`. Node.js 20 reached end of life in April 2026 and gets no security fixes. Next.js is on `^14`, an old major release. | Move to Node 22 LTS or 24 LTS. Upgrade Next.js to a supported major release. |
| S-04 | Medium | An empty CORS allow-list accepts any origin with credentials (`backend/src/index.ts`, `services/network.ts`). Other services on the same LAN domain count as same-site, so a compromised one could call the API with Sean's session cookie. | Default the allow-list to the app's own origin, and refuse to start in production with it empty. |
| S-05 | Medium | Sessions are stateless. Logout only clears the browser's cookie, so a copied cookie stays valid until it expires. The only way to end it early is to rotate the signing key, which signs everyone out. | Add a session ID and a server-side revocation list (or a per-user session version), so logout and "sign out everywhere" take effect at once. |
| S-06 | Medium | Backend and frontend containers run as root; only the broker service sets `USER`. The backend image also ships dev dependencies. | Add a non-root `USER` and multi-stage builds that copy only production dependencies. |
| S-07 | Medium | The MT5 sidecar and IB Gateway are reached over plain HTTP and TCP on the LAN. The sidecar's secret and every order request cross the network unencrypted. | Put the sidecar behind TLS, using the reverse proxy or uvicorn's own TLS, and limit IB Gateway's port to the app server with the Proxmox firewall (already in INSTALL § 8; add a check to `doctor`). |
| S-08 | Low | Ports 3000 and 4000 are published on all interfaces, so a LAN client can skip the reverse proxy and reach the backend directly. | Bind them to the proxy's interface, or to 127.0.0.1 when the proxy runs on the same host. |
| S-09 | Low | `/metrics` on the backend is open without authentication and shows route names and traffic. | Require a scrape token, or serve metrics on a separate port only Prometheus can reach. |
| S-10 | Low | The Socket.IO handshake accepts the API token in the URL query string (`?token=`), where proxies log it. | Accept tokens only in the `auth` payload or the header. |
| S-11 | Low | The 25 MB JSON body limit applies to every route, though only the Parquet export needs it. | Use the default 100 KB globally, and the larger limit only on the export route. |
| S-12 | Low | The backend sets no security headers (no `helmet`). | Add `helmet` and a Content Security Policy in the frontend server. |

Per Sean's instruction, none of these is being fixed yet. S-01 to S-03 should be fixed first, as one dependency PR.

## Instructions rewrite

The guides are already detailed: the installer has phases, answers and checks, and INSTALL Appendix A.5 sets rules for an agent. The rewrite makes every step follow one fixed template, so neither an agent nor a person has to guess. Every placeholder will be defined in one place, and every branch will be written out. The structure stays as it is: INSTALL, OPERATIONS, PAPER\_TRADING, DEVELOPMENT and FEATURES.

**Template every step will follow (D-01)**

1. **Where:** the exact host and shell, for example "CT 110, as user `tradingapp`, in `/opt/tradingapp`".
2. **Before:** what must already be true, with the command that proves it.
3. **Do:** the exact commands or clicks, in a copyable block, with no placeholders except ones from the values sheet.
4. **Expected:** the exact output, or the lines in it to look for.
5. **If it fails:** each known failure, with its cause and fix. Otherwise: stop and report, with the log to attach.
6. **Done when:** one verifiable check, ideally a `./tradingapp.sh doctor` line.

**Other changes**

- **D-02 Values sheet.** One table at the top of INSTALL lists every placeholder (`<db-address>`, `<app-address>`, VM and container IDs, ports) with its meaning, an example and where it is used. A filled copy goes to `/opt/tradingapp/site-values.md` (no secrets).
- **D-03 Decision points written out.** For example: which broker for which firm (now one type per firm), whether you need IB Gateway, and evaluation versus production. Each is a question with its answers and the step to jump to.
- **D-04 Remove the SQL workaround.** Put the MT5 symbol map and "account info from" on the Connections form (INSTALL § 4.9, a known gap). The SQL route in the guide then goes away.
- **D-05 New procedures** for each enhancement as it ships: turning on live recording, setting tick retention, running a backtest from stored data, using bar replay, and checking storage growth.
- **D-06 Sizing.** Update the database disk sizing in § 1.1 from the storage estimate in this document.
- **D-07 Checks on the docs themselves.** A CI job checks every internal link and anchor, and that every `./tradingapp.sh` subcommand named in the docs exists. An agent then dry-runs INSTALL on a fresh Proxmox test container and records every place it had to guess.
- **D-08 Upgrade guide** for the dependency and Node changes (S-01 to S-03): a backup, a rebuild, `doctor`, and a rollback path.

The rewrite runs after the code it documents, section by section. D-01 to D-03 can start at once, since they do not depend on code changes.

## Enhancement register

There are 47 items, sorted by priority. P1 means do next, P2 soon after, and P3 when convenient. Size is the rough scope of one pull request: S is a few files, M is one feature across the stack, L is several connected changes, and XL needs a design review first. The "Not alone" column names the models that should not do the task without a stronger model's plan and a careful review. Any item that touches orders or live trading gets a human review, whichever model does it.

| ID | Enhancement | Priority | Size | Recommended | Also capable | Not alone |
| --- | --- | --- | --- | --- | --- | --- |
| E-01 | Remove the 2-year TimescaleDB retention policy; lift the 730-day `history_start` cap | P1 | S | Sonnet 5.5 | Opus 5.5 | Haiku 5.5 |
| S-01 | Upgrade FastAPI, Starlette, python-multipart, anyio in broker service and MT5 sidecar | P1 | M | Opus 5.5 | Sonnet 5.5 (supervised) | Haiku 5.5 |
| S-02 | Commit npm lockfiles, use `npm ci`, pin Python, add `npm audit` and `pip-audit` to CI | P1 | S | Sonnet 5.5 | Haiku 5.5 | none |
| S-03 | Node 22 or 24 LTS images and a supported Next.js major release | P1 | L | Opus 5.5 | Sonnet 5.5 (supervised) | Haiku 5.5 |
| E-05 | Live recorder: server-side subscriptions, Redis Streams, 1-minute bars from the stream | P1 | XL | Fable 5.2 (design), Opus 5.5 (build) | none | Sonnet 5.5, Haiku 5.5 |
| E-06 | Store ticks with bid, ask and last, with a retention setting; compress ticks after 1 day and bars after 7 days | P1 | M | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
| E-02 | Backtests read stored bars, with a coverage check, a read-only database role and a data hash on each run | P1 | L | Opus 5.5 | Fable 5.2 | Sonnet 5.5, Haiku 5.5 |
| E-20 | Live ticks update the last candle, not just the price badge | P1 | M | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
| E-21 | One live chart page for any symbol on any connection, replacing the MSFT page | P1 | M | Opus 5.5 | Sonnet 5.5 (supervised) | Haiku 5.5 |
| E-30 | Default priority `oanda, ig, ctrader, alpaca, mt5, ib` (backend and broker service) | P1 | S | Sonnet 5.5 | Haiku 5.5 | none |
| E-31 | One connection type per firm: `firm` field, shared map, validation, migration | P1 | M | Sonnet 5.5 | Opus 5.5 | Haiku 5.5 |
| E-03 | Intrabar fills from stored 1-minute bars in the backtester | P2 | L | Fable 5.2 | Opus 5.5 | Sonnet 5.5, Haiku 5.5 |
| E-04 | Bar replay: play, pause, step, speed, forming candles, optional strategy signals | P2 | L | Opus 5.5 | Sonnet 5.5 (supervised) | Haiku 5.5 |
| E-07 | Nightly reconciliation of stream bars with broker history, gaps logged | P2 | M | Sonnet 5.5 | Opus 5.5 | Haiku 5.5 |
| E-08 | Continuous aggregates for 5m, 15m, 1h, 4h, 1d from 1-minute bars | P2 | M | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
| E-10 | OANDA transaction stream for instant fills (built: fills are stored as they happen while Fills sync is on; the poll stays on as the record) | P2 | M | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
| E-11 | IG Lightstreamer: prices, candles, trade confirms, account updates (built: live prices and trade events, which trigger an immediate fills sync; IG's own candles wait for the bar-streaming capability in E-19, and nothing in the app reads pushed account updates yet) | P2 | L | Opus 5.5 | Sonnet 5.5 (supervised) | Haiku 5.5 |
| E-13 | Alpaca WebSockets: market data and `trade_updates` (built: quotes and trades on the IEX feed; a fill on `trade_updates` triggers an immediate fills sync) | P2 | M | Sonnet 5.5 | Opus 5.5 | Haiku 5.5 |
| E-15 | Bid and ask bars (OANDA `price=BA` and others) and spread-aware backtests (built: OANDA bars store the spread at each close and backtests fill buys at the ask and sells at the bid; not built: a bid and ask chart view, spreads from other brokers, spreads on built or recorded bars) | P2 | M | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
| E-19 | Adapters report capabilities; app and chart offer only what each connection supports (built: each connection reports timeframes, live prices, spread bars, order types with times in force, stops on entry and how fills arrive; the live chart, the order ticket and Settings use it; not yet used by the download, historical, data collection, backtest and rule builder pages) | P2 | M | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
| E-22 | Lightweight Charts v5 with indicator panes, exact version pinned | P2 | M | Sonnet 5.5 | Opus 5.5 | Haiku 5.5 |
| E-23 | Load older bars on scroll-back; time-zone setting (UTC, exchange, local) (built on the live chart; the other chart pages keep UTC and their fixed range) | P2 | S | Sonnet 5.5 | Opus 5.5 | none |
| S-04 | CORS defaults to the app's own origin; refuse an empty list in production (built: an empty list now accepts the app's own pages only, so it is safe and nothing is refused at start; `*` still accepts any site and logs a warning) | P2 | S | Sonnet 5.5 | Haiku 5.5 | none |
| S-05 | Session IDs and server-side revocation; "sign out everywhere" (built: each cookie names a session kept in `auth_sessions`; logout, a per-browser sign out and "Sign out everywhere" on Settings > Security end it at once; every browser signs in once after the upgrade) | P2 | M | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
| S-06 | Non-root users and multi-stage builds for backend and frontend images (built: both run as `node`, with production dependencies only and read-only app files) | P2 | S | Sonnet 5.5 | Haiku 5.5 | none |
| S-07 | TLS to the MT5 sidecar; firewall check for IB Gateway in `doctor` (built: the sidecar serves HTTPS with its own certificate and the connection pins it by fingerprint; `doctor` lists each LAN broker link, whether it is encrypted, and the test to run from another machine, since the app server cannot see the firewall itself) | P2 | M | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
| D-01 | One step template across all guides | P2 | L | Sonnet 5.5 | Opus 5.5 | Haiku 5.5 |
| D-02 | Values sheet for every placeholder | P2 | S | Sonnet 5.5 | Haiku 5.5 | none |
| D-03 | Decision points written as questions with answers and jumps | P2 | S | Sonnet 5.5 | Opus 5.5 | Haiku 5.5 |
| D-08 | Upgrade guide for S-01 to S-03, with rollback | P2 | S | Sonnet 5.5 | Opus 5.5 | Haiku 5.5 |
| E-12 | cTrader live trendbars and depth of market | P3 | M | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
| E-14 | Alpaca crypto and options data and trading | P3 | L | Opus 5.5 | Fable 5.2 | Sonnet 5.5, Haiku 5.5 |
| E-16 | Trailing, bracket, OCO and guaranteed stops where each broker supports them | P3 | L | Opus 5.5, Fable 5.2 review | Fable 5.2 | Sonnet 5.5, Haiku 5.5 |
| E-17 | IG client sentiment and transaction history | P3 | S | Sonnet 5.5 | Opus 5.5 | Haiku 5.5 |
| E-18 | Tick and 5-second history: cTrader tick data, MT5 `copy_ticks_range`, IB historical ticks and real-time bars | P3 | M | Sonnet 5.5 | Opus 5.5 | Haiku 5.5 |
| E-24 | Positions, working orders, stops and targets as price lines on the chart | P3 | S | Sonnet 5.5 | Opus 5.5 | Haiku 5.5 |
| E-25 | Dark theme; merge the chart components; delete unused `TradingChart.tsx` | P3 | S | Sonnet 5.5 | Haiku 5.5 (deletion only) | none |
| E-36 | Check whether IBKR's Web API with OAuth is open to Sean's account; plan to retire IB Gateway if so | P3 | S | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |
| S-08 | Bind ports 3000 and 4000 to the proxy interface | P3 | S | Sonnet 5.5 | Haiku 5.5 | none |
| S-09 | Scrape token or separate port for `/metrics` | P3 | S | Sonnet 5.5 | Haiku 5.5 | none |
| S-10 | No API token in the Socket.IO query string | P3 | S | Sonnet 5.5 | Haiku 5.5 | none |
| S-11 | 100 KB body limit except on the export route | P3 | S | Haiku 5.5 | Sonnet 5.5 | none |
| S-12 | `helmet` and a Content Security Policy | P3 | S | Sonnet 5.5 | Opus 5.5 | Haiku 5.5 |
| D-04 | Symbol map and "account info from" on the Connections form; remove the SQL workaround | P3 | M | Sonnet 5.5 | Opus 5.5 | Haiku 5.5 |
| D-05 | Procedures for recording, tick retention, stored-data backtests, replay, storage checks | P3 | M | Sonnet 5.5 | Opus 5.5 | Haiku 5.5 |
| D-06 | Database disk sizing from the storage estimate | P3 | S | Sonnet 5.5 | Haiku 5.5 | none |
| D-07 | CI link and command checks, plus an agent dry run of INSTALL on a test container | P3 | M | Opus 5.5 | Sonnet 5.5 | Haiku 5.5 |

**Suggested pull requests.** (1) E-01 alone, since it stops data loss. (2) S-01, S-02 and S-03. (3) E-30 and E-31. (4) E-05 and E-06, after Fable 5.2 writes the design record into `docs/plans/`. (5) E-02, E-07 and E-08. (6) E-20, E-21 and E-22. Everything else follows in priority order. Sean signs off at the end of each step.

**Security sign-off.** After S-01 to S-07 merge, a Fable 5.2 pass reviews the whole diff and re-runs `pip-audit` and `npm audit`.

## Held for later

MCP servers and MT4 are on hold at Sean's request. They are not in the register.

- **MCP servers.** To investigate later. Two separate questions apply. First, can the app use a broker's MCP server as a connection? Axi's server works only inside Claude today, and Alpaca publishes an open-source MCP server. A web API is still the better route for an app, so this would rarely win. Second, should the app run its own MCP server, so Claude can read stored bars, run backtests and place paper orders? That needs the same order safeguards as the web app. [Alpaca MCP server](https://github.com/alpacahq/alpaca-mcp-server) · [Directory of broker MCP servers](https://github.com/oteroag01/awesome-broker-mcp)
- **MT4.** Not planned; MT5 is preferred. MT4 has no official Python API, so it would need an Expert Advisor bridge or a third-party cloud API. Each MT4 broker in scope also offers MT5.
