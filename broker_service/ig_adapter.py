"""IG adapter — market data + execution (CFDs) over IG's REST trading API.

IG Markets (ASIC-regulated in Australia) publishes a REST API for retail
accounts, reachable directly from this service like OANDA's: no terminal or
sidecar host. This module implements the `MarketDataAdapter` and
`BrokerAdapter` protocols (`adapters.py`) as a thin `httpx` client.

### IG REST contract used here

    Base: https://demo-api.ig.com/gateway/deal (demo) or
          https://api.ig.com/gateway/deal (live)

      POST /session              (v2)  -> CST + X-SECURITY-TOKEN headers
      PUT  /session              (v1)  -> switch to the configured account
      GET  /accounts             (v1)  -> balance, P&L, margin
      GET  /markets?searchTerm=  (v1)  -> search
      GET  /markets/{epic}       (v3)  -> snapshot, dealing rules, currency
      GET  /prices/{epic}        (v3)  -> candles
      POST /positions/otc        (v2)  -> market order
      POST /workingorders/otc    (v2)  -> limit / stop order
      PUT  /workingorders/otc/{dealId} (v2), DELETE (v2)
      GET  /confirms/{dealReference}   -> the outcome of a deal
      GET  /positions            (v2), PUT /positions/otc/{dealId} (v2)
      GET  /workingorders        (v2)
      GET  /history/activity     (v3)  -> fills

Every request carries the account's API key (`X-IG-API-KEY`) and the two
session tokens from the last login. A session lasts hours, not days; a 401
logs in again once and retries.

Mapping notes the rest of the codebase does not need to know about:

  - **Symbols.** IG addresses a market by *epic*. A spot FX pair in the
    app's form (`EUR.USD`) maps to IG's CFD epic `CS.D.EURUSD.CFD.IP`, which
    is what an Australian CFD account trades; anything else is passed through
    as an epic, so search results (which return epics) round-trip. A
    connection's `symbol_map` covers markets with other epics.
  - **Size.** IG sizes in contracts (lots for FX), so `instrument_spec`
    reports the epic's `contractSize` and its minimum deal size.
  - **Protection.** A stop and target ride on the entry (`stopLevel` /
    `limitLevel`), which IG only accepts with `forceOpen`; an order without
    them nets against an open position, which is how the app closes one.
  - **Allowance.** IG meters historical prices (10,000 points a week by
    default), so a chart period asks for at most `_MAX_PERIOD_POINTS` of the
    most recent bars.

`STP_LMT` has no IG equivalent and is refused with a 400.
"""

from __future__ import annotations

import re
import threading
from datetime import UTC, datetime, timedelta
from typing import Any, Dict, List, Optional

import httpx
import pandas as pd
from fastapi import HTTPException

from client_ids import audit_id_from, client_order_id
from indicators import calculator as indicator_calculator
from models import CandlestickBar, HistoricalDataResponse, RealTimeQuote
from observability import get_logger
from stops import is_more_protective

logger = get_logger(__name__)

_HTTP_TIMEOUT_SECONDS = 30.0
_DEMO_BASE = "https://demo-api.ig.com/gateway/deal"
_LIVE_BASE = "https://api.ig.com/gateway/deal"

# App timeframe -> IG resolution. IG has no 8-hour bar.
_TIMEFRAME_TO_RESOLUTION = {
    "1min": "MINUTE",
    "5min": "MINUTE_5",
    "15min": "MINUTE_15",
    "30min": "MINUTE_30",
    "1hour": "HOUR",
    "4hour": "HOUR_4",
    "1day": "DAY",
}
_RESOLUTION_SECONDS = {
    "MINUTE": 60,
    "MINUTE_5": 300,
    "MINUTE_15": 900,
    "MINUTE_30": 1800,
    "HOUR": 3600,
    "HOUR_4": 14400,
    "DAY": 86400,
}
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
# Historical prices count against a weekly allowance, so a chart period is
# capped; an explicit date range (a backfill) asks for exactly that range.
_MAX_PERIOD_POINTS = 1000

# MKT goes to /positions/otc, LMT/STP to /workingorders/otc.
_WORKING_TYPES = {"LMT": "LIMIT", "STP": "STOP"}
_IG_TO_ORDER_TYPE = {"LIMIT": "LMT", "STOP": "STP"}

