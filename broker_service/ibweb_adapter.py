"""IBKR Web API adapter — market data + execution through the Client Portal
Gateway, Interactive Brokers' REST interface for individual accounts.

The existing ``ib`` platform speaks the TWS socket API to an IB Gateway (or
TWS) process. This platform, ``ibweb``, speaks the IBKR Web API instead: plain
HTTPS + JSON, the same shape as the OANDA and IG adapters. For an individual
account IBKR offers the Web API only through the **Client Portal Gateway**
(CPGW), a small Java program that holds the brokerage session after a
browser sign-in (with two-factor authentication). OAuth is reserved for
institutional and third-party developer accounts, so the gateway is the one
path open to a retail account at Interactive Brokers Australia.

What this platform adds over ``ib``:

  - several connections at once (the TWS client is a single process-wide
    socket, so only one ``ib`` connection is allowed);
  - any market the account can trade, addressed by IBKR contract id (conid),
    with ``AAPL``, ``BHP:ASX`` and ``AUD.USD`` resolved for you;
  - a bracket (stop and target) attached to the entry, so ``attaches_stops``;
  - no client ids, no socket, no IB Gateway GUI host.

### Web API contract used here

    Base: the gateway's URL, e.g. https://ibkr-gateway:5000  (+ /v1/api)

      POST /tickle                          keep the session alive
      POST /iserver/auth/status             authenticated / competing / connected
      GET  /iserver/accounts                must precede /iserver order calls
      GET  /portfolio/accounts              must precede /portfolio calls
      GET  /iserver/secdef/search           search by symbol or name
      GET  /trsrv/stocks?symbols=           stock symbol -> conids by exchange
      GET  /iserver/currency/pairs          FX pair -> conid
      GET  /iserver/contract/{conid}/info   currency, type, multiplier
      GET  /iserver/marketdata/history      bars (o/h/l/c/v, t in ms)
      GET  /iserver/marketdata/snapshot     quote fields 31/84/86/87
      POST /iserver/account/{acct}/orders   place (a bracket is one call)
      POST /iserver/reply/{id}              confirm a precautionary prompt
      POST /iserver/account/{acct}/order/{id}   modify
      DELETE /iserver/account/{acct}/order/{id} cancel
      GET  /iserver/account/orders          working orders
      GET  /iserver/account/trades?days=    fills, up to 7 days
      GET  /portfolio/{acct}/positions/{page}
      GET  /portfolio/{acct}/summary

Mapping notes the rest of the codebase does not need to know about:

  - **Paper or live.** A paper account's id starts with ``D`` (``DU…``), and
    the connection's mode is checked against it when the connection is
    loaded (``connections.py``) and against the accounts the gateway is
    signed in to on every probe. A gateway signed in to the live login while
    the connection says paper is refused, never traded.
  - **Prompts.** IBKR answers some orders with a precautionary question
    ("price exceeds the cap", "no market data") instead of placing them.
    Each one is confirmed, logged and returned under ``warnings``, up to
    ``_MAX_REPLIES`` rounds; the app's own risk checks have already run.
  - **Snapshots.** The first snapshot of a conid opens its market-data line
    and returns no prices, so a quote asks up to ``_SNAPSHOT_TRIES`` times.
    Price fields are text and may carry a prefix (``C`` for the prior close,
    ``H`` for halted), which is stripped.
  - **TLS.** The gateway ships a self-signed certificate, so by default it
    is not verified. Run the gateway on the app's private network (or bind it
    to loopback), never on the internet.
"""

from __future__ import annotations

import re
import threading
import time
import uuid
from datetime import UTC, datetime
from typing import Any, Dict, List, Optional

import httpx
import pandas as pd
from fastapi import HTTPException

from client_ids import audit_id_from, client_order_id
from indicators import calculator as indicator_calculator
from models import CandlestickBar, HistoricalDataResponse, RealTimeQuote
from observability import get_logger

logger = get_logger(__name__)

_HTTP_TIMEOUT_SECONDS = 30.0
_API_PREFIX = "/v1/api"
# Confirmation rounds for one order. IBKR rarely asks more than twice; a
# loop that keeps asking is a gateway problem, not something to agree to.
_MAX_REPLIES = 5
_SNAPSHOT_TRIES = 3
_SNAPSHOT_WAIT_SECONDS = 0.5
_POSITIONS_PAGE_SIZE = 100
_MAX_POSITION_PAGES = 20
_MAX_TRADE_DAYS = 7

