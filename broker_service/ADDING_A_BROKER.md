# Adding a broker

How to add the next broker with a direct API, so it gets the same features
the existing four have: a connection on Settings > Connections, connectivity
checks, contract search, charts, live prices, orders, and a place in the
broker priority.

`tests/test_broker_lists.py` fails, naming the file, until every list below
includes the new broker. Run it as you go.

## 1. The adapter (broker service)

Copy `templates/api_broker_adapter.py` to `broker_service/<name>_adapter.py`
and fill in each method. `oanda_adapter.py` is the worked example: it is an
API broker, and every return shape in the template is the one it returns.

What the rest of the app relies on:

| Method | Used by |
| --- | --- |
| `probe()` | Background connectivity checks, the Test button, the heartbeat |
| `search_contracts`, `historical_bars`, `realtime_quote`, `tick` | Contract search, charts, quotes, backtests |
| `stream_prices` (optional) | Live prices. Without it, `tick` is polled every `STREAM_POLL_SECONDS` |
| `place_order`, `cancel_order`, `modify_order` | Orders and the strategy runner |
| `positions`, `account_summary`, `open_orders`, `executions` | Account pages, reconciliation, `pct_equity` sizing |
| `instrument_spec` | Converting a size into this venue's units |

Rules every adapter keeps:

- **Errors**: raise `HTTPException` with 503 when the venue can't be reached,
  502 when it answers with an error, and 400 for a request it can never
  serve. Market data that names no broker falls back to the next broker on
  5xx only (`adapters.falls_back`).
- **Symbols**: take and return the app's form (`EUR.USD`, `AAPL`), and
  translate to the venue's form inside the adapter.
- **Orders**: call `orders._validate_common` first (the live-trading gate),
  and send `client_ids.client_order_id(...)` so a retry can't double-place.
  An order never moves to another broker.

Tests: copy `tests/test_oanda_adapter.py`. It serves the venue with
`httpx.MockTransport`, so nothing real is contacted.

## 2. Register the platform (broker service)

- `connections.py`
  - Add the name to `SUPPORTED_PLATFORMS`.
  - Add it to `BROKER_PRIORITY`. API brokers rank with OANDA, ahead of MT5.
  - In `_validate_platform_fields`, require the fields it needs. Reuse the
    existing `Connection` fields where they fit: `token`, `account_id`,
    `api_key`, `api_secret`, `url`, `secret`, `environment`. Add a field only
    for something new.
  - Optional: a single-account `.env` shorthand in `_legacy_connections`,
    like `OANDA_API_TOKEN`/`OANDA_ACCOUNT_ID`. Add those variables to the
    legacy list in `load_connections` and document them in `.env.example`.
- `adapters.py`: add a branch in `_build_adapters` and a hint in
  `_UNAVAILABLE_HINTS`.
- `tests/test_broker_lists.py`: add the class to `ADAPTER_CLASSES`.

`managed.py`, `probes.py` and `venue_streaming.py` need no changes. They work
on any registered adapter.

## 3. Backend

- `src/services/brokers.ts`: add the name to `BROKERS`.
- `src/services/orderTypes.ts`: add it to `BROKER_PRIORITY` in the same
  position as in `connections.py`. The Settings registry and the
  Connections store read these lists.
- `src/services/brokerConnections.ts`: add a `PLATFORM_FIELDS` entry.
  `settings` are stored in plain text, `secrets` are encrypted, and
  `required` is checked on save. If the broker service needs a value derived
  from the form, add it in `managedEntries` (OANDA's `environment` comes from
  the paper/live mode this way).

## 4. Frontend

`app/lib/brokerConnections.ts`:

- `BROKERS_BY_PRIORITY`, in the same order as `BROKER_PRIORITY`.
- `PLATFORM_FORM`: the add/edit form fields. These mirror `PLATFORM_FIELDS`,
  with `secret: true` on the encrypted ones.
- `PLATFORM_NAME`, plus `PLATFORM_SHORT_NAME` if the name is long.

The Connections tab, header health badge and strategy builder read these.

## 5. Check

```bash
cd broker_service && ruff check . && black --check . && pytest -q
cd backend && npm run lint && npm run format:check && npx tsc --noEmit && npx jest
cd frontend && npm run lint && npm run format:check && npm run type-check && npx vitest run
```

Then add a paper connection on Settings > Connections and press Test.
