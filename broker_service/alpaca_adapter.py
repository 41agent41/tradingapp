"""Alpaca adapter — market data + execution.

Alpaca is a cloud REST API (Trading API + Data API), reachable directly from
this Linux service — unlike MT5 there's no terminal/sidecar host involved.
This module implements the `MarketDataAdapter` and `BrokerAdapter` protocols
(`adapters.py`) as a thin `httpx` client, normalising Alpaca's responses into
the app's shapes (UTC unix-second timestamps, `CandlestickBar` /
`RealTimeQuote`) so `source=alpaca` charts and streams like `source=ib` from
the frontend's point of view.

### Alpaca REST contract used here

    Trading API (paper: https://paper-api.alpaca.markets, live: https://api.alpaca.markets)
      GET    /v2/assets?status=active&asset_class=us_equity
      POST   /v2/orders
      PATCH  /v2/orders/{id}   (Alpaca's replace/modify verb)
      DELETE /v2/orders/{id}
      GET    /v2/positions
      GET    /v2/account

    Data API (https://data.alpaca.markets)
      GET /v2/stocks/{symbol}/bars?timeframe=&start=&end=&limit=
      GET /v2/stocks/{symbol}/quotes/latest
      GET /v2/stocks/{symbol}/trades/latest

Auth is two headers on every request: `APCA-API-KEY-ID` / `APCA-API-SECRET-KEY`.

### Alpaca WebSockets used here

    Market data: wss://stream.data.alpaca.markets/v2/iex
      <- [{"T":"success","msg":"connected"}]
      -> {"action":"auth","key":..,"secret":..}
      <- [{"T":"success","msg":"authenticated"}]
      -> {"action":"subscribe","trades":[..],"quotes":[..]}
      <- [{"T":"q","S":"AAPL","bp":..,"ap":..}, {"T":"t","S":"AAPL","p":..}]

    Trade updates: wss://paper-api.alpaca.markets/stream (live: api.alpaca.markets)
      -> {"action":"auth","key":..,"secret":..}
      <- {"stream":"authorization","data":{"status":"authorized"}}
      -> {"action":"listen","data":{"streams":["trade_updates"]}}
      <- {"stream":"trade_updates","data":{"event":"fill","order":{..}}}

IEX is the feed every Alpaca account may stream. A free account may hold one
market data connection and subscribe to 30 symbols on it.

Order placement runs the same `_validate_common` gate the IB path applies
(defence in depth, identical to MT5) before anything reaches Alpaca.
"""

from __future__ import annotations

import json as _json
from datetime import UTC, datetime, timedelta
from typing import Any, Callable, Dict, List, Optional

import httpx
import pandas as pd
from fastapi import HTTPException

from indicators import calculator as indicator_calculator
from models import CandlestickBar, HistoricalDataResponse, RealTimeQuote
from observability import get_logger

logger = get_logger(__name__)

# App timeframe -> Alpaca native timeframe. Alpaca has no native 8-hour bar.
_TIMEFRAME_TO_ALPACA = {
    "1min": "1Min",
    "5min": "5Min",
    "15min": "15Min",
    "30min": "30Min",
    "1hour": "1Hour",
    "4hour": "4Hour",
    "1day": "1Day",
}

# App order_type/tif -> Alpaca's lowercase vocabulary. A clean 1:1 map (unlike
# OANDA, Alpaca supports all four IB order types).
_ORDER_TYPE_TO_ALPACA = {"MKT": "market", "LMT": "limit", "STP": "stop", "STP_LMT": "stop_limit"}
_ALPACA_TO_ORDER_TYPE = {v: k for k, v in _ORDER_TYPE_TO_ALPACA.items()}
_TIF_TO_ALPACA = {"DAY": "day", "GTC": "gtc", "IOC": "ioc", "FOK": "fok"}
_ACTION_TO_ALPACA = {"BUY": "buy", "SELL": "sell"}

_HTTP_TIMEOUT_SECONDS = 30.0
_TRADING_PAPER_BASE = "https://paper-api.alpaca.markets"
_TRADING_LIVE_BASE = "https://api.alpaca.markets"
_DATA_BASE = "https://data.alpaca.markets"
_DATA_STREAM_URL = "wss://stream.data.alpaca.markets/v2/iex"
# A stream is asked whether to stop at least this often.
_STREAM_WAIT_SECONDS = 5.0