_FX_PAIR_RE = re.compile(r"^([A-Z]{3})[._/]?([A-Z]{3})$")
_FX_EPIC_RE = re.compile(r"^CS\.D\.([A-Z]{3})([A-Z]{3})\.CFD\.IP$")


def _to_epic(symbol: str) -> str:
    """`EUR.USD` / `EURUSD` -> `CS.D.EURUSD.CFD.IP`; an epic passes through."""
    text = symbol.strip().upper()
    if text.count(".") >= 2:
        return text
    m = _FX_PAIR_RE.match(text)
    if m:
        return f"CS.D.{m.group(1)}{m.group(2)}.CFD.IP"
    return text


def _from_epic(epic: str) -> str:
    """`CS.D.EURUSD.CFD.IP` -> `EUR.USD`; any other epic is its own symbol."""
    m = _FX_EPIC_RE.match(epic.upper())
    if m:
        return f"{m.group(1)}.{m.group(2)}"
    return epic


def _parse_ig_time(value: Any) -> Optional[datetime]:
    """IG's UTC times: `2026-01-02T03:04:05` (optionally with millis or Z)."""
    if not value:
        return None
    text = str(value).replace("Z", "").replace("/", "-").replace(" ", "T")
    if "." in text:
        head, frac = text.split(".", 1)
        text = f"{head}.{frac[:6]}"
    try:
        return datetime.fromisoformat(text).replace(tzinfo=UTC)
    except ValueError:
        return None


