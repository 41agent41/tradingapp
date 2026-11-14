"""cTrader adapter — market data + execution through Spotware's cTrader Open API.

One integration for every broker that offers cTrader: in Australia that
includes IC Markets, Pepperstone, FP Markets and Fusion Markets, among
others. The Open API is a cloud service run by Spotware, so like OANDA there
is no terminal or sidecar host; the broker is chosen by the trading account
the access token was granted for.

### Wire contract

The API speaks JSON over a WebSocket (``wss://demo.ctraderapi.com:5036`` or
``wss://live.ctraderapi.com:5036``). Every message is::

    {"clientMsgId": "...", "payloadType": 2100, "payload": {...}}

and a reply carries the request's ``clientMsgId``. A connection is
authorised twice before it can do anything: the *application* (client id and
secret from openapi.ctrader.com) and then the *trading account*
(``ctidTraderAccountId`` and the OAuth access token the account holder
granted). Each call here opens a connection, authorises it, does its work
and closes it; streaming keeps one open with a heartbeat.

    2100/2101 ApplicationAuth     2102/2103 AccountAuth
    2114/2115 SymbolsList         2116/2117 SymbolById      2112/2113 AssetList
    2145/2146 GetTickData (tick history, one side at a time)
    2137/2138 GetTrendbars        2127/2128 SubscribeSpots  2131 SpotEvent
    2135/2165 SubscribeLiveTrendbar (the forming bar then rides on SpotEvent)
    2156/2157 SubscribeDepthQuotes  2155 DepthEvent
    2106 NewOrder   2108 CancelOrder   2109 AmendOrder   2110 AmendPositionSLTP
    2126 ExecutionEvent   2132 OrderErrorEvent   2142 ErrorRes   51 Heartbeat
    2121/2122 Trader      2124/2125 Reconcile   2187/2188 PositionUnrealizedPnL
    2133/2134 DealList

### Units the rest of the codebase never sees

  - **Prices** on spots and trendbars are integers in 1/100000 of the price;
    order and position prices are plain decimals.
  - **Volume** is in hundredths of a unit (1 EURUSD lot = 100,000 units =
    10,000,000). The app's quantity for cTrader is **units**, like OANDA's.
  - **Money** is an integer scaled by ``moneyDigits``.
  - **Symbols** are numeric ids; the app's ``EUR.USD`` matches the account's
    ``EURUSD`` by name, and a broker suffix (``EURUSD.r``) passes through.

**Protection.** A stop and target ride on the entry. A market order can only
carry them as distances, so they are set from the current price and the
venue's record of the resulting levels is echoed back for verification.

**Access tokens** last about 30 days. Refreshing one replaces the stored
refresh token, which this service cannot write back, so an expired token
shows as a failed connection check until a new one is entered on Settings.
"""

from __future__ import annotations

import json as _json
import re
import time
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Any, Callable, Dict, Iterator, List, Optional

import pandas as pd
from fastapi import HTTPException

from client_ids import client_order_id
from indicators import calculator as indicator_calculator
from models import CandlestickBar, HistoricalDataResponse, RealTimeQuote
from observability import get_logger
from stops import is_more_protective

logger = get_logger(__name__)

_DEMO_URL = "wss://demo.ctraderapi.com:5036"
_LIVE_URL = "wss://live.ctraderapi.com:5036"
_TIMEOUT_SECONDS = 15.0
_HEARTBEAT_SECONDS = 10.0
_PRICE_SCALE = 100_000
_VOLUME_SCALE = 100
# A live 1-minute bar is passed on this long after its minute ends, when no
# later price has already closed it.
_BAR_GRACE_SECONDS = 2.0
# Depth of market: how long to wait for the book, and for it to settle.
_DEPTH_WAIT_SECONDS = 3.0
_DEPTH_SETTLE_SECONDS = 0.4
_DEPTH_MAX_LEVELS = 50

# Payload types (ProtoOAPayloadType / ProtoPayloadType).
HEARTBEAT = 51
ERROR_RES = 50
APP_AUTH_REQ, APP_AUTH_RES = 2100, 2101
ACCOUNT_AUTH_REQ, ACCOUNT_AUTH_RES = 2102, 2103
NEW_ORDER_REQ = 2106
CANCEL_ORDER_REQ = 2108
AMEND_ORDER_REQ = 2109
AMEND_POSITION_SLTP_REQ = 2110
ASSET_LIST_REQ, ASSET_LIST_RES = 2112, 2113
SYMBOLS_LIST_REQ, SYMBOLS_LIST_RES = 2114, 2115
SYMBOL_BY_ID_REQ, SYMBOL_BY_ID_RES = 2116, 2117
TRADER_REQ, TRADER_RES = 2121, 2122
RECONCILE_REQ, RECONCILE_RES = 2124, 2125
EXECUTION_EVENT = 2126
SUBSCRIBE_SPOTS_REQ, SUBSCRIBE_SPOTS_RES = 2127, 2128
SPOT_EVENT = 2131
ORDER_ERROR_EVENT = 2132
DEAL_LIST_REQ, DEAL_LIST_RES = 2133, 2134
GET_TRENDBARS_REQ, GET_TRENDBARS_RES = 2137, 2138
SUBSCRIBE_LIVE_TRENDBAR_REQ, SUBSCRIBE_LIVE_TRENDBAR_RES = 2135, 2165
OA_ERROR_RES = 2142
GET_TICKDATA_REQ, GET_TICKDATA_RES = 2145, 2146
DEPTH_EVENT = 2155
SUBSCRIBE_DEPTH_REQ, SUBSCRIBE_DEPTH_RES = 2156, 2157
UNREALIZED_PNL_REQ, UNREALIZED_PNL_RES = 2187, 2188

# Enums. The JSON API may answer with either the number or the name.
_ORDER_TYPE = {"MARKET": 1, "LIMIT": 2, "STOP": 3, "STOP_LOSS_TAKE_PROFIT": 4, "STOP_LIMIT": 6}
_APP_TO_ORDER_TYPE = {"MKT": 1, "LMT": 2, "STP": 3, "STP_LMT": 6}
_ORDER_TYPE_TO_APP = {1: "MKT", 2: "LMT", 3: "STP", 6: "STP_LMT"}
_TRADE_SIDE = {"BUY": 1, "SELL": 2}
_TIF = {"GOOD_TILL_DATE": 1, "GOOD_TILL_CANCEL": 2, "IMMEDIATE_OR_CANCEL": 3, "FILL_OR_KILL": 4}
_EXECUTION_TYPE = {
    "ORDER_ACCEPTED": 2,
    "ORDER_FILLED": 3,
    "ORDER_REPLACED": 4,
    "ORDER_CANCELLED": 5,
    "ORDER_EXPIRED": 6,
    "ORDER_REJECTED": 7,
    "ORDER_CANCEL_REJECTED": 8,
    "ORDER_PARTIAL_FILL": 11,
}
_DEAL_STATUS = {"FILLED": 2, "PARTIALLY_FILLED": 3}
_PERIOD = {"M1": 1, "M5": 5, "M15": 7, "M30": 8, "H1": 9, "H4": 10, "D1": 12}
_TIMEFRAME_TO_PERIOD = {
    "1min": "M1",
    "5min": "M5",
    "15min": "M15",
    "30min": "M30",
    "1hour": "H1",
    "4hour": "H4",
    "1day": "D1",
}
_PERIOD_SECONDS = {
    "M1": 60,
    "M5": 300,
    "M15": 900,
    "M30": 1800,
    "H1": 3600,
    "H4": 14400,
    "D1": 86400,
}
# How much history one trendbar request covers. Spotware caps a request's
# span per period, so a longer reach is walked in windows of this size, and
# a window answered short is walked again from where its answer stopped.
_WINDOW_DAYS = {"M1": 5, "M5": 30, "M15": 60, "M30": 120, "H1": 180, "H4": 365, "D1": 1825}
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
_MAX_PERIOD_REQUESTS = 10
_MAX_RANGE_REQUESTS = 200
# Historical requests are limited to 5 a second per connection.
_HISTORY_PAUSE_SECONDS = 0.25
# Tick history: cTrader answers at most a week per request, one side (bid or
# ask) at a time, newest first, and says when the window holds more.
_TICK_WINDOW = timedelta(days=7)
_TICK_MAX_REQUESTS = 40
_QUOTE_TYPE = {"bid": 1, "ask": 2}