# Rough bar budget per app period.
# Alpaca returns at most 10000 bars per request; longer spans follow
# next_page_token.
_MAX_BARS_PER_REQUEST = 10000
# How far back an app period reaches.
_PERIOD_TO_DAYS = {
    "1D": 1,
    "5D": 5,
    "1W": 7,
    "1M": 31,
    "3M": 92,
    "6M": 183,
    "1Y": 366,
    "2Y": 731,
    "5Y": 1827,
}
# A period (a chart) is capped so it stays quick and keeps the most recent
# bars; an explicit date range (the backfill, a download) may page further.
_MAX_PERIOD_PAGES = 5
_MAX_RANGE_PAGES = 200


class AlpacaAdapter:
    """`MarketDataAdapter` + `BrokerAdapter` backed by the Alpaca REST APIs."""

    # The price this venue builds its own bars from; the live recorder builds
    # stream bars the same way (docs/plans/E-05-live-recorder.md, D5).
    bar_basis = "last"

    name = "alpaca"
    # What the connection reports it supports (capabilities.py).
    timeframes = tuple(_TIMEFRAME_TO_ALPACA)
    order_tifs = {kind: tuple(_TIF_TO_ALPACA) for kind in _ORDER_TYPE_TO_ALPACA}

    def __init__(
        self,
        api_key: str,
        api_secret: str,
        *,
        paper: bool = True,
        timeout: float = _HTTP_TIMEOUT_SECONDS,
    ) -> None:
        self._trading_base = _TRADING_PAPER_BASE if paper else _TRADING_LIVE_BASE
        self._data_base = _DATA_BASE
        self._headers = {"APCA-API-KEY-ID": api_key, "APCA-API-SECRET-KEY": api_secret}
        self._timeout = timeout
        self._auth = {"action": "auth", "key": api_key, "secret": api_secret}
        self._trade_stream_url = self._trading_base.replace("https://", "wss://") + "/stream"

    # -- HTTP plumbing ----------------------------------------------------- #
    def _request(
        self,
        method: str,
        base: str,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        json: Optional[Dict[str, Any]] = None,
    ) -> Any:
        url = f"{base}{path}"
        try:
            with httpx.Client(timeout=self._timeout) as client:
                resp = client.request(
                    method,
                    url,
                    headers=self._headers,
                    params={k: v for k, v in (params or {}).items() if v is not None},
                    json=json,
                )
        except httpx.HTTPError as exc:
            logger.error("alpaca_unreachable", url=url, method=method, error=str(exc))
            raise HTTPException(503, f"Alpaca unreachable: {exc}")
        if resp.status_code >= 400:
            raise HTTPException(
                502, f"Alpaca error {resp.status_code} for {path}: {resp.text[:200]}"
            )
        try:
            return resp.json()
        except ValueError as exc:
            raise HTTPException(502, f"Alpaca returned non-JSON for {path}: {exc}")

    def _trading_get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Any:
        return self._request("GET", self._trading_base, path, params=params)

    def _data_get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Any:
        return self._request("GET", self._data_base, path, params=params)

    def _map_timeframe(self, timeframe: str) -> str:
        alpaca_tf = _TIMEFRAME_TO_ALPACA.get(timeframe)
        if alpaca_tf is None:
            raise HTTPException(400, f"timeframe '{timeframe}' is not supported on Alpaca")
        return alpaca_tf

    # -- MarketDataAdapter ------------------------------------------------- #
    def search_contracts(self, request: Any) -> Dict[str, Any]:
        symbol = (getattr(request, "symbol", "") or "").upper()
        limit = getattr(request, "max_results", None) or 50
        payload = self._trading_get("/v2/assets", {"status": "active", "asset_class": "us_equity"})
        assets = payload if isinstance(payload, list) else []
        # Alpaca has no free-text search endpoint — filter client-side by
        # symbol substring, same approach MT5's adapter uses for its sidecar.
        matches = [a for a in assets if symbol in (a.get("symbol") or "").upper()][:limit]
        results: List[Dict[str, Any]] = []
        for a in matches:
            sym = a.get("symbol") or ""
            results.append(
                {
                    "conid": str(a.get("id") or sym),
                    "symbol": sym,
                    "companyName": a.get("name") or sym,
                    "description": a.get("name") or sym,
                    "secType": "STK",
                    "exchange": a.get("exchange") or "SMART",
                    "currency": "USD",
                    "broker": "alpaca",
                }
            )
        return {"results": results, "count": len(results), "broker": "alpaca"}

    def historical_bars(
        self,
        symbol: str,
        timeframe: str,
        period: str = "1Y",
        *,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        indicators: Optional[List[str]] = None,
        account_mode: str = "paper",
    ) -> HistoricalDataResponse:
        alpaca_tf = self._map_timeframe(timeframe)
        params: Dict[str, Any] = {
            "timeframe": alpaca_tf,
            "adjustment": "raw",
            "limit": _MAX_BARS_PER_REQUEST,
        }
        if start_date and end_date:
            params["start"] = start_date
            params["end"] = end_date
            max_pages = _MAX_RANGE_PAGES
        else:
            # Without a start Alpaca answers from the start of today, so a
            # period is a start date. Newest first, so a capped period keeps
            # the most recent bars.
            days = _PERIOD_TO_DAYS.get(period, 366)
            params["start"] = (datetime.now(UTC) - timedelta(days=days)).strftime(
                "%Y-%m-%dT%H:%M:%SZ"
            )
            params["sort"] = "desc"
            max_pages = _MAX_PERIOD_PAGES

        raw_bars: List[Dict[str, Any]] = []
        for _ in range(max_pages):
            payload = self._data_get(f"/v2/stocks/{symbol.upper()}/bars", params)
            if not isinstance(payload, dict):
                break
            raw_bars.extend(payload.get("bars") or [])
            token = payload.get("next_page_token")
            if not token:
                break
            params = {**params, "page_token": token}

        rows = []
        for b in raw_bars:
            ts = datetime.fromisoformat(str(b["t"]).replace("Z", "+00:00")).timestamp()
            rows.append(
                {
                    "timestamp": ts,
                    "open": float(b["o"]),
                    "high": float(b["h"]),
                    "low": float(b["l"]),
                    "close": float(b["c"]),
                    "volume": int(b.get("v", 0) or 0),
                }
            )
        rows.sort(key=lambda r: r["timestamp"])

        bars = self._with_indicators(rows, indicators)
        return HistoricalDataResponse(
            symbol=symbol.upper(),
            timeframe=timeframe,
            period=period if not (start_date and end_date) else "CUSTOM",
            bars=bars,
            count=len(bars),
            last_updated=datetime.now(UTC).isoformat(),
        )

    def _with_indicators(
        self, rows: List[Dict[str, Any]], indicators: Optional[List[str]]
    ) -> List[CandlestickBar]:
        """Attach requested indicators with the same calculator the IB/MT5
        paths use, so charts render identically across every venue."""
        if not rows:
            return []
        if not indicators:
            return [CandlestickBar(**r) for r in rows]

        df = pd.DataFrame(rows)
        enriched = indicator_calculator.calculate_indicators(df, indicators)
        bars: List[CandlestickBar] = []
        allowed = set(CandlestickBar.model_fields.keys())
        for record in enriched.to_dict(orient="records"):
            clean = {
                k: (None if (isinstance(v, float) and pd.isna(v)) else v)
                for k, v in record.items()
                if k in allowed
            }
            bars.append(CandlestickBar(**clean))
        return bars

    def realtime_quote(self, symbol: str, account_mode: str = "paper") -> RealTimeQuote:
        payload = self._data_get(f"/v2/stocks/{symbol.upper()}/quotes/latest")
        q = payload.get("quote", {}) if isinstance(payload, dict) else {}
        return RealTimeQuote(
            symbol=symbol.upper(),
            bid=_opt_float(q.get("bp")),
            ask=_opt_float(q.get("ap")),
            last=_opt_float(q.get("ap")) or _opt_float(q.get("bp")),
            volume=_opt_int(q.get("bs")),
            timestamp=_iso_from(q.get("t")),
        )

    def tick(self, symbol: str, account_mode: str = "paper") -> Dict[str, Any]:
        payload = self._data_get(f"/v2/stocks/{symbol.upper()}/trades/latest")
        t = payload.get("trade", {}) if isinstance(payload, dict) else {}
        return {
            "symbol": symbol.upper(),
            "timestamp": _iso_from(t.get("t")),
            "bid": None,
            "ask": None,
            "last": t.get("p"),
            "volume": t.get("s"),
            "broker": "alpaca",
        }

    # -- streaming (WebSockets) -------------------------------------------- #
    def _listen(
        self,
        url: str,
        on_message: Callable[[Any, Callable[[Dict[str, Any]], None]], None],
        should_stop: Callable[[], bool],
        *,
        hello: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Open ``url`` and pass each JSON message to ``on_message(message,
        send)`` until ``should_stop()`` is true (asked every few seconds) or
        the server closes. ``hello`` is sent first when given. Raises on a
        refused or dropped connection; the caller retries."""
        try:
            ws = _connect(url, self._timeout)
        except _connection_errors() as exc:
            raise HTTPException(503, f"Alpaca stream unreachable: {exc}")
        try:

            def send(payload: Dict[str, Any]) -> None:
                ws.send(_json.dumps(payload))

            if hello is not None:
                send(hello)
            while not should_stop():
                try:
                    raw = ws.recv(timeout=_STREAM_WAIT_SECONDS)
                except TimeoutError:
                    continue
                except _connection_errors() as exc:
                    raise HTTPException(503, f"Alpaca stream closed: {exc}")
                # The trading stream sends its JSON in binary frames.
                text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
                try:
                    message = _json.loads(text)
                except ValueError:
                    continue
                on_message(message, send)
        finally:
            try:
                ws.close()
            except Exception:  # noqa: BLE001 — already gone
                pass

    def stream_prices(
        self,
        symbols: List[str],
        on_price: Callable[..., None],
        should_stop: Callable[[], bool],
    ) -> None:
        """Stream quotes and trades for ``symbols`` from Alpaca's market data
        WebSocket. A quote calls ``on_price(symbol, bid, ask, last=None)`` and
        a trade ``on_price(symbol, None, None, last=price)``: Alpaca builds
        its bars from trades, so the last price is a trade's, never a quote's
        midpoint. Blocks until ``should_stop()`` is true or the stream ends;
        raises on an error and the caller retries."""
        wanted = sorted({s.upper() for s in symbols})
        if not wanted:
            return
        by_upper = {s.upper(): s for s in symbols}

        def on_message(message: Any, send: Callable[[Dict[str, Any]], None]) -> None:
            for item in message if isinstance(message, list) else [message]:
                if not isinstance(item, dict):
                    continue
                kind = item.get("T")
                if kind == "error":
                    raise HTTPException(
                        502, f"Alpaca stream error {item.get('code')}: {item.get('msg')}"
                    )
                if kind == "success" and item.get("msg") == "connected":
                    send(self._auth)
                elif kind == "success" and item.get("msg") == "authenticated":
                    send({"action": "subscribe", "trades": wanted, "quotes": wanted})
                elif kind in ("q", "t"):
                    symbol = by_upper.get(str(item.get("S") or "").upper())
                    if symbol is None:
                        continue
                    if kind == "q":
                        bid, ask = _positive(item.get("bp")), _positive(item.get("ap"))
                        if bid is not None or ask is not None:
                            on_price(symbol, bid, ask, last=None)
                    else:
                        price = _positive(item.get("p"))
                        if price is not None:
                            on_price(symbol, None, None, last=price)

        self._listen(_DATA_STREAM_URL, on_message, should_stop)

    def stream_trade_events(
        self,
        on_event: Callable[[], None],
        should_stop: Callable[[], bool],
    ) -> None:
        """Call ``on_event()`` whenever an order fills or partly fills on this
        account, so fills can be read at once instead of at the next poll.
        The fills themselves still come from :meth:`executions`: a stream
        update and an account activity carry different ids, and reading one
        source means a fill cannot be stored twice. Blocks like
        :meth:`stream_prices`."""

        def on_message(message: Any, send: Callable[[Dict[str, Any]], None]) -> None:
            if not isinstance(message, dict):
                return
            stream = message.get("stream")
            data = message.get("data") if isinstance(message.get("data"), dict) else {}
            if stream == "authorization":
                if data.get("status") != "authorized":
                    raise HTTPException(502, "Alpaca refused the trade stream's key")
                send({"action": "listen", "data": {"streams": ["trade_updates"]}})
            elif stream == "trade_updates" and data.get("event") in ("fill", "partial_fill"):
                on_event()

        self._listen(self._trade_stream_url, on_message, should_stop, hello=self._auth)

    # -- BrokerAdapter (execution) ------------------------------------------ #
    def place_order(self, request: Any) -> Dict[str, Any]:
        """Place an order on Alpaca. The same order validation + live-trading
        gate the IB path applies runs first (defence in depth, identical to
        IB/MT5) — a live order without `LIVE_TRADING_ENABLED` is refused here
        just as it is for the other venues, before anything reaches Alpaca."""
        from orders import _validate_common  # shared gate; avoids an import cycle

        _validate_common(request.action, request.order_type, request.tif, request.account_mode)
        order_type = _ORDER_TYPE_TO_ALPACA.get(request.order_type)
        if order_type is None:
            raise HTTPException(400, f"order_type '{request.order_type}' is not supported")
        body: Dict[str, Any] = {
            "symbol": request.symbol.upper(),
            "qty": str(request.quantity),
            "side": _ACTION_TO_ALPACA[request.action],
            "type": order_type,
            "time_in_force": _TIF_TO_ALPACA[request.tif],
        }
        if request.limit_price is not None:
            body["limit_price"] = str(request.limit_price)
        if request.stop_price is not None:
            body["stop_price"] = str(request.stop_price)
        if getattr(request, "audit_id", None) is not None:
            body["client_order_id"] = f"audit-{request.audit_id}"

        resp = self._request("POST", self._trading_base, "/v2/orders", json=body)
        return {
            "order_id": resp.get("id"),
            "symbol": request.symbol.upper(),
            "action": request.action,
            "quantity": request.quantity,
            "order_type": request.order_type,
            "tif": request.tif,
            "account_mode": request.account_mode,
            "broker": "alpaca",
            "status": resp.get("status", "submitted"),
        }

    def cancel_order(self, order_id: int) -> Dict[str, Any]:
        self._request("DELETE", self._trading_base, f"/v2/orders/{order_id}")
        return {"order_id": order_id, "broker": "alpaca", "status": "cancel_requested"}

    def modify_order(self, order_id: int, request: Any) -> Dict[str, Any]:
        from orders import _validate_common

        _validate_common(
            request.action, request.order_type, request.tif or "DAY", request.account_mode
        )
        body: Dict[str, Any] = {"qty": str(request.quantity)} if request.quantity else {}
        if request.limit_price is not None:
            body["limit_price"] = str(request.limit_price)
        if request.stop_price is not None:
            body["stop_price"] = str(request.stop_price)
        if request.tif:
            body["time_in_force"] = _TIF_TO_ALPACA.get(request.tif, request.tif.lower())

        resp = self._request("PATCH", self._trading_base, f"/v2/orders/{order_id}", json=body)
        return {
            "order_id": order_id,
            "broker": "alpaca",
            "status": resp.get("status", "modify_requested"),
        }

    def positions(self) -> List[Dict[str, Any]]:
        """Open positions normalised to the app's ``models.Position`` shape.

        Alpaca reports ``qty`` signed (negative for a short), so the sign is
        carried straight through. Every venue's adapter returns this same shape
        — the app never sees a raw broker payload, matching how bars and quotes
        are already normalised.
        """

        payload = self._trading_get("/v2/positions")
        rows = payload if isinstance(payload, list) else []
        positions: List[Dict[str, Any]] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            size = _opt_float(row.get("qty"))
            if size is None or size == 0:
                continue
            positions.append(
                {
                    "symbol": str(row.get("symbol") or "").upper(),
                    "position": size,
                    "market_price": _opt_float(row.get("current_price")),
                    "market_value": _opt_float(row.get("market_value")),
                    "average_cost": _opt_float(row.get("avg_entry_price")),
                    "unrealized_pnl": _opt_float(row.get("unrealized_pl")),
                    "currency": "USD",
                }
            )
        return positions

    def probe(self) -> None:
        """Connectivity check for the in-app broker status: the cheapest
        authenticated call, so bad keys show as unreachable too."""
        self._trading_get("/v2/account")

    def account_summary(self) -> Dict[str, Any]:
        """Account state normalised to the app's ``models.AccountSummary``.

        `equity` is Alpaca's net liquidation value — the figure `pct_equity`
        sizing needs, which is why this is normalised rather than passed through
        raw: the engine can't be asked to learn each venue's field names.
        """

        payload = self._trading_get("/v2/account")
        account = payload if isinstance(payload, dict) else {}
        return {
            "account_id": str(account.get("account_number") or account.get("id") or "alpaca"),
            "net_liquidation": _opt_float(account.get("equity")),
            "currency": str(account.get("currency") or "USD"),
            "last_updated": datetime.now(UTC).isoformat(),
            "total_cash_value": _opt_float(account.get("cash")),
            "buying_power": _opt_float(account.get("buying_power")),
            "maintenance_margin": _opt_float(account.get("maintenance_margin")),
        }

    def open_orders(self) -> List[Dict[str, Any]]:
        """Working orders normalised to the app's ``models.Order`` shape."""

        payload = self._trading_get("/v2/orders", params={"status": "open", "limit": 500})
        rows = payload if isinstance(payload, list) else []
        orders: List[Dict[str, Any]] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            quantity = _opt_float(row.get("qty")) or 0.0
            filled = _opt_float(row.get("filled_qty"))
            orders.append(
                {
                    "order_id": str(row.get("id") or ""),
                    "symbol": str(row.get("symbol") or "").upper(),
                    "action": (
                        "SELL" if str(row.get("side") or "").lower().startswith("sell") else "BUY"
                    ),
                    "quantity": quantity,
                    "order_type": _ALPACA_TO_ORDER_TYPE.get(
                        str(row.get("type") or ""), str(row.get("type") or "MKT").upper()
                    ),
                    "status": str(row.get("status") or "unknown"),
                    "filled_quantity": filled,
                    "remaining_quantity": (quantity - filled) if filled is not None else None,
                    "avg_fill_price": _opt_float(row.get("filled_avg_price")),
                }
            )
        return orders

    def instrument_spec(self, symbol: str) -> Dict[str, Any]:
        """Alpaca trades US equities in whole shares — the same unit semantics
        as IB, which is why the two already share the live sizer's share path.
        Fractional shares exist on Alpaca but are deliberately not modelled
        here: the app's order path is whole-share throughout."""

        return {
            "symbol": symbol.upper(),
            "broker": "alpaca",
            "unit": "shares",
            "min_size": 1.0,
            "size_step": 1.0,
            "max_size": None,
            "contract_size": 1.0,
            "currency": "USD",
        }

    def executions(self, days: int = 1) -> List[Dict[str, Any]]:
        """Recent fills, normalised to the app's ``models.Execution`` shape.

        Alpaca reports fills as account *activities* of type ``FILL``. Both
        ``FILL`` and ``PARTIAL_FILL`` come back under that filter, each with its
        own activity id — which is exactly the per-fill granularity the app
        needs, and why the audit-log estimate it replaces was wrong about
        partials. Alpaca charges no commission on equities, so the field is a
        definite ``0.0`` here rather than an unknown ``None``.

        ``sell_short`` is a SELL like any other: the app models direction with
        ``side`` plus a signed running position, not with a third state.
        """

        after = (datetime.now(UTC) - timedelta(days=max(1, days))).isoformat()
        payload = self._trading_get(
            "/v2/account/activities/FILL", params={"after": after, "page_size": 500}
        )
        rows = payload if isinstance(payload, list) else []
        fills: List[Dict[str, Any]] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            exec_id = str(row.get("id") or "")
            quantity = _opt_float(row.get("qty"))
            price = _opt_float(row.get("price"))
            if not exec_id or quantity is None or price is None:
                continue
            side = "SELL" if str(row.get("side") or "").lower().startswith("sell") else "BUY"
            fills.append(
                {
                    "exec_id": exec_id,
                    "order_id": str(row.get("order_id")) if row.get("order_id") else None,
                    "symbol": str(row.get("symbol") or "").upper(),
                    "side": side,
                    "quantity": abs(quantity),
                    "price": price,
                    "commission": 0.0,
                    "realized_pnl": None,
                    "executed_at": _iso_from(row.get("transaction_time")),
                    "account": None,
                    "currency": "USD",
                    "broker": "alpaca",
                }
            )
        return fills


def _connect(url: str, timeout: float) -> Any:
    """Open the WebSocket. Its own function so tests can replace it."""
    from websockets.sync.client import connect

    return connect(url, open_timeout=timeout, close_timeout=2)


def _connection_errors() -> tuple:
    """What a dropped or refused connection raises."""
    try:
        from websockets.exceptions import WebSocketException
    except ImportError:  # pragma: no cover - websockets ships with uvicorn[standard]
        return (OSError,)
    return (OSError, WebSocketException)


def _positive(v: Any) -> Optional[float]:
    """A price, or None for a missing or zero one (an empty side of the book)."""
    value = _opt_float(v)
    return value if value is not None and value > 0 else None


def _opt_float(v: Any) -> Optional[float]:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _opt_int(v: Any) -> Optional[int]:
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _iso_from(value: Any) -> str:
    """ISO-8601 UTC string from an Alpaca RFC-3339 timestamp, defaulting to now."""
    if value is None:
        return datetime.now(UTC).isoformat()
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).isoformat()
    except (ValueError, OSError):
        return datetime.now(UTC).isoformat()