# Snapshot fields: last, bid, ask, volume.
_FIELD_LAST, _FIELD_BID, _FIELD_ASK, _FIELD_VOLUME = "31", "84", "86", "87"
_SNAPSHOT_FIELDS = ",".join((_FIELD_LAST, _FIELD_BID, _FIELD_ASK, _FIELD_VOLUME))

# App timeframe -> Web API bar size.
_TIMEFRAME_TO_BAR = {
    "1min": "1min",
    "5min": "5min",
    "15min": "15min",
    "30min": "30min",
    "1hour": "1h",
    "4hour": "4h",
    "8hour": "8h",
    "1day": "1d",
}
# App period -> Web API period.
_PERIODS = {
    "1D": "1d",
    "5D": "5d",
    "1W": "1w",
    "1M": "1m",
    "3M": "3m",
    "6M": "6m",
    "1Y": "1y",
    "2Y": "2y",
    "5Y": "5y",
}

_ORDER_TYPES = {"MKT": "MKT", "LMT": "LMT", "STP": "STP", "STP_LMT": "STOP_LIMIT"}
_TIFS = {"DAY": "DAY", "GTC": "GTC", "IOC": "IOC"}
_CLOSED_STATUSES = {"filled", "cancelled", "inactive", "pendingcancel"}

# Currencies IBKR quotes on IDEALPRO. `EURUSD` only reads as an FX pair when
# both halves are in this set, so a six-letter stock ticker is not mistaken
# for one; with a separator (`EUR.USD`, `EUR/USD`) it always is.
_CURRENCIES = frozenset(
    "AUD CAD CHF CNH CZK DKK EUR GBP HKD HUF ILS JPY MXN NOK NZD PLN SEK SGD " "TRY USD ZAR".split()
)
_FX_SEPARATED_RE = re.compile(r"^([A-Z]{3})[./]([A-Z]{3})$")
_FX_JOINED_RE = re.compile(r"^([A-Z]{3})([A-Z]{3})$")
_PRICE_RE = re.compile(r"-?\d+(?:\.\d+)?")


def is_paper_account(account_id: str) -> bool:
    """IBKR paper (simulated) account ids start with ``D``: ``DU1234567`` for
    an individual, ``DF…`` for an advisor's master."""
    return account_id.strip().upper().startswith("D")


def _fx_pair(symbol: str) -> Optional[tuple[str, str]]:
    text = symbol.strip().upper()
    m = _FX_SEPARATED_RE.match(text)
    if m:
        return m.group(1), m.group(2)
    m = _FX_JOINED_RE.match(text)
    if m and m.group(1) in _CURRENCIES and m.group(2) in _CURRENCIES:
        return m.group(1), m.group(2)
    return None


def _price(value: Any) -> Optional[float]:
    """Snapshot fields are text, sometimes prefixed (``C123.45``)."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    m = _PRICE_RE.search(str(value).replace(",", ""))
    return float(m.group(0)) if m else None


def _opt_float(v: Any) -> Optional[float]:
    try:
        return float(v) if v is not None and v != "" else None
    except (TypeError, ValueError):
        return None


def _app_order_type(value: Any) -> str:
    """IBKR's order type text (``Limit``, ``STOP_LIMIT``, ``Stop Limit``,
    ``MKT``) -> the app's ``MKT`` / ``LMT`` / ``STP`` / ``STP_LMT``."""
    kind = str(value or "").upper().replace(" ", "_")
    if "STOP" in kind or kind.startswith("STP"):
        return "STP_LMT" if "LIMIT" in kind or "LMT" in kind else "STP"
    if "MARKET" in kind or kind == "MKT":
        return "MKT"
    return "LMT"


def _amount(summary: Dict[str, Any], key: str) -> Optional[float]:
    entry = summary.get(key)
    if isinstance(entry, dict):
        return _opt_float(entry.get("amount"))
    return _opt_float(entry)