def _ig_time(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S")


class IGAdapter:
    """`MarketDataAdapter` + `BrokerAdapter` backed by IG's REST trading API."""

    # The price this venue builds its own bars from; the live recorder builds
    # stream bars the same way (docs/plans/E-05-live-recorder.md, D5).
    bar_basis = "mid"

    name = "ig"
    # stopLevel / limitLevel ride on the entry, in the deal itself.
    attaches_stops = True

    def __init__(
        self,
        api_key: str,
        username: str,
        password: str,
        *,
        account_id: Optional[str] = None,
        environment: str = "demo",
        timeout: float = _HTTP_TIMEOUT_SECONDS,
    ) -> None:
        self._base = _LIVE_BASE if environment == "live" else _DEMO_BASE
        self._api_key = api_key
        self._username = username
        self._password = password
        self._account_id = account_id or None
        self._timeout = timeout
        self._tokens: Optional[Dict[str, str]] = None
        self._login_lock = threading.Lock()
        self._markets: Dict[str, Dict[str, Any]] = {}

    # -- HTTP plumbing ----------------------------------------------------- #
    def _headers(self, version: int) -> Dict[str, str]:
        headers = {
            "X-IG-API-KEY": self._api_key,
            "Version": str(version),
            "Accept": "application/json; charset=UTF-8",
            "Content-Type": "application/json; charset=UTF-8",
        }
        if self._tokens:
            headers.update(self._tokens)
        return headers

    def _send(
        self,
        method: str,
        path: str,
        version: int,
        params: Optional[Dict[str, Any]],
        json: Optional[Dict[str, Any]],
    ) -> Any:
        url = f"{self._base}{path}"
        try:
            with httpx.Client(timeout=self._timeout) as client:
                return client.request(
                    method,
                    url,
                    headers=self._headers(version),
                    params={k: v for k, v in (params or {}).items() if v is not None},
                    json=json,
                )
        except httpx.HTTPError as exc:
            logger.error("ig_unreachable", url=url, method=method, error=str(exc))
            raise HTTPException(503, f"IG unreachable: {exc}")

    def _login(self) -> None:
        """Open a session; switch to the configured account if it is not the
        login's default. Serialised so concurrent first calls log in once."""
        with self._login_lock:
            self._tokens = None
            resp = self._send(
                "POST",
                "/session",
                2,
                None,
                {"identifier": self._username, "password": self._password},
            )
            if resp.status_code >= 400:
                raise HTTPException(502, f"IG login failed ({resp.status_code}): {resp.text[:200]}")
            cst = resp.headers.get("CST")
            token = resp.headers.get("X-SECURITY-TOKEN")
            if not (cst and token):
                raise HTTPException(502, "IG login returned no session tokens")
            self._tokens = {"CST": cst, "X-SECURITY-TOKEN": token}
            try:
                current = (resp.json() or {}).get("currentAccountId")
            except ValueError:
                current = None
            if self._account_id and current and current != self._account_id:
                switch = self._send("PUT", "/session", 1, None, {"accountId": self._account_id})
                if switch.status_code >= 400:
                    raise HTTPException(
                        502,
                        f"IG could not switch to account {self._account_id}: "
                        f"{switch.text[:200]}",
                    )

    def _request(
        self,
        method: str,
        path: str,
        *,
        version: int = 1,
        params: Optional[Dict[str, Any]] = None,
        json: Optional[Dict[str, Any]] = None,
    ) -> Any:
        if self._tokens is None:
            self._login()
        resp = self._send(method, path, version, params, json)
        if resp.status_code == 401:
            # The session expired; log in again once.
            self._login()
            resp = self._send(method, path, version, params, json)
        if resp.status_code >= 400:
            raise HTTPException(502, f"IG error {resp.status_code} for {path}: {resp.text[:200]}")
        if not resp.content:
            return {}
        try:
            return resp.json()
        except ValueError as exc:
            raise HTTPException(502, f"IG returned non-JSON for {path}: {exc}")

    def _map_timeframe(self, timeframe: str) -> str:
        resolution = _TIMEFRAME_TO_RESOLUTION.get(timeframe)
        if resolution is None:
            raise HTTPException(400, f"timeframe '{timeframe}' is not supported on IG")
        return resolution

    def _market(self, epic: str) -> Dict[str, Any]:
        """`GET /markets/{epic}`: instrument, dealing rules and snapshot. The
        static parts are cached; the snapshot is only fresh on a fresh call."""
        payload = self._request("GET", f"/markets/{epic}", version=3)
        if not isinstance(payload, dict) or not isinstance(payload.get("instrument"), dict):
            raise HTTPException(502, f"IG returned no market details for {epic}")
        self._markets[epic] = payload
        return payload

    def _cached_market(self, epic: str) -> Dict[str, Any]:
        return self._markets.get(epic) or self._market(epic)

    # -- Connectivity check (probes.py) ------------------------------------ #
    def probe(self) -> None:
        self._request("GET", "/accounts")

    # -- MarketDataAdapter ------------------------------------------------- #
    def search_contracts(self, request: Any) -> Dict[str, Any]:
        query = (getattr(request, "symbol", "") or "").strip()
        limit = getattr(request, "max_results", None) or 50
        payload = self._request("GET", "/markets", params={"searchTerm": query})
        markets = payload.get("markets", []) if isinstance(payload, dict) else []
        results: List[Dict[str, Any]] = []
        for m in markets[:limit] if isinstance(markets, list) else []:
            if not isinstance(m, dict) or not m.get("epic"):
                continue
            epic = str(m["epic"])
            kind = str(m.get("instrumentType") or "")
            results.append(
                {
                    "conid": epic,
                    "symbol": _from_epic(epic),
                    "companyName": m.get("instrumentName") or epic,
                    "description": m.get("instrumentName") or epic,
                    "secType": "CASH" if kind == "CURRENCIES" else "CFD",
                    "exchange": "IG",
                    "currency": "",
                    "broker": "ig",
                }
            )
        return {"results": results, "count": len(results), "broker": "ig"}

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
        resolution = self._map_timeframe(timeframe)
        epic = _to_epic(symbol)
        params: Dict[str, Any] = {"resolution": resolution, "pageSize": 0}
        if start_date and end_date:
            params["from"] = f"{start_date}T00:00:00"
            params["to"] = f"{end_date}T00:00:00"
        else:
            days = _PERIOD_TO_DAYS.get(period, 366)
            points = int(days * 86400 / _RESOLUTION_SECONDS[resolution])
            params["max"] = max(1, min(points, _MAX_PERIOD_POINTS))
        payload = self._request("GET", f"/prices/{epic}", version=3, params=params)
        prices = payload.get("prices", []) if isinstance(payload, dict) else []
        allowance = ((payload.get("metadata") or {}).get("allowance") or {}) if payload else {}
        if allowance.get("remainingAllowance") is not None:
            logger.info(
                "ig_price_allowance",
                remaining=allowance.get("remainingAllowance"),
                total=allowance.get("totalAllowance"),
            )

        rows = []
        for p in prices if isinstance(prices, list) else []:
            if not isinstance(p, dict):
                continue
            moment = _parse_ig_time(p.get("snapshotTimeUTC")) or _parse_ig_time(
                p.get("snapshotTime")
            )
            o, h, low, c = (
                _mid(p.get("openPrice")),
                _mid(p.get("highPrice")),
                _mid(p.get("lowPrice")),
                _mid(p.get("closePrice")),
            )
            if moment is None or None in (o, h, low, c):
                continue
            rows.append(
                {
                    "timestamp": moment.timestamp(),
                    "open": o,
                    "high": h,
                    "low": low,
                    "close": c,
                    "volume": int(p.get("lastTradedVolume") or 0),
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

    def realtime_quote(self, symbol: str, account_mode: str = "paper") -> RealTimeQuote:
        snapshot = self._market(_to_epic(symbol)).get("snapshot") or {}
        bid = _opt_float(snapshot.get("bid"))
        ask = _opt_float(snapshot.get("offer"))
        last = (bid + ask) / 2 if bid is not None and ask is not None else (bid or ask)
        return RealTimeQuote(
            symbol=symbol.upper(),
            bid=bid,
            ask=ask,
            last=last,
            volume=None,
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
            "broker": "ig",
        }

    # -- BrokerAdapter (execution) ------------------------------------------ #
    def _currency(self, epic: str) -> str:
        instrument = self._cached_market(epic).get("instrument") or {}
        currencies = instrument.get("currencies") or []
        default = next(
            (c for c in currencies if isinstance(c, dict) and c.get("isDefault")),
            currencies[0] if currencies else {},
        )
        code = (default or {}).get("code")
        if not code:
            raise HTTPException(502, f"IG did not report a dealing currency for {epic}")
        return str(code)

    def _confirm(self, deal_reference: str) -> Dict[str, Any]:
        """IG answers an order with a reference only; the outcome is on
        `/confirms`. A rejected deal is an error, not a submitted order."""
        confirm = self._request("GET", f"/confirms/{deal_reference}")
        if not isinstance(confirm, dict):
            raise HTTPException(502, "IG returned no deal confirmation")
        if confirm.get("dealStatus") == "REJECTED":
            raise HTTPException(
                422, f"IG rejected the deal: {confirm.get('reason') or 'no reason given'}"
            )
        return confirm

    def place_order(self, request: Any) -> Dict[str, Any]:
        """Place an order on IG, after the same validation and live gate every
        other venue runs. A market order opens (or nets against) a position;
        a limit or stop order rests as a working order."""
        from orders import _validate_common

        _validate_common(request.action, request.order_type, request.tif, request.account_mode)
        if request.order_type not in ("MKT", "LMT", "STP"):
            raise HTTPException(400, f"order_type '{request.order_type}' is not supported on IG")

        epic = _to_epic(request.symbol)
        stop_loss = getattr(request, "stop_loss", None)
        take_profit = getattr(request, "take_profit", None)
        protected = stop_loss is not None or take_profit is not None
        reference = client_order_id(getattr(request, "audit_id", None))
        body: Dict[str, Any] = {
            "epic": epic,
            "expiry": "-",
            "direction": request.action,
            "size": float(request.quantity),
            "currencyCode": self._currency(epic),
            "guaranteedStop": False,
            # IG accepts a stop or limit level only on a force-open deal; an
            # unprotected order nets, so an exit closes the position.
            "forceOpen": protected,
        }
        if reference:
            body["dealReference"] = reference
        if stop_loss is not None:
            body["stopLevel"] = float(stop_loss)
        if take_profit is not None:
            body["limitLevel"] = float(take_profit)

        if request.order_type == "MKT":
            body["orderType"] = "MARKET"
            body["timeInForce"] = (
                "EXECUTE_AND_ELIMINATE" if request.tif == "IOC" else "FILL_OR_KILL"
            )
            path = "/positions/otc"
        else:
            price = request.limit_price if request.order_type == "LMT" else request.stop_price
            if price is None:
                raise HTTPException(400, f"a price is required for order_type={request.order_type}")
            if request.tif in ("IOC", "FOK"):
                raise HTTPException(
                    400, f"tif '{request.tif}' is not supported on an IG working order"
                )
            body["type"] = _WORKING_TYPES[request.order_type]
            body["level"] = float(price)
            body.update(_working_tif(request.tif))
            path = "/workingorders/otc"

        resp = self._request("POST", path, version=2, json=body)
        deal_reference = (resp or {}).get("dealReference") or reference
        if not deal_reference:
            raise HTTPException(502, "IG accepted the order without a deal reference")
        confirm = self._confirm(str(deal_reference))
        filled = request.order_type == "MKT" and confirm.get("status") in ("OPEN", "AMENDED")
        return {
            "order_id": confirm.get("dealId") or deal_reference,
            "symbol": request.symbol.upper(),
            "action": request.action,
            "quantity": request.quantity,
            "order_type": request.order_type,
            "tif": request.tif,
            "account_mode": request.account_mode,
            "broker": "ig",
            "status": "filled" if filled else "submitted",
            # IG's own record of the protection, so the caller can verify it.
            "sl": _opt_float(confirm.get("stopLevel")),
            "tp": _opt_float(confirm.get("limitLevel")),
        }

    def modify_position_stop(
        self,
        symbol: str,
        *,
        stop_loss: Optional[float] = None,
        take_profit: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Move the stop on every deal that makes up the net position. A deal
        whose stop is already tighter keeps it: the ratchet never loosens."""
        epic = _to_epic(symbol)
        deals = [d for d in self._open_deals() if d["epic"] == epic]
        if not deals:
            raise HTTPException(404, f"no open IG positions for {symbol}")
        long_side = sum(d["signed_size"] for d in deals) > 0
        direction = "long" if long_side else "short"
        deals = [d for d in deals if (d["signed_size"] > 0) == long_side]

        stops: List[Optional[float]] = []
        targets: List[Optional[float]] = []
        for deal in deals:
            new_stop = deal["stop_loss"]
            if stop_loss is not None and is_more_protective(stop_loss, new_stop, direction):
                new_stop = float(stop_loss)
            new_target = float(take_profit) if take_profit is not None else deal["take_profit"]
            if new_stop == deal["stop_loss"] and new_target == deal["take_profit"]:
                stops.append(deal["stop_loss"])
                targets.append(deal["take_profit"])
                continue
            # IG replaces both levels on an update, so the unchanged one is
            # sent again rather than dropped.
            resp = self._request(
                "PUT",
                f"/positions/otc/{deal['deal_id']}",
                version=2,
                json={"stopLevel": new_stop, "limitLevel": new_target, "trailingStop": False},
            )
            confirm = self._confirm(str((resp or {}).get("dealReference") or ""))
            stops.append(_opt_float(confirm.get("stopLevel")))
            targets.append(_opt_float(confirm.get("limitLevel")))
        return {
            "symbol": symbol.upper(),
            "broker": "ig",
            "status": "modified",
            "sl": _least_protective(stops, long_side),
            "tp": _first_to_hit(targets, long_side),
        }

    def cancel_order(self, order_id: Any) -> Dict[str, Any]:
        self._request("DELETE", f"/workingorders/otc/{order_id}", version=2)
        return {"order_id": order_id, "broker": "ig", "status": "cancel_requested"}

    def modify_order(self, order_id: Any, request: Any) -> Dict[str, Any]:
        """Move a working order's level or time in force. IG cannot change a
        working order's size; a new size needs a cancel and a new order."""
        from orders import _validate_common

        tif = request.tif or "GTC"
        _validate_common(request.action, request.order_type, tif, request.account_mode)
        if request.order_type not in _WORKING_TYPES:
            raise HTTPException(400, f"order_type '{request.order_type}' has no IG working order")
        if tif in ("IOC", "FOK"):
            raise HTTPException(400, f"tif '{tif}' is not supported on an IG working order")
        body: Dict[str, Any] = {"type": _WORKING_TYPES[request.order_type], **_working_tif(tif)}
        price = request.limit_price if request.order_type == "LMT" else request.stop_price
        if price is not None:
            body["level"] = float(price)
        resp = self._request("PUT", f"/workingorders/otc/{order_id}", version=2, json=body)
        reference = (resp or {}).get("dealReference")
        if reference:
            self._confirm(str(reference))
        return {"order_id": order_id, "broker": "ig", "status": "modify_requested"}

    def _open_deals(self) -> List[Dict[str, Any]]:
        """Every open deal with its signed size and protection. A failed read
        raises: an empty list would read as "nothing open, nothing at risk"."""
        payload = self._request("GET", "/positions", version=2)
        rows = payload.get("positions", []) if isinstance(payload, dict) else []
        deals: List[Dict[str, Any]] = []
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            position = row.get("position") if isinstance(row.get("position"), dict) else {}
            market = row.get("market") if isinstance(row.get("market"), dict) else {}
            size = _opt_float(position.get("size"))
            if not size:
                continue
            sign = -1.0 if position.get("direction") == "SELL" else 1.0
            deals.append(
                {
                    "deal_id": str(position.get("dealId") or ""),
                    "epic": str(market.get("epic") or ""),
                    "signed_size": sign * size,
                    "level": _opt_float(position.get("level")),
                    "stop_loss": _opt_float(position.get("stopLevel")),
                    "take_profit": _opt_float(position.get("limitLevel")),
                    "currency": str(position.get("currency") or "USD"),
                    "bid": _opt_float(market.get("bid")),
                    "ask": _opt_float(market.get("offer")),
                }
            )
        return deals

    def positions(self) -> List[Dict[str, Any]]:
        """Open positions netted per epic, in the app's ``models.Position``
        shape. IG may hold several deals on one market (force-open entries);
        the net size and the size-weighted level are what the app trades
        against, and the stop reported is the least protective one."""
        by_epic: Dict[str, List[Dict[str, Any]]] = {}
        for deal in self._open_deals():
            by_epic.setdefault(deal["epic"], []).append(deal)
        positions: List[Dict[str, Any]] = []
        for epic, deals in by_epic.items():
            size = sum(d["signed_size"] for d in deals)
            if size == 0:
                continue
            legs = [d for d in deals if (d["signed_size"] > 0) == (size > 0)]
            weight = sum(abs(d["signed_size"]) for d in legs)
            levels = [d for d in legs if d["level"] is not None]
            average = (
                sum(abs(d["signed_size"]) * d["level"] for d in levels) / weight
                if levels and weight
                else None
            )
            bid, ask = legs[0]["bid"], legs[0]["ask"]
            positions.append(
                {
                    "symbol": _from_epic(epic),
                    "position": size,
                    "market_price": (
                        (bid + ask) / 2 if bid is not None and ask is not None else None
                    ),
                    "market_value": None,
                    "average_cost": average,
                    # IG reports no per-deal P&L on /positions; it is in the
                    # account's profitLoss.
                    "unrealized_pnl": None,
                    "stop_loss": _least_protective([d["stop_loss"] for d in legs], size > 0),
                    "take_profit": _first_to_hit([d["take_profit"] for d in legs], size > 0),
                    "currency": legs[0]["currency"],
                }
            )
        return positions

    def account_summary(self) -> Dict[str, Any]:
        """``models.AccountSummary`` from `/accounts`. IG's ``balance`` is the
        cash balance; equity is that plus open ``profitLoss``. ``available``
        is the closest analogue to buying power, ``deposit`` the margin held."""
        payload = self._request("GET", "/accounts")
        accounts = payload.get("accounts", []) if isinstance(payload, dict) else []
        accounts = [a for a in accounts if isinstance(a, dict)]
        account = next(
            (a for a in accounts if self._account_id and a.get("accountId") == self._account_id),
            None,
        ) or next((a for a in accounts if a.get("preferred")), accounts[0] if accounts else {})
        balance = account.get("balance") if isinstance(account.get("balance"), dict) else {}
        cash = _opt_float(balance.get("balance"))
        pnl = _opt_float(balance.get("profitLoss")) or 0.0
        return {
            "account_id": str(account.get("accountId") or self._account_id or ""),
            "net_liquidation": cash + pnl if cash is not None else None,
            "currency": str(account.get("currency") or "USD"),
            "last_updated": datetime.now(UTC).isoformat(),
            "total_cash_value": cash,
            "buying_power": _opt_float(balance.get("available")),
            "maintenance_margin": _opt_float(balance.get("deposit")),
        }

    def open_orders(self) -> List[Dict[str, Any]]:
        payload = self._request("GET", "/workingorders", version=2)
        rows = payload.get("workingOrders", []) if isinstance(payload, dict) else []
        orders: List[Dict[str, Any]] = []
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            data = row.get("workingOrderData") or {}
            size = _opt_float(data.get("orderSize")) or 0.0
            orders.append(
                {
                    "order_id": str(data.get("dealId") or ""),
                    "symbol": _from_epic(str(data.get("epic") or "")),
                    "action": "SELL" if data.get("direction") == "SELL" else "BUY",
                    "quantity": size,
                    "order_type": _IG_TO_ORDER_TYPE.get(str(data.get("orderType") or ""), "LMT"),
                    "status": "WORKING",
                    "filled_quantity": None,
                    "remaining_quantity": size,
                    "avg_fill_price": None,
                }
            )
        return orders

    def instrument_spec(self, symbol: str) -> Dict[str, Any]:
        """IG deals in contracts. ``contractSize`` is what one contract is
        worth in the underlying, and the dealing rules give the minimum size;
        the step is that minimum's own precision (0.5 steps in 0.1s)."""
        epic = _to_epic(symbol)
        market = self._cached_market(epic)
        instrument = market.get("instrument") or {}
        rules = market.get("dealingRules") or {}
        minimum = _opt_float((rules.get("minDealSize") or {}).get("value")) or 1.0
        decimals = len(f"{minimum:g}".split(".")[1]) if "." in f"{minimum:g}" else 0
        return {
            "symbol": _from_epic(epic),
            "broker": "ig",
            "unit": "contracts",
            "min_size": minimum,
            "size_step": 10**-decimals,
            "max_size": None,
            "contract_size": _opt_float(instrument.get("contractSize")) or 1.0,
            "currency": self._currency(epic),
        }

    def executions(self, days: int = 1) -> List[Dict[str, Any]]:
        """Fills from the activity history, in ``models.Execution`` shape. A
        fill is an accepted POSITION activity that opened, closed or partly
        closed a position. IG reports no commission on CFDs (it is in the
        spread) and the realised P&L only on the transaction history, so both
        are left empty here."""
        start = datetime.now(UTC) - timedelta(days=max(1, days))
        payload = self._request(
            "GET",
            "/history/activity",
            version=3,
            params={"from": _ig_time(start), "detailed": "true", "pageSize": 500},
        )
        rows = payload.get("activities", []) if isinstance(payload, dict) else []
        fills: List[Dict[str, Any]] = []
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            if row.get("type") != "POSITION" or row.get("status") != "ACCEPTED":
                continue
            details = row.get("details") if isinstance(row.get("details"), dict) else {}
            actions = {
                a.get("actionType") for a in details.get("actions") or [] if isinstance(a, dict)
            }
            if not actions & {"POSITION_OPENED", "POSITION_CLOSED", "POSITION_PARTIALLY_CLOSED"}:
                continue
            size = _opt_float(details.get("size"))
            price = _opt_float(details.get("level"))
            deal_id = str(row.get("dealId") or "")
            if not deal_id or not size or price is None:
                continue
            moment = _parse_ig_time(row.get("date"))
            fills.append(
                {
                    "exec_id": deal_id,
                    "order_id": deal_id,
                    "audit_id": audit_id_from(details.get("dealReference")),
                    "symbol": _from_epic(str(row.get("epic") or "")),
                    "side": "SELL" if details.get("direction") == "SELL" else "BUY",
                    "quantity": abs(size),
                    "price": price,
                    "commission": None,
                    "realized_pnl": None,
                    "executed_at": (moment or datetime.now(UTC)).isoformat(),
                    "account": self._account_id,
                    "currency": str(details.get("currency") or "USD"),
                    "broker": "ig",
                }
            )
        return fills


def _working_tif(tif: str) -> Dict[str, Any]:
    """IG's working orders know GOOD_TILL_CANCELLED and GOOD_TILL_DATE; a DAY
    order is good till the end of today, UTC."""
    if tif == "DAY":
        end = datetime.now(UTC).replace(hour=23, minute=59, second=59, microsecond=0)
        return {"timeInForce": "GOOD_TILL_DATE", "goodTillDate": end.strftime("%Y/%m/%d %H:%M:%S")}
    return {"timeInForce": "GOOD_TILL_CANCELLED"}


def _mid(price: Any) -> Optional[float]:
    if not isinstance(price, dict):
        return None
    bid, ask = _opt_float(price.get("bid")), _opt_float(price.get("ask"))
    if bid is not None and ask is not None:
        return (bid + ask) / 2
    return (
        bid
        if bid is not None
        else (ask if ask is not None else _opt_float(price.get("lastTraded")))
    )


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


def _opt_float(v: Any) -> Optional[float]:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None