# Errors that mean the stored credentials, not the request, are the problem.
_TOKEN_ERRORS = {
    "OA_AUTH_TOKEN_EXPIRED",
    "CH_ACCESS_TOKEN_INVALID",
    "ACCOUNT_NOT_AUTHORIZED",
    "CH_CLIENT_AUTH_FAILURE",
    "CH_CTID_TRADER_ACCOUNT_NOT_FOUND",
}

_FX_NAME_RE = re.compile(r"^([A-Z]{3})([A-Z]{3})$")


def _key(symbol: str) -> str:
    """The comparison form of a symbol: `EUR.USD`, `EURUSD`, `eur/usd` all
    become `EURUSD`; a suffix stays part of it (`EURUSD.r` -> `EURUSDR`)."""
    return re.sub(r"[^A-Z0-9]", "", symbol.upper())


def _from_name(name: str) -> str:
    """`EURUSD` -> the app's `EUR.USD`; any other name is its own symbol."""
    m = _FX_NAME_RE.match(name)
    return f"{m.group(1)}.{m.group(2)}" if m else name


def _enum(value: Any, names: Dict[str, int]) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, str) and not value.lstrip("-").isdigit():
        return names.get(value)
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _opt_float(v: Any) -> Optional[float]:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _connect(url: str, timeout: float) -> Any:
    """Open the WebSocket. Its own function so tests can replace it."""
    from websockets.sync.client import connect

    return connect(url, open_timeout=timeout, close_timeout=2)


def _connection_errors() -> tuple:
    """What a dropped or refused connection raises."""
    try:
        from websockets.exceptions import WebSocketException
    except ImportError:  # pragma: no cover - websockets ships with uvicorn[standard]
        return (OSError, TimeoutError)
    return (OSError, TimeoutError, WebSocketException)


class _Session:
    """One authorised connection. ``request`` sends a message and returns the
    reply carrying its ``clientMsgId``; unrelated messages are skipped."""

    def __init__(self, ws: Any, account_id: int, timeout: float) -> None:
        self._ws = ws
        self.account_id = account_id
        self._timeout = timeout

    def send(self, payload_type: int, payload: Dict[str, Any]) -> str:
        msg_id = uuid.uuid4().hex[:16]
        self._ws.send(
            _json.dumps({"clientMsgId": msg_id, "payloadType": payload_type, "payload": payload})
        )
        return msg_id

    def receive(self, timeout: float) -> Optional[Dict[str, Any]]:
        try:
            raw = self._ws.recv(timeout=timeout)
        except TimeoutError:
            return None
        try:
            msg = _json.loads(raw)
        except (TypeError, ValueError):
            return {}
        return msg if isinstance(msg, dict) else {}

    def request(
        self,
        payload_type: int,
        payload: Optional[Dict[str, Any]] = None,
        *,
        expect: int,
        account: bool = True,
    ) -> Dict[str, Any]:
        body = dict(payload or {})
        if account:
            body.setdefault("ctidTraderAccountId", self.account_id)
        msg_id = self.send(payload_type, body)
        deadline = time.monotonic() + self._timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise HTTPException(503, f"cTrader did not answer request {payload_type} in time")
            msg = self.receive(remaining)
            if msg is None:
                continue
            if msg.get("clientMsgId") != msg_id:
                continue
            reply_type = _int(msg.get("payloadType"))
            reply = msg.get("payload") if isinstance(msg.get("payload"), dict) else {}
            if reply_type in (OA_ERROR_RES, ERROR_RES, ORDER_ERROR_EVENT):
                raise _venue_error(reply)
            if reply_type == expect:
                return reply

    def executions(self, payload_type: int, payload: Dict[str, Any], done: Callable) -> Dict:
        """Send an order request and read its execution events until ``done``
        accepts one. Returns that event. An order error or a rejection raises;
        running out of time returns the last event seen (or {})."""
        body = {"ctidTraderAccountId": self.account_id, **payload}
        msg_id = self.send(payload_type, body)
        client_id = payload.get("clientOrderId")
        deadline = time.monotonic() + self._timeout
        last: Dict[str, Any] = {}
        while time.monotonic() < deadline:
            msg = self.receive(deadline - time.monotonic())
            if not msg:
                continue
            reply_type = _int(msg.get("payloadType"))
            reply = msg.get("payload") if isinstance(msg.get("payload"), dict) else {}
            order = reply.get("order") if isinstance(reply.get("order"), dict) else {}
            ours = msg.get("clientMsgId") == msg_id or (
                client_id is not None and order.get("clientOrderId") == client_id
            )
            if not ours:
                continue
            if reply_type in (OA_ERROR_RES, ERROR_RES, ORDER_ERROR_EVENT):
                raise _venue_error(reply, status=422 if reply_type == ORDER_ERROR_EVENT else 502)
            if reply_type != EXECUTION_EVENT:
                continue
            kind = _enum(reply.get("executionType"), _EXECUTION_TYPE)
            if kind in (
                _EXECUTION_TYPE["ORDER_REJECTED"],
                _EXECUTION_TYPE["ORDER_CANCEL_REJECTED"],
            ):
                raise HTTPException(
                    422,
                    f"cTrader rejected the order: {reply.get('errorCode') or 'no reason given'}",
                )
            last = reply
            if done(kind):
                return reply
        return last

    def heartbeat(self) -> None:
        self._ws.send(_json.dumps({"payloadType": HEARTBEAT, "payload": {}}))


def _venue_error(reply: Dict[str, Any], status: int = 502) -> HTTPException:
    code = str(reply.get("errorCode") or "UNKNOWN")
    description = reply.get("description") or ""
    if code in _TOKEN_ERRORS:
        return HTTPException(
            502,
            f"cTrader refused the connection's credentials ({code}). The access token "
            "may have expired: issue a new one and update the connection on Settings.",
        )
    return HTTPException(status, f"cTrader error {code}: {description}".strip())