class IBWebAdapter:
    """``MarketDataAdapter`` + ``BrokerAdapter`` over the IBKR Web API."""

    # The price this venue builds its own bars from; the live recorder builds
    # stream bars the same way (docs/plans/E-05-live-recorder.md, D5).
    bar_basis = "last"

    name = "ibweb"
    # A bracket (stop and target) is placed with the entry in one call.
    attaches_stops = True
    # What the connection reports it supports (capabilities.py).
    timeframes = tuple(_TIMEFRAME_TO_BAR)
    order_tifs = {kind: tuple(_TIFS) for kind in _ORDER_TYPES}

    def __init__(
        self,
        url: str,
        account_id: str,
        *,
        verify_tls: bool = False,
        currency: str = "USD",
        timeout: float = _HTTP_TIMEOUT_SECONDS,
    ) -> None:
        base = (url or "").rstrip("/")
        if base.endswith(_API_PREFIX):
            base = base[: -len(_API_PREFIX)]
        self._base = f"{base}{_API_PREFIX}"
        self._account_id = (account_id or "").strip().upper()
        self._verify = verify_tls
        self._currency = currency or "USD"
        self._timeout = timeout
        self._session_ready = False
        self._session_lock = threading.Lock()
        self._conids: Dict[str, int] = {}
        self._info: Dict[int, Dict[str, Any]] = {}
        self._symbols: Dict[int, str] = {}

    # -- HTTP plumbing ----------------------------------------------------- #
    def _send(
        self,
        method: str,
        path: str,
        params: Optional[Dict[str, Any]] = None,
        json: Any = None,
    ) -> Any:
        url = f"{self._base}{path}"
        try:
            with httpx.Client(timeout=self._timeout, verify=self._verify) as client:
                return client.request(
                    method,
                    url,
                    params={k: v for k, v in (params or {}).items() if v is not None},
                    json=json,
                    headers={"User-Agent": "tradingapp", "Accept": "application/json"},
                )
        except httpx.HTTPError as exc:
            logger.error("ibweb_unreachable", url=url, method=method, error=str(exc))
            raise HTTPException(503, f"IBKR Client Portal Gateway unreachable: {exc}")

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        json: Any = None,
        session: bool = True,
        order: bool = False,
    ) -> Any:
        """One call. With ``order``, an error IBKR states in the body (HTTP
        400 or 200 with ``{"error": ...}``) is a rejection, 422, not an outage."""
        if session:
            self._ensure_session()
        resp = self._send(method, path, params, json)
        if resp.status_code == 401:
            # Signed out (the daily reset, or another login took the session).
            self._session_ready = False
            raise HTTPException(
                503,
                "IBKR Client Portal Gateway is not signed in: open the gateway's "
                "address in a browser and log in",
            )
        if order and resp.status_code == 400:
            raise HTTPException(422, f"IBKR rejected the order: {resp.text[:300]}")
        if resp.status_code >= 400:
            raise HTTPException(502, f"IBKR error {resp.status_code} for {path}: {resp.text[:200]}")
        if not resp.content:
            return {}
        try:
            payload = resp.json()
        except ValueError as exc:
            raise HTTPException(502, f"IBKR returned non-JSON for {path}: {exc}")
        if isinstance(payload, dict) and payload.get("error"):
            if order:
                raise HTTPException(422, f"IBKR rejected the order: {payload['error']}")
            raise HTTPException(502, f"IBKR error for {path}: {payload['error']}")
        return payload

    def _ensure_session(self) -> None:
        """The Web API wants ``/iserver/accounts`` and ``/portfolio/accounts``
        read once per session before order and portfolio calls. Both are also
        where the configured account is checked against the signed-in login:
        an account the gateway does not hold is refused, never substituted."""
        if self._session_ready:
            return
        with self._session_lock:
            if self._session_ready:
                return
            payload = self._request("GET", "/iserver/accounts", session=False)
            accounts = [
                str(a).upper()
                for a in (payload.get("accounts") or [] if isinstance(payload, dict) else [])
            ]
            if self._account_id not in accounts:
                raise HTTPException(
                    502,
                    f"IBKR gateway is signed in to {accounts or 'no accounts'}, not "
                    f"{self._account_id}: sign the gateway in to the login that holds "
                    "this account",
                )
            self._request("GET", "/portfolio/accounts", session=False)
            self._session_ready = True

    def _acct(self) -> str:
        return self._account_id

    # -- Connectivity check (probes.py) ------------------------------------ #
    def probe(self) -> None:
        """Tickle (the probe interval doubles as the keep-alive the gateway
        needs every few minutes), then require an authenticated, uncontested
        brokerage session holding this account."""
        self._request("POST", "/tickle", session=False)
        status = self._request("POST", "/iserver/auth/status", session=False)
        if not isinstance(status, dict) or not status.get("authenticated"):
            self._session_ready = False
            raise HTTPException(
                503,
                "IBKR Client Portal Gateway is not signed in: open the gateway's "
                "address in a browser and log in",
            )
        if status.get("competing"):
            raise HTTPException(
                503,
                "Another IBKR session (TWS, IBKR Desktop or mobile) holds this login's "
                "brokerage session; log it out or use a second username",
            )
        self._ensure_session()

    # -- Symbols ------------------------------------------------------------ #
    def _conid(self, symbol: str) -> int:
        """The app's symbol -> conid. A number is a conid already; ``EUR.USD``
        is an IDEALPRO pair; ``BHP:ASX`` is a stock on that exchange; a bare
        ticker is its US listing, or its only listing."""
        key = symbol.strip().upper()
        if key.isdigit():
            return int(key)
        cached = self._conids.get(key)
        if cached is not None:
            return cached
        pair = _fx_pair(key)
        conid = self._fx_conid(*pair) if pair else self._stock_conid(key)
        self._conids[key] = conid
        self._symbols.setdefault(conid, f"{pair[0]}.{pair[1]}" if pair else key)
        return conid

    def _fx_conid(self, base: str, quote: str) -> int:
        wanted = f"{base}.{quote}"
        for currency in (base, quote):
            payload = self._request("GET", "/iserver/currency/pairs", params={"currency": currency})
            rows = payload.get(currency) if isinstance(payload, dict) else None
            for row in rows if isinstance(rows, list) else []:
                if isinstance(row, dict) and str(row.get("symbol", "")).upper() == wanted:
                    return int(row["conid"])
        raise HTTPException(400, f"IBKR offers no currency pair {wanted}")

    def _stock_conid(self, key: str) -> int:
        ticker, _, exchange = key.partition(":")
        payload = self._request("GET", "/trsrv/stocks", params={"symbols": ticker})
        entries = payload.get(ticker) if isinstance(payload, dict) else None
        contracts = [
            c
            for e in (entries if isinstance(entries, list) else [])
            if isinstance(e, dict)
            for c in (e.get("contracts") or [])
            if isinstance(c, dict) and c.get("conid")
        ]
        if not contracts:
            raise HTTPException(400, f"IBKR has no stock listed as {ticker}")
        if exchange:
            match = [c for c in contracts if str(c.get("exchange", "")).upper() == exchange]
            if not match:
                listed = sorted({str(c.get("exchange")) for c in contracts})
                raise HTTPException(400, f"IBKR lists {ticker} on {listed}, not on {exchange}")
            return int(match[0]["conid"])
        us = [c for c in contracts if c.get("isUS")]
        if us:
            return int(us[0]["conid"])
        if len(contracts) == 1:
            return int(contracts[0]["conid"])
        listed = sorted({str(c.get("exchange")) for c in contracts})
        raise HTTPException(
            400,
            f"IBKR lists {ticker} on {listed}; name one as {ticker}:<EXCHANGE> "
            f"(for example {ticker}:{listed[0]})",
        )

    def _contract_info(self, conid: int) -> Dict[str, Any]:
        info = self._info.get(conid)
        if info is None:
            payload = self._request("GET", f"/iserver/contract/{conid}/info")
            info = payload if isinstance(payload, dict) else {}
            self._info[conid] = info
        return info

    def _symbol_for(self, conid: Any, fallback: Any = "") -> str:
        try:
            known = self._symbols.get(int(conid))
        except (TypeError, ValueError):
            known = None
        return known or str(fallback or conid or "")

    # -- MarketDataAdapter ------------------------------------------------- #
    def search_contracts(self, request: Any) -> Dict[str, Any]:
        query = (getattr(request, "symbol", "") or "").strip()
        limit = getattr(request, "max_results", None) or 50
        params: Dict[str, Any] = {"symbol": query}
        if getattr(request, "searchByName", False) or getattr(request, "search_by_name", False):
            params["name"] = "true"
        payload = self._request("GET", "/iserver/secdef/search", params=params)
        rows = payload if isinstance(payload, list) else []
        results: List[Dict[str, Any]] = []
        for row in rows[:limit]:
            if not isinstance(row, dict) or not row.get("conid"):
                continue
            sections = [s for s in row.get("sections") or [] if isinstance(s, dict)]
            sec_type = str(sections[0].get("secType")) if sections else "STK"
            results.append(
                {
                    "conid": str(row["conid"]),
                    "symbol": str(row.get("symbol") or query).upper(),
                    "companyName": row.get("companyName") or row.get("companyHeader") or "",
                    "description": row.get("companyHeader") or row.get("description") or "",
                    "secType": sec_type,
                    "exchange": str(row.get("description") or ""),
                    "currency": "",
                    "broker": "ibweb",
                }
            )
        return {"results": results, "count": len(results), "broker": "ibweb"}

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
        bar = _TIMEFRAME_TO_BAR.get(timeframe)
        if bar is None:
            raise HTTPException(400, f"timeframe '{timeframe}' is not supported on IBKR")
        params: Dict[str, Any] = {"conid": self._conid(symbol), "bar": bar, "outsideRth": "false"}
        if start_date and end_date:
            start = datetime.fromisoformat(start_date)
            end = datetime.fromisoformat(end_date)
            params["period"] = f"{max(1, (end - start).days)}d"
            params["startTime"] = end.strftime("%Y%m%d-00:00:00")
        else:
            params["period"] = _PERIODS.get(period, "1y")
        payload = self._request("GET", "/iserver/marketdata/history", params=params)
        data = payload.get("data", []) if isinstance(payload, dict) else []
        rows = []
        for p in data if isinstance(data, list) else []:
            if not isinstance(p, dict):
                continue
            o, h, low, c = (_opt_float(p.get(k)) for k in ("o", "h", "l", "c"))
            t = _opt_float(p.get("t"))
            if t is None or None in (o, h, low, c):
                continue
            rows.append(
                {
                    "timestamp": t / 1000.0,
                    "open": o,
                    "high": h,
                    "low": low,
                    "close": c,
                    "volume": int(_opt_float(p.get("v")) or 0),
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
        if not rows:
            return []
        if not indicators:
            return [CandlestickBar(**r) for r in rows]
        df = pd.DataFrame(rows)
        enriched = indicator_calculator.calculate_indicators(df, indicators)
        allowed = set(CandlestickBar.model_fields.keys())
        bars: List[CandlestickBar] = []
        for record in enriched.to_dict(orient="records"):
            clean = {
                k: (None if (isinstance(v, float) and pd.isna(v)) else v)
                for k, v in record.items()
                if k in allowed
            }
            bars.append(CandlestickBar(**clean))
        return bars

    def _snapshot(self, conid: int) -> Dict[str, Any]:
        row: Dict[str, Any] = {}
        for attempt in range(_SNAPSHOT_TRIES):
            payload = self._request(
                "GET",
                "/iserver/marketdata/snapshot",
                params={"conids": str(conid), "fields": _SNAPSHOT_FIELDS},
            )
            rows = payload if isinstance(payload, list) else []
            row = next((r for r in rows if isinstance(r, dict)), {})
            if any(row.get(f) is not None for f in (_FIELD_LAST, _FIELD_BID, _FIELD_ASK)):
                return row
            if attempt + 1 < _SNAPSHOT_TRIES:
                time.sleep(_SNAPSHOT_WAIT_SECONDS)
        return row

    def realtime_quote(self, symbol: str, account_mode: str = "paper") -> RealTimeQuote:
        row = self._snapshot(self._conid(symbol))
        bid, ask = _price(row.get(_FIELD_BID)), _price(row.get(_FIELD_ASK))
        last = _price(row.get(_FIELD_LAST))
        if last is None and bid is not None and ask is not None:
            last = (bid + ask) / 2
        if last is None and bid is None and ask is None:
            raise HTTPException(
                502,
                f"IBKR returned no prices for {symbol}: check the account's market "
                "data subscriptions for that exchange",
            )
        volume = _opt_float(row.get(f"{_FIELD_VOLUME}_raw")) or _price(row.get(_FIELD_VOLUME))
        return RealTimeQuote(
            symbol=symbol.upper(),
            bid=bid,
            ask=ask,
            last=last,
            volume=int(volume) if volume is not None else None,
            timestamp=datetime.now(UTC).isoformat(),
        )

    def tick(self, symbol: str, account_mode: str = "paper") -> Dict[str, Any]:
        quote = self.realtime_quote(symbol, account_mode)
        return {
            "symbol": quote.symbol,
            "timestamp": quote.timestamp,
            "bid": quote.bid,
            "ask": quote.ask,
            "last": quote.last,
            "volume": quote.volume,
            "broker": "ibweb",
        }

    # -- BrokerAdapter (execution) ------------------------------------------ #
    def _submit(self, path: str, body: Any) -> tuple[List[Dict[str, Any]], List[str]]:
        """Send an order call and answer IBKR's precautionary prompts. Returns
        the placed orders and the prompts that were confirmed."""
        warnings: List[str] = []
        payload = self._request("POST", path, json=body, order=True)
        for _ in range(_MAX_REPLIES + 1):
            rows = payload if isinstance(payload, list) else [payload]
            rows = [r for r in rows if isinstance(r, dict)]
            for row in rows:
                if row.get("error"):
                    raise HTTPException(422, f"IBKR rejected the order: {row['error']}")
            prompt = next((r for r in rows if r.get("id") and r.get("message")), None)
            if prompt is None:
                return rows, warnings
            if len(warnings) >= _MAX_REPLIES:
                break
            messages = prompt.get("message")
            text = " ".join(messages) if isinstance(messages, list) else str(messages)
            warnings.append(text)
            logger.warning("ibweb_order_prompt_confirmed", prompt=text[:300])
            payload = self._request(
                "POST", f"/iserver/reply/{prompt['id']}", json={"confirmed": True}, order=True
            )
        raise HTTPException(502, f"IBKR kept asking to confirm the order: {warnings[-1:]}")

    def _ticket(
        self,
        conid: int,
        side: str,
        quantity: float,
        order_type: str,
        tif: str,
        limit_price: Optional[float],
        stop_price: Optional[float],
    ) -> Dict[str, Any]:
        if order_type not in _ORDER_TYPES:
            raise HTTPException(400, f"order_type '{order_type}' is not supported on IBKR")
        if tif not in _TIFS:
            raise HTTPException(400, f"tif '{tif}' is not supported on IBKR")
        ticket: Dict[str, Any] = {
            "acctId": self._acct(),
            "conid": conid,
            "orderType": _ORDER_TYPES[order_type],
            "side": side,
            "quantity": float(quantity),
            "tif": _TIFS[tif],
        }
        if order_type == "LMT":
            if limit_price is None:
                raise HTTPException(400, "a limit_price is required for order_type=LMT")
            ticket["price"] = float(limit_price)
        elif order_type == "STP":
            if stop_price is None:
                raise HTTPException(400, "a stop_price is required for order_type=STP")
            ticket["price"] = float(stop_price)
        elif order_type == "STP_LMT":
            if limit_price is None or stop_price is None:
                raise HTTPException(
                    400, "limit_price and stop_price are required for order_type=STP_LMT"
                )
            ticket["price"] = float(limit_price)
            ticket["auxPrice"] = float(stop_price)
        return ticket

    def place_order(self, request: Any) -> Dict[str, Any]:
        """Place an order, after the same validation and live gate every other
        venue runs. A stop and target become a bracket: two GTC child orders
        tied to the entry by its client order id, sent in the same call."""
        from orders import _validate_common

        _validate_common(request.action, request.order_type, request.tif, request.account_mode)
        conid = self._conid(request.symbol)
        entry = self._ticket(
            conid,
            request.action,
            request.quantity,
            request.order_type,
            request.tif,
            request.limit_price,
            request.stop_price,
        )
        reference = client_order_id(getattr(request, "audit_id", None))
        stop_loss = getattr(request, "stop_loss", None)
        take_profit = getattr(request, "take_profit", None)
        protected = stop_loss is not None or take_profit is not None
        if protected and not reference:
            # Children name their parent by its client order id.
            reference = f"tradingapp-{uuid.uuid4().hex[:16]}"
        if reference:
            entry["cOID"] = reference
        tickets = [entry]
        exit_side = "SELL" if request.action == "BUY" else "BUY"
        if stop_loss is not None:
            tickets.append(
                {
                    "acctId": self._acct(),
                    "conid": conid,
                    "orderType": "STP",
                    "side": exit_side,
                    "quantity": float(request.quantity),
                    "price": float(stop_loss),
                    "tif": "GTC",
                    "parentId": reference,
                    "cOID": f"{reference}-sl",
                }
            )
        if take_profit is not None:
            tickets.append(
                {
                    "acctId": self._acct(),
                    "conid": conid,
                    "orderType": "LMT",
                    "side": exit_side,
                    "quantity": float(request.quantity),
                    "price": float(take_profit),
                    "tif": "GTC",
                    "parentId": reference,
                    "cOID": f"{reference}-tp",
                }
            )

        placed, warnings = self._submit(
            f"/iserver/account/{self._acct()}/orders", {"orders": tickets}
        )
        if not placed:
            raise HTTPException(502, "IBKR accepted the order without an order id")

        def _by_local(local: Optional[str]) -> Optional[Dict[str, Any]]:
            return next(
                (p for p in placed if local and str(p.get("local_order_id")) == local), None
            )

        parent = _by_local(reference) or placed[0]
        # The venue's record of the protection: a child that came back with
        # an order id. A child IBKR did not return counts as missing, so the
        # app treats the entry as unprotected.
        stop_child = _by_local(f"{reference}-sl") if stop_loss is not None else None
        target_child = _by_local(f"{reference}-tp") if take_profit is not None else None
        if stop_loss is not None and stop_child is None and len(placed) == len(tickets):
            stop_child = placed[1]
        if take_profit is not None and target_child is None and len(placed) == len(tickets):
            target_child = placed[-1]
        status = str(parent.get("order_status") or "").lower()
        return {
            "order_id": str(parent.get("order_id") or ""),
            "symbol": request.symbol.upper(),
            "action": request.action,
            "quantity": request.quantity,
            "order_type": request.order_type,
            "tif": request.tif,
            "account_mode": request.account_mode,
            "broker": "ibweb",
            "status": "filled" if status == "filled" else "submitted",
            "sl": float(stop_loss) if stop_child and stop_child.get("order_id") else None,
            "tp": float(take_profit) if target_child and target_child.get("order_id") else None,
            "warnings": warnings,
        }

    def cancel_order(self, order_id: Any) -> Dict[str, Any]:
        self._request("DELETE", f"/iserver/account/{self._acct()}/order/{order_id}")
        return {"order_id": str(order_id), "broker": "ibweb", "status": "cancel_requested"}

    def _live_orders(self) -> List[Dict[str, Any]]:
        payload = self._request(
            "GET", "/iserver/account/orders", params={"accountId": self._acct()}
        )
        rows = payload.get("orders") if isinstance(payload, dict) else None
        return [
            r
            for r in (rows if isinstance(rows, list) else [])
            if isinstance(r, dict) and str(r.get("acct") or self._acct()).upper() == self._acct()
        ]

    def modify_order(self, order_id: Any, request: Any) -> Dict[str, Any]:
        """Change a working order. The Web API wants the whole ticket, so a
        field the request leaves out is taken from the working order."""
        from orders import _validate_common

        tif = request.tif or "DAY"
        _validate_common(request.action, request.order_type, tif, request.account_mode)
        quantity = request.quantity
        if quantity is None:
            current = next(
                (o for o in self._live_orders() if str(o.get("orderId")) == str(order_id)), None
            )
            if current is None:
                raise HTTPException(404, f"no working IBKR order {order_id}")
            quantity = _opt_float(current.get("remainingQuantity")) or _opt_float(
                current.get("totalSize")
            )
        ticket = self._ticket(
            self._conid(request.symbol),
            request.action,
            quantity,
            request.order_type,
            tif,
            request.limit_price,
            request.stop_price,
        )
        _, warnings = self._submit(f"/iserver/account/{self._acct()}/order/{order_id}", ticket)
        return {
            "order_id": str(order_id),
            "broker": "ibweb",
            "status": "modify_requested",
            "warnings": warnings,
        }

    def positions(self) -> List[Dict[str, Any]]:
        """Open positions in ``models.Position`` shape, every page of them. A
        failed read raises: an empty list would read as "nothing at risk"."""
        rows: List[Dict[str, Any]] = []
        for page in range(_MAX_POSITION_PAGES):
            payload = self._request("GET", f"/portfolio/{self._acct()}/positions/{page}")
            batch = [r for r in payload if isinstance(r, dict)] if isinstance(payload, list) else []
            rows.extend(batch)
            if len(batch) < _POSITIONS_PAGE_SIZE:
                break
        positions: List[Dict[str, Any]] = []
        for row in rows:
            size = _opt_float(row.get("position"))
            if not size:
                continue
            conid = row.get("conid")
            asset = str(row.get("assetClass") or "")
            fallback = row.get("contractDesc") if asset == "CASH" else row.get("ticker")
            symbol = self._symbol_for(conid, fallback or row.get("contractDesc"))
            positions.append(
                {
                    "symbol": symbol,
                    "position": size,
                    "market_price": _opt_float(row.get("mktPrice")),
                    "market_value": _opt_float(row.get("mktValue")),
                    "average_cost": _opt_float(row.get("avgPrice"))
                    or _opt_float(row.get("avgCost")),
                    "unrealized_pnl": _opt_float(row.get("unrealizedPnl")),
                    "currency": str(row.get("currency") or self._currency),
                }
            )
        return positions

    def account_summary(self) -> Dict[str, Any]:
        payload = self._request("GET", f"/portfolio/{self._acct()}/summary")
        summary = payload if isinstance(payload, dict) else {}
        net = summary.get("netliquidation")
        currency = net.get("currency") if isinstance(net, dict) else None
        return {
            "account_id": self._acct(),
            "net_liquidation": _amount(summary, "netliquidation"),
            "currency": str(currency or self._currency),
            "last_updated": datetime.now(UTC).isoformat(),
            "total_cash_value": _amount(summary, "totalcashvalue"),
            "buying_power": _amount(summary, "buyingpower"),
            "maintenance_margin": _amount(summary, "maintmarginreq"),
        }

    def open_orders(self) -> List[Dict[str, Any]]:
        orders: List[Dict[str, Any]] = []
        for row in self._live_orders():
            status = str(row.get("status") or "")
            if status.replace(" ", "").lower() in _CLOSED_STATUSES:
                continue
            order_type = _app_order_type(row.get("origOrderType") or row.get("orderType"))
            total = _opt_float(row.get("totalSize")) or 0.0
            filled = _opt_float(row.get("filledQuantity"))
            remaining = _opt_float(row.get("remainingQuantity"))
            orders.append(
                {
                    "order_id": str(row.get("orderId") or ""),
                    "symbol": self._symbol_for(row.get("conid"), row.get("ticker")),
                    "action": "SELL" if str(row.get("side")).upper().startswith("S") else "BUY",
                    "quantity": total,
                    "order_type": order_type,
                    "status": status or "Submitted",
                    "filled_quantity": filled,
                    "remaining_quantity": remaining if remaining is not None else total,
                    "avg_fill_price": _opt_float(row.get("avgPrice")),
                }
            )
        return orders

    def executions(self, days: int = 1) -> List[Dict[str, Any]]:
        """Fills in ``models.Execution`` shape. The Web API keeps at most
        seven days of trades; older fills come from the statements."""
        payload = self._request(
            "GET",
            "/iserver/account/trades",
            params={"days": max(1, min(int(days or 1), _MAX_TRADE_DAYS))},
        )
        rows = payload if isinstance(payload, list) else []
        fills: List[Dict[str, Any]] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            account = str(row.get("account") or row.get("accountCode") or self._acct()).upper()
            if account != self._acct():
                continue
            size = _opt_float(row.get("size"))
            price = _opt_float(row.get("price"))
            exec_id = str(row.get("execution_id") or "")
            if not exec_id or not size or price is None:
                continue
            millis = _opt_float(row.get("trade_time_r"))
            moment = datetime.fromtimestamp(millis / 1000, UTC) if millis else datetime.now(UTC)
            commission = _opt_float(row.get("commission"))
            fills.append(
                {
                    "exec_id": exec_id,
                    "order_id": str(row.get("order_id") or row.get("orderId") or "") or None,
                    "audit_id": audit_id_from(row.get("order_ref")),
                    "symbol": self._symbol_for(row.get("conid"), row.get("symbol")),
                    "side": "SELL" if str(row.get("side")).upper().startswith("S") else "BUY",
                    "quantity": abs(size),
                    "price": price,
                    "commission": abs(commission) if commission is not None else None,
                    "realized_pnl": None,
                    "executed_at": moment.isoformat(),
                    "account": self._acct(),
                    "currency": str(row.get("currency") or self._currency),
                    "broker": "ibweb",
                }
            )
        return fills

    def instrument_spec(self, symbol: str) -> Dict[str, Any]:
        """Stocks and FX trade in whole units (shares, or units of the base
        currency); futures and options in contracts of ``multiplier``."""
        conid = self._conid(symbol)
        info = self._contract_info(conid)
        kind = str(info.get("instrument_type") or "STK").upper()
        unit = {"STK": "shares", "CASH": "units"}.get(kind, "contracts")
        multiplier = _opt_float(info.get("multiplier")) if kind not in ("STK", "CASH") else None
        return {
            "symbol": symbol.upper(),
            "broker": "ibweb",
            "unit": unit,
            "min_size": 1.0,
            "size_step": 1.0,
            "max_size": None,
            "contract_size": multiplier or 1.0,
            "currency": str(info.get("currency") or self._currency),
        }