class CTraderAdapter:
    """`MarketDataAdapter` + `BrokerAdapter` over the cTrader Open API."""

    # The price this venue builds its own bars from; the live recorder builds
    # stream bars the same way (docs/plans/E-05-live-recorder.md, D5).
    bar_basis = "bid"
    # ``stream_prices`` also passes on the venue's own 1-minute bars, which
    # the recorder stores in place of the ones it builds from quotes.
    streams_bars = True

    name = "ctrader"
    # Stops ride on the entry order (as distances on a market order).
    attaches_stops = True
    # The stop can trail the price at cTrader (``trailingStopLoss``).
    trailing_stops = True
    # What the connection reports it supports (capabilities.py).
    timeframes = tuple(_TIMEFRAME_TO_PERIOD)
    order_tifs = {kind: ("DAY", "GTC", "IOC", "FOK") for kind in _APP_TO_ORDER_TYPE}

    def __init__(
        self,
        client_id: str,
        client_secret: str,
        access_token: str,
        account_id: str,
        *,
        environment: str = "demo",
        timeout: float = _TIMEOUT_SECONDS,
    ) -> None:
        self._url = _LIVE_URL if environment == "live" else _DEMO_URL
        self._client_id = client_id
        self._client_secret = client_secret
        self._access_token = access_token
        try:
            self._account_id = int(account_id)
        except (TypeError, ValueError):
            self._account_id = 0
        self._timeout = timeout
        self._symbols: Optional[Dict[str, Dict[str, Any]]] = None
        self._symbols_at = 0.0
        self._details: Dict[int, Dict[str, Any]] = {}
        self._assets: Optional[Dict[int, str]] = None

    # -- connection -------------------------------------------------------- #
    @contextmanager
    def _session(self) -> Iterator[_Session]:
        if not self._account_id:
            raise HTTPException(400, "cTrader connection has no numeric trading account id")
        try:
            ws = _connect(self._url, self._timeout)
        except _connection_errors() as exc:
            logger.error("ctrader_unreachable", url=self._url, error=str(exc))
            raise HTTPException(503, f"cTrader unreachable: {exc}")
        session = _Session(ws, self._account_id, self._timeout)
        try:
            session.request(
                APP_AUTH_REQ,
                {"clientId": self._client_id, "clientSecret": self._client_secret},
                expect=APP_AUTH_RES,
                account=False,
            )
            session.request(
                ACCOUNT_AUTH_REQ,
                {"ctidTraderAccountId": self._account_id, "accessToken": self._access_token},
                expect=ACCOUNT_AUTH_RES,
            )
            yield session
        except _connection_errors() as exc:  # the socket dropped mid-conversation
            logger.error("ctrader_connection_lost", error=str(exc))
            raise HTTPException(503, f"cTrader connection lost: {exc}")
        finally:
            try:
                ws.close()
            except Exception:  # noqa: BLE001 - closing is best effort
                pass

    # -- catalogue --------------------------------------------------------- #
    def _symbol_list(self, session: _Session) -> Dict[str, Dict[str, Any]]:
        if self._symbols is None or time.monotonic() - self._symbols_at > 3600:
            reply = session.request(SYMBOLS_LIST_REQ, {}, expect=SYMBOLS_LIST_RES)
            symbols: Dict[str, Dict[str, Any]] = {}
            for s in reply.get("symbol") or []:
                if isinstance(s, dict) and s.get("symbolName") and s.get("enabled", True):
                    symbols[_key(str(s["symbolName"]))] = s
            self._symbols = symbols
            self._symbols_at = time.monotonic()
        return self._symbols

    def _resolve(self, session: _Session, symbol: str) -> Dict[str, Any]:
        found = self._symbol_list(session).get(_key(symbol))
        if found is None:
            raise HTTPException(400, f"symbol '{symbol}' is not offered on this cTrader account")
        return found

    def _detail(self, session: _Session, symbol_id: int) -> Dict[str, Any]:
        """``ProtoOASymbol``: digits and volume limits, cached by id."""
        cached = self._details.get(symbol_id)
        if cached is not None:
            return cached
        reply = session.request(
            SYMBOL_BY_ID_REQ, {"symbolId": [symbol_id]}, expect=SYMBOL_BY_ID_RES
        )
        rows = [s for s in reply.get("symbol") or [] if isinstance(s, dict)]
        if not rows:
            raise HTTPException(502, f"cTrader returned no details for symbol id {symbol_id}")
        self._details[symbol_id] = rows[0]
        return rows[0]

    def _asset_names(self, session: _Session) -> Dict[int, str]:
        if self._assets is None:
            reply = session.request(ASSET_LIST_REQ, {}, expect=ASSET_LIST_RES)
            self._assets = {
                _int(a.get("assetId")): str(a.get("name") or "")
                for a in reply.get("asset") or []
                if isinstance(a, dict)
            }
        return self._assets

    def _name_of(self, session: _Session, symbol_id: int) -> str:
        for s in self._symbol_list(session).values():
            if _int(s.get("symbolId")) == symbol_id:
                return _from_name(str(s.get("symbolName")))
        return str(symbol_id)

    # -- Connectivity check ------------------------------------------------ #
    def probe(self) -> None:
        with self._session() as session:
            session.request(TRADER_REQ, {}, expect=TRADER_RES)

    # -- MarketDataAdapter ------------------------------------------------- #
    def search_contracts(self, request: Any) -> Dict[str, Any]:
        query = _key(getattr(request, "symbol", "") or "")
        limit = getattr(request, "max_results", None) or 50
        with self._session() as session:
            symbols = self._symbol_list(session)
            assets = self._asset_names(session)
        results: List[Dict[str, Any]] = []
        for key, s in symbols.items():
            description = str(s.get("description") or "")
            if query not in key and query not in _key(description):
                continue
            name = str(s.get("symbolName"))
            results.append(
                {
                    "conid": str(s.get("symbolId")),
                    "symbol": _from_name(name),
                    "companyName": description or name,
                    "description": description or name,
                    "secType": "CASH" if _FX_NAME_RE.match(name) else "CFD",
                    "exchange": "CTRADER",
                    "currency": assets.get(_int(s.get("quoteAssetId")), ""),
                    "broker": "ctrader",
                }
            )
            if len(results) >= limit:
                break
        return {"results": results, "count": len(results), "broker": "ctrader"}

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
        period_name = _TIMEFRAME_TO_PERIOD.get(timeframe)
        if period_name is None:
            raise HTTPException(400, f"timeframe '{timeframe}' is not supported on cTrader")
        if start_date and end_date:
            start = datetime.fromisoformat(f"{start_date}T00:00:00+00:00")
            end = datetime.fromisoformat(f"{end_date}T00:00:00+00:00")
            budget = _MAX_RANGE_REQUESTS
        else:
            end = datetime.now(UTC)
            start = end - timedelta(days=_PERIOD_TO_DAYS.get(period, 366))
            budget = _MAX_PERIOD_REQUESTS

        with self._session() as session:
            symbol_id = _int(self._resolve(session, symbol).get("symbolId"))
            bars = self._trendbars(session, symbol_id, period_name, start, end, budget)

        rows = [
            r
            for ts, r in sorted(bars.items())
            if start.timestamp() <= ts < end.timestamp() or not (start_date and end_date)
        ]
        candles = self._with_indicators(rows, indicators)
        return HistoricalDataResponse(
            symbol=symbol.upper(),
            timeframe=timeframe,
            period=period if not (start_date and end_date) else "CUSTOM",
            bars=candles,
            count=len(candles),
            last_updated=datetime.now(UTC).isoformat(),
        )

    def _trendbars(
        self,
        session: _Session,
        symbol_id: int,
        period_name: str,
        start: datetime,
        end: datetime,
        budget: int,
    ) -> Dict[float, Dict[str, Any]]:
        """Bars between ``start`` and ``end``, keyed by unix seconds. Walks
        back from ``end`` one window at a time; when a window comes back
        starting later than it was asked to, the walk continues from the
        first bar it did return, so a capped answer leaves no hole."""
        step = _PERIOD_SECONDS[period_name]
        window = timedelta(days=_WINDOW_DAYS[period_name])
        bars: Dict[float, Dict[str, Any]] = {}
        cursor = end
        for i in range(budget):
            if cursor <= start:
                break
            lo = max(start, cursor - window)
            if i:
                time.sleep(_HISTORY_PAUSE_SECONDS)
            reply = session.request(
                GET_TRENDBARS_REQ,
                {
                    "symbolId": symbol_id,
                    "period": _PERIOD[period_name],
                    "fromTimestamp": int(lo.timestamp() * 1000),
                    "toTimestamp": int(cursor.timestamp() * 1000),
                },
                expect=GET_TRENDBARS_RES,
            )
            page = [_decode_trendbar(tb) for tb in reply.get("trendbar") or []]
            page = [b for b in page if b is not None]
            for b in page:
                bars[b["timestamp"]] = b
            earliest = min((b["timestamp"] for b in page), default=None)
            if earliest is not None and earliest > lo.timestamp() + step:
                # Answered short: continue from the first bar it returned.
                next_cursor = datetime.fromtimestamp(earliest, tz=UTC)
                cursor = next_cursor if next_cursor < cursor else lo
            else:
                cursor = lo
        return bars

    def _with_indicators(
        self, rows: List[Dict[str, Any]], indicators: Optional[List[str]]
    ) -> List[CandlestickBar]:
        if not rows:
            return []
        if not indicators:
            return [CandlestickBar(**r) for r in rows]
        df = pd.DataFrame(rows)
        enriched = indicator_calculator.calculate_indicators(df, indicators)
        allowed = set(CandlestickBar.model_fields.keys())
        out: List[CandlestickBar] = []
        for record in enriched.to_dict(orient="records"):
            clean = {
                k: (None if (isinstance(v, float) and pd.isna(v)) else v)
                for k, v in record.items()
                if k in allowed
            }
            out.append(CandlestickBar(**clean))
        return out

    def _spot(self, session: _Session, symbol_id: int) -> tuple[Optional[float], Optional[float]]:
        """The current bid and ask: cTrader has no quote snapshot, so this
        subscribes and reads spot events until both sides have been seen."""
        session.request(SUBSCRIBE_SPOTS_REQ, {"symbolId": [symbol_id]}, expect=SUBSCRIBE_SPOTS_RES)
        bid = ask = None
        deadline = time.monotonic() + min(self._timeout, 5.0)
        while (bid is None or ask is None) and time.monotonic() < deadline:
            msg = session.receive(deadline - time.monotonic())
            if not msg or _int(msg.get("payloadType")) != SPOT_EVENT:
                continue
            spot = msg.get("payload") or {}
            if _int(spot.get("symbolId")) != symbol_id:
                continue
            if spot.get("bid") is not None:
                bid = _int(spot["bid"]) / _PRICE_SCALE
            if spot.get("ask") is not None:
                ask = _int(spot["ask"]) / _PRICE_SCALE
        return bid, ask

    def realtime_quote(self, symbol: str, account_mode: str = "paper") -> RealTimeQuote:
        with self._session() as session:
            symbol_id = _int(self._resolve(session, symbol).get("symbolId"))
            bid, ask = self._spot(session, symbol_id)
        if bid is None and ask is None:
            raise HTTPException(503, f"cTrader sent no price for {symbol} (market closed?)")
        last = (bid + ask) / 2 if bid is not None and ask is not None else (bid or ask)
        return RealTimeQuote(
            symbol=symbol.upper(),
            bid=bid,
            ask=ask,
            last=last,
            volume=None,
            timestamp=datetime.now(UTC).isoformat(),
        )

    def stream_prices(
        self,
        symbols: List[str],
        on_price: Callable[[str, Optional[float], Optional[float]], None],
        should_stop: Callable[[], bool],
        on_bar: Optional[Callable[[str, Dict[str, Any]], None]] = None,
    ) -> None:
        """Stream bid/ask for ``symbols``. A spot event carries only the side
        that changed, so the last value of each side is kept and both are
        passed on. Blocks until ``should_stop()``; raises when the connection
        fails, and the caller retries.

        With ``on_bar``, cTrader's own 1-minute bars are subscribed to as
        well: the bar being built rides on each spot event, and each one is
        passed on once, when its minute has ended. A symbol whose bars cannot
        be subscribed to still streams prices."""
        if not symbols:
            return
        with self._session() as session:
            by_id: Dict[int, str] = {}
            for s in symbols:
                by_id[_int(self._resolve(session, s).get("symbolId"))] = s
            session.request(
                SUBSCRIBE_SPOTS_REQ, {"symbolId": sorted(by_id)}, expect=SUBSCRIBE_SPOTS_RES
            )
            bars = _LiveBars(on_bar) if on_bar is not None else None
            # Asked for without waiting for the answers, which are read in
            # the loop below: waiting here would drop the first spot events,
            # and the first one is the only one sure to carry both sides.
            asked: Dict[str, str] = {}
            if bars is not None:
                for symbol_id in sorted(by_id):
                    msg_id = session.send(
                        SUBSCRIBE_LIVE_TRENDBAR_REQ,
                        {
                            "ctidTraderAccountId": session.account_id,
                            "symbolId": symbol_id,
                            "period": _PERIOD["M1"],
                        },
                    )
                    asked[msg_id] = by_id[symbol_id]
            last: Dict[int, List[Optional[float]]] = {i: [None, None] for i in by_id}
            beat = time.monotonic()
            while not should_stop():
                if time.monotonic() - beat >= _HEARTBEAT_SECONDS:
                    session.heartbeat()
                    beat = time.monotonic()
                msg = session.receive(1.0)
                if bars is not None:
                    bars.close_finished(time.time())
                if msg and msg.get("clientMsgId") in asked:
                    symbol = asked.pop(msg["clientMsgId"])
                    if _int(msg.get("payloadType")) != SUBSCRIBE_LIVE_TRENDBAR_RES:
                        # Prices matter more: the recorder builds this
                        # symbol's bars from them instead.
                        reply = msg.get("payload") if isinstance(msg.get("payload"), dict) else {}
                        logger.warning(
                            "ctrader_live_bars_unavailable",
                            symbol=symbol,
                            error=str(reply.get("description") or reply.get("errorCode") or ""),
                        )
                    continue
                if not msg or _int(msg.get("payloadType")) != SPOT_EVENT:
                    continue
                spot = msg.get("payload") or {}
                symbol_id = _int(spot.get("symbolId"))
                if symbol_id not in by_id:
                    continue
                sides = last[symbol_id]
                if spot.get("bid") is not None:
                    sides[0] = _int(spot["bid"]) / _PRICE_SCALE
                if spot.get("ask") is not None:
                    sides[1] = _int(spot["ask"]) / _PRICE_SCALE
                if bars is not None:
                    bars.update(by_id[symbol_id], spot.get("trendbar"), sides[0])
                if spot.get("bid") is None and spot.get("ask") is None:
                    continue  # a bar update with no price change
                on_price(by_id[symbol_id], sides[0], sides[1])

    def tick_history(
        self, symbol: str, start: datetime, end: datetime, limit: int = 5000
    ) -> Dict[str, Any]:
        """The quotes between ``start`` and ``end``, oldest first: at most the
        ``limit`` most recent of them. cTrader keeps bid ticks and ask ticks
        apart, so both are read and merged: each quote carries the side that
        changed and the other side's last known price. ``complete`` is false
        when earlier quotes in the window were left out."""
        limit = max(1, int(limit))
        with self._session() as session:
            symbol_id = _int(self._resolve(session, symbol).get("symbolId"))
            sides = {
                side: self._ticks(session, symbol_id, side, start, end, limit)
                for side in ("bid", "ask")
            }
        # Where one side stops short, the merged series can start no earlier.
        floor = max(
            (ticks[0][0] for ticks, whole in sides.values() if not whole and ticks),
            default=0,
        )
        events = sorted(
            (ts, side, price) for side, (ticks, _) in sides.items() for ts, price in ticks
        )
        quotes: List[Dict[str, Any]] = []
        last: Dict[str, Optional[float]] = {"bid": None, "ask": None}
        for ts, side, price in events:
            last[side] = price
            if ts < floor:
                continue
            if quotes and quotes[-1]["time"] == ts:
                quotes[-1][side] = price
            else:
                quotes.append({"time": ts, "bid": last["bid"], "ask": last["ask"], "last": None})
        complete = all(whole for _, whole in sides.values()) and len(quotes) <= limit
        quotes = quotes[-limit:]
        return {
            "symbol": symbol.upper(),
            "broker": "ctrader",
            "ticks": quotes,
            "count": len(quotes),
            "complete": complete,
        }

    def _ticks(
        self,
        session: _Session,
        symbol_id: int,
        side: str,
        start: datetime,
        end: datetime,
        limit: int,
    ) -> tuple:
        """One side's ticks as ``(ms, price)``, oldest first, and whether the
        walk reached ``start``. Walks back from ``end`` and stops once it
        holds ``limit`` ticks."""
        lo_ms, cursor = int(start.timestamp() * 1000), int(end.timestamp() * 1000)
        window_ms = int(_TICK_WINDOW.total_seconds() * 1000)
        ticks: Dict[int, float] = {}
        for i in range(_TICK_MAX_REQUESTS):
            if cursor <= lo_ms:
                return sorted(ticks.items()), True
            if len(ticks) >= limit:
                break
            if i:
                time.sleep(_HISTORY_PAUSE_SECONDS)
            page_lo = max(lo_ms, cursor - window_ms)
            reply = session.request(
                GET_TICKDATA_REQ,
                {
                    "symbolId": symbol_id,
                    "type": _QUOTE_TYPE[side],
                    "fromTimestamp": page_lo,
                    "toTimestamp": cursor,
                },
                expect=GET_TICKDATA_RES,
            )
            page = _decode_ticks(reply.get("tickData"))
            for ts, price in page:
                ticks[ts] = price
            earliest = min((ts for ts, _ in page), default=None)
            if reply.get("hasMore") and earliest is not None and earliest < cursor:
                # More in this window: continue from the oldest tick it sent.
                cursor = earliest
            else:
                cursor = page_lo
        return sorted(ticks.items()), cursor <= lo_ms

    def market_depth(self, symbol: str, levels: int = 10) -> Dict[str, Any]:
        """The order book for ``symbol``: the best ``levels`` prices on each
        side with the size offered at each, in units. cTrader has no book
        snapshot, so this subscribes and reads depth events until the book
        stops changing."""
        levels = max(1, min(int(levels), _DEPTH_MAX_LEVELS))
        with self._session() as session:
            symbol_id = _int(self._resolve(session, symbol).get("symbolId"))
            # Depth is only sent for a symbol whose spots are subscribed.
            session.request(
                SUBSCRIBE_SPOTS_REQ, {"symbolId": [symbol_id]}, expect=SUBSCRIBE_SPOTS_RES
            )
            # Not waited for: the book may arrive before the answer does.
            asked = session.send(
                SUBSCRIBE_DEPTH_REQ,
                {"ctidTraderAccountId": session.account_id, "symbolId": [symbol_id]},
            )
            book: Dict[int, tuple[str, int, int]] = {}
            deadline = time.monotonic() + min(self._timeout, _DEPTH_WAIT_SECONDS)
            while time.monotonic() < deadline:
                msg = session.receive(deadline - time.monotonic())
                if not msg:
                    continue
                kind = _int(msg.get("payloadType"))
                if msg.get("clientMsgId") == asked and kind != SUBSCRIBE_DEPTH_RES:
                    raise _venue_error(
                        msg.get("payload") if isinstance(msg.get("payload"), dict) else {}
                    )
                if kind != DEPTH_EVENT:
                    continue
                event = msg.get("payload") or {}
                if _int(event.get("symbolId")) != symbol_id:
                    continue
                for quote in event.get("newQuotes") or []:
                    side = "bid" if quote.get("bid") is not None else "ask"
                    if quote.get(side) is None:
                        continue
                    book[_int(quote.get("id"))] = (
                        side,
                        _int(quote[side]),
                        _int(quote.get("size")),
                    )
                for quote_id in event.get("deletedQuotes") or []:
                    book.pop(_int(quote_id), None)
                # The first event carries the whole book; later ones change it.
                deadline = min(deadline, time.monotonic() + _DEPTH_SETTLE_SECONDS)
        if not book:
            raise HTTPException(
                503,
                f"cTrader sent no depth of market for {symbol} "
                "(market closed, or this broker does not publish it)",
            )
        return {
            "symbol": symbol.upper(),
            "broker": "ctrader",
            "timestamp": datetime.now(UTC).isoformat(),
            "bids": _depth_side(book, "bid", levels),
            "asks": _depth_side(book, "ask", levels),
        }

    def tick(self, symbol: str, account_mode: str = "paper") -> Dict[str, Any]:
        quote = self.realtime_quote(symbol, account_mode)
        return {
            "symbol": quote.symbol,
            "timestamp": quote.timestamp,
            "bid": quote.bid,
            "ask": quote.ask,
            "last": quote.last,
            "volume": quote.volume,
            "broker": "ctrader",
        }

    # -- BrokerAdapter (execution) ------------------------------------------ #
    def place_order(self, request: Any) -> Dict[str, Any]:
        """Place an order, after the validation and live gate every venue
        runs. The quantity is in units."""
        from orders import _validate_common

        _validate_common(request.action, request.order_type, request.tif, request.account_mode)
        order_type = _APP_TO_ORDER_TYPE.get(request.order_type)
        if order_type is None:
            raise HTTPException(400, f"order_type '{request.order_type}' is not supported")
        stop_loss = getattr(request, "stop_loss", None)
        take_profit = getattr(request, "take_profit", None)
        client_id = client_order_id(getattr(request, "audit_id", None))

        with self._session() as session:
            symbol_id = _int(self._resolve(session, request.symbol).get("symbolId"))
            digits = _int(self._detail(session, symbol_id).get("digits"), 5)
            body: Dict[str, Any] = {
                "symbolId": symbol_id,
                "orderType": order_type,
                "tradeSide": _TRADE_SIDE[request.action],
                "volume": _volume(request.quantity),
                "label": "tradingapp",
            }
            if client_id:
                body["clientOrderId"] = client_id
                body["comment"] = client_id
            body.update(_order_tif(request.order_type, request.tif))
            body.update(_order_prices(request, digits))

            if order_type == _ORDER_TYPE["MARKET"]:
                if stop_loss is not None or take_profit is not None:
                    # A market order takes its protection only as distances
                    # (in 1/100000 of the price) from the price it fills at.
                    bid, ask = self._spot(session, symbol_id)
                    reference = ask if request.action == "BUY" else bid
                    if reference is None:
                        raise HTTPException(
                            503, f"no price for {request.symbol} to place the stop from"
                        )
                    if stop_loss is not None:
                        body["relativeStopLoss"] = _relative(reference, stop_loss, digits)
                    if take_profit is not None:
                        body["relativeTakeProfit"] = _relative(reference, take_profit, digits)
            else:
                if stop_loss is not None:
                    body["stopLoss"] = round(float(stop_loss), digits)
                if take_profit is not None:
                    body["takeProfit"] = round(float(take_profit), digits)

            if stop_loss is not None and getattr(request, "trailing_stop", False):
                # cTrader then moves the stop behind the price itself.
                body["trailingStopLoss"] = True

            filled = _EXECUTION_TYPE["ORDER_FILLED"]
            accepted = _EXECUTION_TYPE["ORDER_ACCEPTED"]
            market = order_type == _ORDER_TYPE["MARKET"]
            event = session.executions(
                NEW_ORDER_REQ,
                body,
                done=(
                    (lambda kind: kind == filled)
                    if market
                    else (lambda kind: kind in (accepted, filled))
                ),
            )

        if not event:
            raise HTTPException(503, "cTrader did not confirm the order in time; check open orders")
        kind = _enum(event.get("executionType"), _EXECUTION_TYPE)
        order = event.get("order") if isinstance(event.get("order"), dict) else {}
        position = event.get("position") if isinstance(event.get("position"), dict) else {}
        is_filled = kind in (filled, _EXECUTION_TYPE["ORDER_PARTIAL_FILL"])
        protection = position if is_filled and position else order
        return {
            "order_id": str(order.get("orderId") or ""),
            "symbol": request.symbol.upper(),
            "action": request.action,
            "quantity": request.quantity,
            "order_type": request.order_type,
            "tif": request.tif,
            "account_mode": request.account_mode,
            "broker": "ctrader",
            "status": "filled" if kind == filled else "submitted",
            "sl": _opt_float(protection.get("stopLoss")),
            "tp": _opt_float(protection.get("takeProfit")),
        }

    def modify_position_stop(
        self,
        symbol: str,
        *,
        stop_loss: Optional[float] = None,
        take_profit: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Move the stop on each position (a hedged account may hold several)
        on the net side. A tighter stop already in place is kept."""
        with self._session() as session:
            symbol_id = _int(self._resolve(session, symbol).get("symbolId"))
            digits = _int(self._detail(session, symbol_id).get("digits"), 5)
            reconcile = session.request(RECONCILE_REQ, {}, expect=RECONCILE_RES)
            held = [p for p in _positions(reconcile) if p["symbol_id"] == symbol_id]
            if not held:
                raise HTTPException(404, f"no open cTrader positions for {symbol}")
            long_side = sum(p["signed_units"] for p in held) > 0
            direction = "long" if long_side else "short"
            held = [p for p in held if (p["signed_units"] > 0) == long_side]

            stops: List[Optional[float]] = []
            targets: List[Optional[float]] = []
            for p in held:
                new_stop = p["stop_loss"]
                if stop_loss is not None and is_more_protective(stop_loss, new_stop, direction):
                    new_stop = round(float(stop_loss), digits)
                new_target = (
                    round(float(take_profit), digits)
                    if take_profit is not None
                    else p["take_profit"]
                )
                if new_stop == p["stop_loss"] and new_target == p["take_profit"]:
                    stops.append(p["stop_loss"])
                    targets.append(p["take_profit"])
                    continue
                # An amend replaces both levels, so the unchanged one is resent.
                body: Dict[str, Any] = {"positionId": p["position_id"]}
                if new_stop is not None:
                    body["stopLoss"] = new_stop
                if new_target is not None:
                    body["takeProfit"] = new_target
                event = session.executions(AMEND_POSITION_SLTP_REQ, body, done=lambda kind: True)
                position = event.get("position") if isinstance(event.get("position"), dict) else {}
                stops.append(_opt_float(position.get("stopLoss")))
                targets.append(_opt_float(position.get("takeProfit")))
        return {
            "symbol": symbol.upper(),
            "broker": "ctrader",
            "status": "modified",
            "sl": _least_protective(stops, long_side),
            "tp": _first_to_hit(targets, long_side),
        }

    def cancel_order(self, order_id: Any) -> Dict[str, Any]:
        with self._session() as session:
            session.executions(
                CANCEL_ORDER_REQ,
                {"orderId": _int(order_id)},
                done=lambda kind: kind == _EXECUTION_TYPE["ORDER_CANCELLED"],
            )
        return {"order_id": order_id, "broker": "ctrader", "status": "cancel_requested"}

    def modify_order(self, order_id: Any, request: Any) -> Dict[str, Any]:
        from orders import _validate_common

        tif = request.tif or "GTC"
        _validate_common(request.action, request.order_type, tif, request.account_mode)
        with self._session() as session:
            symbol_id = _int(self._resolve(session, request.symbol).get("symbolId"))
            digits = _int(self._detail(session, symbol_id).get("digits"), 5)
            body: Dict[str, Any] = {"orderId": _int(order_id)}
            if request.quantity:
                body["volume"] = _volume(request.quantity)
            body.update(_order_prices(request, digits, required=False))
            session.executions(
                AMEND_ORDER_REQ,
                body,
                done=lambda kind: kind == _EXECUTION_TYPE["ORDER_REPLACED"],
            )
        return {"order_id": order_id, "broker": "ctrader", "status": "modify_requested"}

    def _account_state(self, session: _Session) -> Dict[str, Any]:
        trader = session.request(TRADER_REQ, {}, expect=TRADER_RES).get("trader") or {}
        reconcile = session.request(RECONCILE_REQ, {}, expect=RECONCILE_RES)
        pnl = session.request(UNREALIZED_PNL_REQ, {}, expect=UNREALIZED_PNL_RES)
        pnl_scale = 10 ** _int(pnl.get("moneyDigits"), 2)
        unrealized = {
            _int(row.get("positionId")): _int(row.get("netUnrealizedPnL")) / pnl_scale
            for row in pnl.get("positionUnrealizedPnL") or []
            if isinstance(row, dict)
        }
        currency = self._asset_names(session).get(_int(trader.get("depositAssetId")), "USD")
        return {
            "trader": trader,
            "positions": _positions(reconcile),
            "orders": reconcile.get("order") or [],
            "unrealized": unrealized,
            "currency": currency or "USD",
        }

    def positions(self) -> List[Dict[str, Any]]:
        """Positions netted per symbol (a hedged account can hold both sides),
        in the app's ``models.Position`` shape, sizes in units."""
        with self._session() as session:
            state = self._account_state(session)
            names = {
                p["symbol_id"]: self._name_of(session, p["symbol_id"]) for p in state["positions"]
            }
        by_symbol: Dict[int, List[Dict[str, Any]]] = {}
        for p in state["positions"]:
            by_symbol.setdefault(p["symbol_id"], []).append(p)
        out: List[Dict[str, Any]] = []
        for symbol_id, held in by_symbol.items():
            size = sum(p["signed_units"] for p in held)
            if size == 0:
                continue
            legs = [p for p in held if (p["signed_units"] > 0) == (size > 0)]
            weight = sum(abs(p["signed_units"]) for p in legs)
            priced = [p for p in legs if p["price"] is not None]
            average = (
                sum(abs(p["signed_units"]) * p["price"] for p in priced) / weight
                if priced and weight
                else None
            )
            out.append(
                {
                    "symbol": names.get(symbol_id, str(symbol_id)),
                    "position": size,
                    "market_price": None,
                    "market_value": None,
                    "average_cost": average,
                    "unrealized_pnl": sum(
                        state["unrealized"].get(p["position_id"], 0.0) for p in held
                    ),
                    "stop_loss": _least_protective([p["stop_loss"] for p in legs], size > 0),
                    "take_profit": _first_to_hit([p["take_profit"] for p in legs], size > 0),
                    "currency": state["currency"],
                }
            )
        return out

    def account_summary(self) -> Dict[str, Any]:
        """Balance from the trader record; equity adds the open positions'
        net unrealised P&L (cTrader reports no equity figure itself)."""
        with self._session() as session:
            state = self._account_state(session)
        trader = state["trader"]
        scale = 10 ** _int(trader.get("moneyDigits"), 2)
        balance = _int(trader.get("balance")) / scale
        equity = balance + sum(state["unrealized"].values())
        margin = sum(p["used_margin"] for p in state["positions"]) / scale
        return {
            "account_id": str(trader.get("traderLogin") or self._account_id),
            "net_liquidation": equity,
            "currency": state["currency"],
            "last_updated": datetime.now(UTC).isoformat(),
            "total_cash_value": balance,
            "buying_power": equity - margin,
            "maintenance_margin": margin,
        }

    def open_orders(self) -> List[Dict[str, Any]]:
        with self._session() as session:
            reconcile = session.request(RECONCILE_REQ, {}, expect=RECONCILE_RES)
            rows = [o for o in reconcile.get("order") or [] if isinstance(o, dict)]
            names = {_int((o.get("tradeData") or {}).get("symbolId")): None for o in rows}
            names = {i: self._name_of(session, i) for i in names}
        orders: List[Dict[str, Any]] = []
        for o in rows:
            kind = _enum(o.get("orderType"), _ORDER_TYPE)
            # A position's own stop-loss/take-profit orders are not working orders.
            if kind == _ORDER_TYPE["STOP_LOSS_TAKE_PROFIT"] or o.get("closingOrder"):
                continue
            trade = o.get("tradeData") or {}
            units = _int(trade.get("volume")) / _VOLUME_SCALE
            executed = _int(o.get("executedVolume")) / _VOLUME_SCALE
            orders.append(
                {
                    "order_id": str(o.get("orderId") or ""),
                    "symbol": names.get(_int(trade.get("symbolId")), ""),
                    "action": "SELL" if _enum(trade.get("tradeSide"), _TRADE_SIDE) == 2 else "BUY",
                    "quantity": units,
                    "order_type": _ORDER_TYPE_TO_APP.get(kind or 0, "LMT"),
                    "status": "WORKING",
                    "filled_quantity": executed or None,
                    "remaining_quantity": units - executed,
                    "avg_fill_price": _opt_float(o.get("executionPrice")),
                    # A limit order waits at its limit; a stop or stop-limit
                    # order at its trigger.
                    "price": _opt_float(
                        o.get("limitPrice") if kind == _ORDER_TYPE["LIMIT"] else o.get("stopPrice")
                    ),
                }
            )
        return orders

    def instrument_spec(self, symbol: str) -> Dict[str, Any]:
        """Sizes are in units: cTrader's volumes are hundredths of a unit, so
        each limit is divided by 100, and one unit is one of the underlying."""
        with self._session() as session:
            light = self._resolve(session, symbol)
            detail = self._detail(session, _int(light.get("symbolId")))
            currency = self._asset_names(session).get(_int(light.get("quoteAssetId")), "")
        step = _int(detail.get("stepVolume"), _VOLUME_SCALE) / _VOLUME_SCALE
        minimum = _int(detail.get("minVolume"), 0) / _VOLUME_SCALE
        maximum = _int(detail.get("maxVolume"), 0) / _VOLUME_SCALE
        return {
            "symbol": _from_name(str(light.get("symbolName"))),
            "broker": "ctrader",
            "unit": "units",
            "min_size": minimum if minimum > 0 else step,
            "size_step": step,
            "max_size": maximum or None,
            "contract_size": 1.0,
            "currency": currency or "USD",
        }

    def executions(self, days: int = 1) -> List[Dict[str, Any]]:
        """Filled deals in ``models.Execution`` shape. Commission is reported
        as a positive cost; a closing deal carries its gross realised P&L."""
        now = datetime.now(UTC)
        start = now - timedelta(days=max(1, days))
        with self._session() as session:
            reply = session.request(
                DEAL_LIST_REQ,
                {
                    "fromTimestamp": int(start.timestamp() * 1000),
                    "toTimestamp": int(now.timestamp() * 1000),
                    "maxRows": 1000,
                },
                expect=DEAL_LIST_RES,
            )
            deals = [d for d in reply.get("deal") or [] if isinstance(d, dict)]
            names = {i: self._name_of(session, i) for i in {_int(d.get("symbolId")) for d in deals}}
            currency = None
            if deals:
                trader = session.request(TRADER_REQ, {}, expect=TRADER_RES).get("trader") or {}
                currency = self._asset_names(session).get(_int(trader.get("depositAssetId")))
        fills: List[Dict[str, Any]] = []
        for d in deals:
            if _enum(d.get("dealStatus"), _DEAL_STATUS) not in _DEAL_STATUS.values():
                continue
            units = _int(d.get("filledVolume")) / _VOLUME_SCALE
            price = _opt_float(d.get("executionPrice"))
            if not units or price is None:
                continue
            scale = 10 ** _int(d.get("moneyDigits"), 2)
            close = (
                d.get("closePositionDetail")
                if isinstance(d.get("closePositionDetail"), dict)
                else None
            )
            executed = _int(d.get("executionTimestamp"))
            fills.append(
                {
                    "exec_id": str(d.get("dealId")),
                    "order_id": str(d.get("orderId")) if d.get("orderId") is not None else None,
                    "audit_id": None,
                    "symbol": names.get(_int(d.get("symbolId")), ""),
                    "side": "SELL" if _enum(d.get("tradeSide"), _TRADE_SIDE) == 2 else "BUY",
                    "quantity": units,
                    "price": price,
                    "commission": abs(_int(d.get("commission"))) / scale,
                    "realized_pnl": (_int(close.get("grossProfit")) / scale) if close else None,
                    "executed_at": (
                        datetime.fromtimestamp(executed / 1000, tz=UTC).isoformat()
                        if executed
                        else now.isoformat()
                    ),
                    "account": str(self._account_id),
                    "currency": currency or "USD",
                    "broker": "ctrader",
                }
            )
        return fills


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _decode_trendbar(tb: Any) -> Optional[Dict[str, Any]]:
    """A ProtoOATrendbar: prices are the low plus per-field deltas, all in
    1/100000; the time is minutes since the epoch."""
    if not isinstance(tb, dict) or tb.get("utcTimestampInMinutes") is None:
        return None
    low = _int(tb.get("low"))
    return {
        "timestamp": float(_int(tb["utcTimestampInMinutes"]) * 60),
        "open": (low + _int(tb.get("deltaOpen"))) / _PRICE_SCALE,
        "high": (low + _int(tb.get("deltaHigh"))) / _PRICE_SCALE,
        "low": low / _PRICE_SCALE,
        "close": (low + _int(tb.get("deltaClose"))) / _PRICE_SCALE,
        "volume": _int(tb.get("volume")),
    }


def _decode_live_trendbar(tb: Any, bid: Optional[float]) -> Optional[Dict[str, Any]]:
    """The bar being built, from a spot event. Its close may be left out,
    since it is the bid the same event carries: ``bid`` then, else the open."""
    bar = _decode_trendbar(tb)
    if bar is None or tb.get("low") is None:
        return None
    if tb.get("deltaClose") is None:
        bar["close"] = bid if bid is not None else bar["open"]
    bar["high"] = max(bar["high"], bar["open"], bar["close"])
    bar["low"] = min(bar["low"], bar["open"], bar["close"])
    return bar


class _LiveBars:
    """The 1-minute bar cTrader is building for each symbol. ``emit`` is
    called once per bar, when a later bar starts or its minute has been over
    for ``_BAR_GRACE_SECONDS``."""

    def __init__(self, emit: Callable[[str, Dict[str, Any]], None]) -> None:
        self._emit = emit
        self._forming: Dict[str, Dict[str, Any]] = {}

    def update(self, symbol: str, trendbars: Any, bid: Optional[float]) -> None:
        for tb in trendbars if isinstance(trendbars, list) else []:
            if not isinstance(tb, dict) or _enum(tb.get("period"), _PERIOD) not in (
                None,
                _PERIOD["M1"],
            ):
                continue
            bar = _decode_live_trendbar(tb, bid)
            if bar is None:
                continue
            current = self._forming.get(symbol)
            if current is not None and bar["timestamp"] < current["timestamp"]:
                continue
            if current is not None and bar["timestamp"] > current["timestamp"]:
                self._emit(symbol, current)
            self._forming[symbol] = bar

    def close_finished(self, now: float) -> None:
        for symbol, bar in list(self._forming.items()):
            if now >= bar["timestamp"] + _PERIOD_SECONDS["M1"] + _BAR_GRACE_SECONDS:
                del self._forming[symbol]
                self._emit(symbol, bar)


def _depth_side(
    book: Dict[int, tuple[str, int, int]], side: str, levels: int
) -> List[Dict[str, float]]:
    """One side of the book, best price first, quotes at one price added up."""
    sizes: Dict[int, int] = {}
    for quote_side, price, size in book.values():
        if quote_side == side:
            sizes[price] = sizes.get(price, 0) + size
    ordered = sorted(sizes.items(), reverse=side == "bid")[:levels]
    return [
        {"price": price / _PRICE_SCALE, "size": size / _VOLUME_SCALE} for price, size in ordered
    ]


def _positions(reconcile: Dict[str, Any]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for p in reconcile.get("position") or []:
        if not isinstance(p, dict):
            continue
        trade = p.get("tradeData") or {}
        units = _int(trade.get("volume")) / _VOLUME_SCALE
        if not units:
            continue
        sign = -1.0 if _enum(trade.get("tradeSide"), _TRADE_SIDE) == 2 else 1.0
        out.append(
            {
                "position_id": _int(p.get("positionId")),
                "symbol_id": _int(trade.get("symbolId")),
                "signed_units": sign * units,
                "price": _opt_float(p.get("price")),
                "stop_loss": _opt_float(p.get("stopLoss")),
                "take_profit": _opt_float(p.get("takeProfit")),
                "used_margin": _int(p.get("usedMargin")),
            }
        )
    return out


def _volume(quantity: float) -> int:
    return int(round(float(quantity) * _VOLUME_SCALE))


def _decode_ticks(rows: Any) -> List[tuple]:
    """``ProtoOATickData`` rows as ``(ms, price)``. The first row is whole;
    each later one holds the difference from the row before it, in both the
    time and the price (in 1/100000)."""
    out: List[tuple] = []
    ts = price = 0
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        ts += _int(row.get("timestamp"))
        price += _int(row.get("tick"))
        out.append((ts, price / 100000.0))
    return out


def _relative(reference: float, level: float, digits: int) -> int:
    """The distance from ``reference`` to ``level`` in 1/100000 of the price,
    on the symbol's own price grid."""
    unit = 10 ** max(0, 5 - digits)
    distance = abs(float(reference) - float(level)) * _PRICE_SCALE
    return max(unit, int(round(distance / unit)) * unit)


def _order_tif(order_type: str, tif: str) -> Dict[str, Any]:
    """A market order is immediate either way; FOK is the only choice worth
    sending. A resting order maps the full set, DAY being good till the end
    of today, UTC."""
    if order_type == "MKT":
        return {"timeInForce": _TIF["FILL_OR_KILL"]} if tif == "FOK" else {}
    if tif == "DAY":
        end = datetime.now(UTC).replace(hour=23, minute=59, second=59, microsecond=0)
        return {
            "timeInForce": _TIF["GOOD_TILL_DATE"],
            "expirationTimestamp": int(end.timestamp() * 1000),
        }
    return {
        "timeInForce": {
            "GTC": _TIF["GOOD_TILL_CANCEL"],
            "IOC": _TIF["IMMEDIATE_OR_CANCEL"],
            "FOK": _TIF["FILL_OR_KILL"],
        }[tif]
    }


def _order_prices(request: Any, digits: int, *, required: bool = True) -> Dict[str, Any]:
    """``limitPrice`` / ``stopPrice`` for a resting order. A stop-limit is a
    stop price plus how far past it the fill may go, in points."""
    kind = request.order_type
    fields: Dict[str, Any] = {}
    if kind == "LMT":
        if request.limit_price is not None:
            fields["limitPrice"] = round(float(request.limit_price), digits)
        elif required:
            raise HTTPException(400, "a limit_price is required for order_type=LMT")
    elif kind in ("STP", "STP_LMT"):
        if request.stop_price is not None:
            fields["stopPrice"] = round(float(request.stop_price), digits)
        elif required:
            raise HTTPException(400, f"a stop_price is required for order_type={kind}")
        if kind == "STP_LMT":
            if request.limit_price is not None and request.stop_price is not None:
                points = abs(float(request.limit_price) - float(request.stop_price)) * 10**digits
                fields["slippageInPoints"] = int(round(points))
            elif required:
                raise HTTPException(400, "a limit_price is required for order_type=STP_LMT")
    return fields


def _least_protective(stops: List[Optional[float]], long_side: bool) -> Optional[float]:
    if not stops or any(s is None for s in stops):
        return None
    values = [s for s in stops if s is not None]
    return min(values) if long_side else max(values)


def _first_to_hit(targets: List[Optional[float]], long_side: bool) -> Optional[float]:
    if not targets or any(t is None for t in targets):
        return None
    values = [t for t in targets if t is not None]
    return min(values) if long_side else max(values)
