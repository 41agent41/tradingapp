"""OANDA adapter — market data + execution (FX/CFD).

OANDA's v20 REST API is a cloud service, reachable directly from this Linux
service — like Alpaca, no terminal/sidecar host is involved. This module
implements the `MarketDataAdapter` and `BrokerAdapter` protocols (`adapters.py`)
as a thin `httpx` client, normalising OANDA's responses into the app's shapes
(UTC unix-second timestamps, `CandlestickBar` / `RealTimeQuote`) so
`source=oanda` charts and streams like `source=ib` from the frontend's point
of view.

### OANDA v20 REST contract used here

    Base: https://api-fxpractice.oanda.com (practice) or
          https://api-fxtrade.oanda.com (live), account-scoped under
          /v3/accounts/{account_id}/...

      GET  /v3/accounts/{id}/instruments                                  -> full instrument list
      GET  /v3/accounts/{id}/instruments/{instrument}/candles?granularity= -> candles
      GET  /v3/accounts/{id}/pricing?instruments=                         -> bid/ask
      POST /v3/accounts/{id}/orders                                       -> place
      PUT  /v3/accounts/{id}/orders/{id}/cancel                           -> cancel (OANDA's verb)
      PUT  /v3/accounts/{id}/orders/{id}                                  -> replace (modify)
      GET  /v3/accounts/{id}/openPositions
      GET  /v3/accounts/{id}/openTrades                                   -> per-trade stops
      PUT  /v3/accounts/{id}/trades/{id}/orders                           -> move a trade's stop
      GET  /v3/accounts/{id}/summary

Auth is a single header on every request: `Authorization: Bearer {token}`.

Two OANDA-specific mapping quirks the rest of the codebase doesn't need to
know about:

  - **Symbols.** OANDA instruments are underscore-separated (`EUR_USD`); the
    app's forex symbols look like `EUR.USD` / `EURUSD`. `_to_instrument()` /
    `_from_instrument()` round-trip between the two.
  - **Direction.** OANDA has no `action`/`side` field — a single `units`
    value is *signed* (positive = buy, negative = sell). `place_order()`
    combines `action` + `quantity` into that signed value.

`STP_LMT` has no clean OANDA equivalent (OANDA's STOP order takes a single
trigger price, not an independent stop + limit pair) — placing one raises a
400, the same pattern MT5's adapter uses for an unmapped timeframe.

**Protection.** A stop loss and take profit ride on the entry order itself
(`stopLossOnFill` / `takeProfitOnFill`), so OANDA creates them in the same
transaction as the fill, or cancels the order. There is never a moment with an
open, unprotected trade. OANDA holds stops per *trade*, not per position, so
`positions()` reads `/openTrades` and reports the least protective stop of the
trades that make up the net position, or none if any of them lacks one.

Order placement runs the same `_validate_common` gate the IB path applies
(defence in depth, identical to MT5/Alpaca) before anything reaches OANDA.
"""

from __future__ import annotations

import re
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

# App timeframe -> OANDA granularity. Unlike MT5, OANDA has a native 8-hour
# candle (H8), so every app timeframe maps cleanly.
_TIMEFRAME_TO_GRANULARITY = {
    "1min": "M1",
    "5min": "M5",
    "15min": "M15",
    "30min": "M30",
    "1hour": "H1",
    "4hour": "H4",
    "8hour": "H8",
    "1day": "D",
}

# App order_type -> OANDA order type. STP_LMT has no clean OANDA equivalent.
_ORDER_TYPE_TO_OANDA = {"MKT": "MARKET", "LMT": "LIMIT", "STP": "STOP"}
_OANDA_TO_ORDER_TYPE = {v: k for k, v in _ORDER_TYPE_TO_OANDA.items()}
# LIMIT/STOP accept the full OANDA TIF vocabulary; a MARKET order only
# accepts FOK/IOC (OANDA rejects GTC/GFD/GTD on a MarketOrderRequest), so
# DAY/GTC on a market order fold to FOK — "execute now or don't", the
# closest OANDA-native match to what those TIFs mean for a marketable order.
_TIF_TO_OANDA = {"DAY": "GFD", "GTC": "GTC", "IOC": "IOC", "FOK": "FOK"}
_MARKET_TIF_TO_OANDA = {"DAY": "FOK", "GTC": "FOK", "IOC": "IOC", "FOK": "FOK"}

_HTTP_TIMEOUT_SECONDS = 30.0
_PRACTICE_BASE = "https://api-fxpractice.oanda.com"
_LIVE_BASE = "https://api-fxtrade.oanda.com"

# Rough candle budget per app period (OANDA caps a single request at 5000).
_PERIOD_TO_COUNT = {
    "1D": 400,
    "1W": 2000,
    "1M": 5000,
    "3M": 5000,
    "6M": 5000,
    "1Y": 5000,
}

_FX_PAIR_RE = re.compile(r"^([A-Z]{3})[._/]?([A-Z]{3})$")

# `/transactions` answers with page URLs rather than transactions, so a fills
# fetch is one request per page. Capped so a wide window degrades into "the
# most recent N pages" instead of an unbounded fan-out at the venue.
_MAX_TRANSACTION_PAGES = 10


def _to_instrument(symbol: str) -> str:
    """`EUR.USD` / `EURUSD` / `eur_usd` -> OANDA's `EUR_USD`."""
    cleaned = symbol.upper().replace(".", "").replace("/", "").replace("_", "")
    m = _FX_PAIR_RE.match(cleaned)
    if m:
        return f"{m.group(1)}_{m.group(2)}"
    return symbol.upper().replace(".", "_").replace("/", "_")


def _from_instrument(instrument: str) -> str:
    """`EUR_USD` -> the app's dotted form `EUR.USD`."""
    return instrument.replace("_", ".")


class OANDAAdapter:
    """`MarketDataAdapter` + `BrokerAdapter` backed by the OANDA v20 REST API."""

    name = "oanda"

    def __init__(
        self,
        api_token: str,
        account_id: str,
        *,
        environment: str = "practice",
        timeout: float = _HTTP_TIMEOUT_SECONDS,
    ) -> None:
        self._base = _LIVE_BASE if environment == "live" else _PRACTICE_BASE
        self._account_id = account_id
        self._headers = {"Authorization": f"Bearer {api_token}"}
        self._timeout = timeout
        self._precision: Dict[str, int] = {}

    # -- HTTP plumbing ----------------------------------------------------- #
    def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        json: Optional[Dict[str, Any]] = None,
    ) -> Any:
        url = f"{self._base}{path}"
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
            logger.error("oanda_unreachable", url=url, method=method, error=str(exc))
            raise HTTPException(503, f"OANDA unreachable: {exc}")
        if resp.status_code >= 400:
            raise HTTPException(
                502, f"OANDA error {resp.status_code} for {path}: {resp.text[:200]}"
            )
        try:
            return resp.json()
        except ValueError as exc:
            raise HTTPException(502, f"OANDA returned non-JSON for {path}: {exc}")

    def _get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Any:
        return self._request("GET", path, params=params)

    def _get_absolute(self, url: str) -> Any:
        """GET a full URL OANDA handed back (the `/transactions` page links).

        Those URLs are already absolute and already carry their query string,
        so they can't go through `_request`'s base+path join. The host is
        pinned to this adapter's configured base first — a page link is
        venue-supplied data, and following it off-host would send the account
        token somewhere it doesn't belong.
        """
        if not url.startswith(f"{self._base}/"):
            raise HTTPException(
                502, "OANDA returned a transaction page URL off the configured host"
            )
        return self._request("GET", url[len(self._base) :])

    def _account_path(self, suffix: str) -> str:
        return f"/v3/accounts/{self._account_id}{suffix}"

    def _map_timeframe(self, timeframe: str) -> str:
        granularity = _TIMEFRAME_TO_GRANULARITY.get(timeframe)
        if granularity is None:
            raise HTTPException(400, f"timeframe '{timeframe}' is not supported on OANDA")
        return granularity

    # -- MarketDataAdapter ------------------------------------------------- #
    def search_contracts(self, request: Any) -> Dict[str, Any]:
        query = (getattr(request, "symbol", "") or "").upper()
        limit = getattr(request, "max_results", None) or 50
        payload = self._get(self._account_path("/instruments"))
        instruments = payload.get("instruments", []) if isinstance(payload, dict) else []
        matches = [i for i in instruments if query in (i.get("name") or "").upper()][:limit]
        results: List[Dict[str, Any]] = []
        for i in matches:
            instrument = i.get("name") or ""
            results.append(
                {
                    "conid": instrument,
                    "symbol": _from_instrument(instrument),
                    "companyName": i.get("displayName") or instrument,
                    "description": i.get("displayName") or instrument,
                    "secType": "CFD" if i.get("type") != "CURRENCY" else "CASH",
                    "exchange": "OANDA",
                    "currency": (instrument.split("_")[-1] if "_" in instrument else ""),
                    "broker": "oanda",
                }
            )
        return {"results": results, "count": len(results), "broker": "oanda"}

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
        granularity = self._map_timeframe(timeframe)
        instrument = _to_instrument(symbol)
        params: Dict[str, Any] = {"granularity": granularity, "price": "M"}
        if start_date and end_date:
            params["from"] = f"{start_date}T00:00:00Z"
            params["to"] = f"{end_date}T00:00:00Z"
        else:
            params["count"] = _PERIOD_TO_COUNT.get(period, 5000)

        payload = self._get(self._account_path(f"/instruments/{instrument}/candles"), params)
        raw_candles = payload.get("candles", []) if isinstance(payload, dict) else []

        rows = []
        for c in raw_candles:
            if not c.get("complete", True):
                continue
            mid = c.get("mid", {})
            ts = datetime.fromisoformat(str(c["time"]).replace("Z", "+00:00")).timestamp()
            rows.append(
                {
                    "timestamp": ts,
                    "open": float(mid["o"]),
                    "high": float(mid["h"]),
                    "low": float(mid["l"]),
                    "close": float(mid["c"]),
                    "volume": int(c.get("volume", 0) or 0),
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
        """Attach requested indicators with the same calculator every other
        venue uses, so charts render identically across all four brokers."""
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
        instrument = _to_instrument(symbol)
        payload = self._get(self._account_path("/pricing"), {"instruments": instrument})
        prices = payload.get("prices", []) if isinstance(payload, dict) else []
        p = prices[0] if prices else {}
        bids = p.get("bids") or [{}]
        asks = p.get("asks") or [{}]
        bid = _opt_float(bids[0].get("price"))
        ask = _opt_float(asks[0].get("price"))
        last = (bid + ask) / 2 if bid is not None and ask is not None else (bid or ask)
        return RealTimeQuote(
            symbol=symbol.upper(),
            bid=bid,
            ask=ask,
            last=last,
            volume=None,
            timestamp=_iso_from(p.get("time")),
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
            "broker": "oanda",
        }

    # -- BrokerAdapter (execution) ------------------------------------------ #
    def place_order(self, request: Any) -> Dict[str, Any]:
        """Place an order on OANDA. The same order validation + live-trading
        gate the IB path applies runs first (defence in depth, identical to
        IB/MT5/Alpaca) — a live order without `LIVE_TRADING_ENABLED` is
        refused here just as it is for the other venues, before anything
        reaches OANDA."""
        from orders import _validate_common  # shared gate; avoids an import cycle

        _validate_common(request.action, request.order_type, request.tif, request.account_mode)
        order_type = _ORDER_TYPE_TO_OANDA.get(request.order_type)
        if order_type is None:
            raise HTTPException(400, f"order_type '{request.order_type}' is not supported on OANDA")

        tif_map = _MARKET_TIF_TO_OANDA if order_type == "MARKET" else _TIF_TO_OANDA
        signed_units = request.quantity if request.action == "BUY" else -request.quantity
        order_body: Dict[str, Any] = {
            "type": order_type,
            "instrument": _to_instrument(request.symbol),
            "units": str(int(signed_units)),
            "timeInForce": tif_map[request.tif],
        }
        if order_type in ("LIMIT", "STOP"):
            price = request.limit_price if order_type == "LIMIT" else request.stop_price
            if price is None:
                raise HTTPException(400, f"a price is required for order_type={request.order_type}")
            order_body["price"] = str(price)
        client_id = client_order_id(getattr(request, "audit_id", None))
        if client_id:
            # Lets the fill be linked back to its audit row even if this call
            # times out before OANDA's order id is recorded.
            order_body["clientExtensions"] = {"id": client_id, "tag": "tradingapp"}
        # Protective stop / target attached to the trade at entry (E-2).
        # Distinct from `stop_price`, which is the *trigger* of a STOP order.
        # OANDA creates them atomically with the fill, or cancels the order.
        stop_loss = getattr(request, "stop_loss", None)
        take_profit = getattr(request, "take_profit", None)
        if stop_loss is not None or take_profit is not None:
            digits = self._price_precision(order_body["instrument"])
            if stop_loss is not None:
                order_body["stopLossOnFill"] = {
                    "price": _price(stop_loss, digits),
                    "timeInForce": "GTC",
                }
            if take_profit is not None:
                order_body["takeProfitOnFill"] = {
                    "price": _price(take_profit, digits),
                    "timeInForce": "GTC",
                }

        resp = self._request("POST", self._account_path("/orders"), json={"order": order_body})
        fill = resp.get("orderFillTransaction") or {}
        create = resp.get("orderCreateTransaction") or {}
        cancel = resp.get("orderCancelTransaction") or {}
        if cancel and not fill:
            # OANDA answers 201 for an order it created and then cancelled at
            # once: a FOK that could not fill, or a stop on the wrong side of
            # the fill price. Nothing is working, so it must not read as
            # submitted.
            raise HTTPException(
                422, f"OANDA cancelled the order: {cancel.get('reason') or 'no reason given'}"
            )
        order_id = fill.get("id") or create.get("id") or resp.get("lastTransactionID")
        status = "filled" if fill else "submitted"
        return {
            "order_id": order_id,
            "symbol": request.symbol.upper(),
            "action": request.action,
            "quantity": request.quantity,
            "order_type": request.order_type,
            "tif": request.tif,
            "account_mode": request.account_mode,
            "broker": "oanda",
            "status": status,
            # Echoed back so the caller can verify the venue recorded the
            # protection it asked for. Read from OANDA's own record of the
            # order, not from the request.
            "sl": _opt_float((create.get("stopLossOnFill") or {}).get("price")),
            "tp": _opt_float((create.get("takeProfitOnFill") or {}).get("price")),
        }

    def modify_position_stop(
        self,
        symbol: str,
        *,
        stop_loss: Optional[float] = None,
        take_profit: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Move an open position's protective stop (E-3's trail).

        OANDA holds a stop per trade, so this replaces the stop on every open
        trade that makes up the net position. A trade whose stop is already
        tighter keeps it: the ratchet never moves a stop backwards. The echoed
        ``sl`` is the least protective stop now in force, the same figure
        ``positions()`` reports.
        """
        instrument = _to_instrument(symbol)
        trades = self._open_trades(instrument)
        if not trades:
            raise HTTPException(404, f"no open OANDA trades for {symbol}")
        long_side = sum(t["units"] for t in trades) > 0
        direction = "long" if long_side else "short"
        trades = [t for t in trades if (t["units"] > 0) == long_side]
        digits = self._price_precision(instrument)

        stops: List[Optional[float]] = []
        targets: List[Optional[float]] = []
        for trade in trades:
            body: Dict[str, Any] = {}
            if stop_loss is not None and is_more_protective(
                stop_loss, trade["stop_loss"], direction
            ):
                body["stopLoss"] = {"price": _price(stop_loss, digits), "timeInForce": "GTC"}
            if take_profit is not None:
                body["takeProfit"] = {"price": _price(take_profit, digits), "timeInForce": "GTC"}
            if not body:
                stops.append(trade["stop_loss"])
                targets.append(trade["take_profit"])
                continue
            resp = self._request(
                "PUT", self._account_path(f"/trades/{trade['id']}/orders"), json=body
            )
            sl_tx = resp.get("stopLossOrderTransaction") or {}
            tp_tx = resp.get("takeProfitOrderTransaction") or {}
            stops.append(
                _opt_float(sl_tx.get("price")) if "stopLoss" in body else trade["stop_loss"]
            )
            targets.append(
                _opt_float(tp_tx.get("price")) if "takeProfit" in body else trade["take_profit"]
            )
        return {
            "symbol": symbol.upper(),
            "broker": "oanda",
            "status": "modified",
            "sl": _least_protective(stops, long_side),
            "tp": _first_to_hit(targets, long_side),
        }

    def _open_trades(self, instrument: Optional[str] = None) -> List[Dict[str, Any]]:
        """Open trades with the stop and target attached to each. A failed read
        raises: an empty list would read as "no trades, nothing unprotected"."""
        payload = self._get(self._account_path("/openTrades"))
        rows = payload.get("trades", []) if isinstance(payload, dict) else []
        trades: List[Dict[str, Any]] = []
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            if instrument is not None and row.get("instrument") != instrument:
                continue
            units = _opt_float(row.get("currentUnits"))
            if not units:
                continue
            sl = row.get("stopLossOrder") if isinstance(row.get("stopLossOrder"), dict) else {}
            tp = row.get("takeProfitOrder") if isinstance(row.get("takeProfitOrder"), dict) else {}
            trades.append(
                {
                    "id": str(row.get("id")),
                    "instrument": str(row.get("instrument") or ""),
                    "units": units,
                    "stop_loss": _opt_float(sl.get("price")),
                    "take_profit": _opt_float(tp.get("price")),
                }
            )
        return trades

    def _price_precision(self, instrument: str) -> int:
        """Decimals OANDA accepts on a price for this instrument. A price with
        more is rejected outright, so stops are rounded to this first."""
        cached = self._precision.get(instrument)
        if cached is not None:
            return cached
        payload = self._get(self._account_path("/instruments"), {"instruments": instrument})
        rows = payload.get("instruments", []) if isinstance(payload, dict) else []
        row = rows[0] if isinstance(rows, list) and rows and isinstance(rows[0], dict) else {}
        digits = row.get("displayPrecision")
        if digits is None:
            raise HTTPException(502, f"OANDA did not report the price precision of {instrument}")
        self._precision[instrument] = int(digits)
        return int(digits)

    def cancel_order(self, order_id: int) -> Dict[str, Any]:
        self._request("PUT", self._account_path(f"/orders/{order_id}/cancel"))
        return {"order_id": order_id, "broker": "oanda", "status": "cancel_requested"}

    def modify_order(self, order_id: int, request: Any) -> Dict[str, Any]:
        """OANDA has no in-place modify — a PUT to `/orders/{id}` replaces it
        (cancels the original, creates a new one), so the returned `order_id`
        may differ from the one passed in."""
        from orders import _validate_common

        tif = request.tif or "DAY"
        _validate_common(request.action, request.order_type, tif, request.account_mode)
        order_type = _ORDER_TYPE_TO_OANDA.get(request.order_type)
        if order_type is None:
            raise HTTPException(400, f"order_type '{request.order_type}' is not supported on OANDA")

        tif_map = _MARKET_TIF_TO_OANDA if order_type == "MARKET" else _TIF_TO_OANDA
        signed_units = request.quantity if request.action == "BUY" else -request.quantity
        order_body: Dict[str, Any] = {
            "type": order_type,
            "instrument": _to_instrument(request.symbol),
            "units": str(int(signed_units)),
            "timeInForce": tif_map[tif],
        }
        if order_type in ("LIMIT", "STOP"):
            price = request.limit_price if order_type == "LIMIT" else request.stop_price
            if price is not None:
                order_body["price"] = str(price)

        resp = self._request(
            "PUT", self._account_path(f"/orders/{order_id}"), json={"order": order_body}
        )
        create = resp.get("orderCreateTransaction") or {}
        new_order_id = create.get("id", order_id)
        return {"order_id": new_order_id, "broker": "oanda", "status": "modify_requested"}

    def positions(self) -> List[Dict[str, Any]]:
        """Open positions normalised to the app's ``models.Position`` shape.

        OANDA splits each instrument into independent ``long`` and ``short``
        legs (short ``units`` are already negative), so the two are netted into
        one signed size and the average price is taken from whichever leg is
        actually open — netting the *prices* would be meaningless. Instruments
        come back in OANDA's underscore form and are mapped to the app's dotted
        form, the inverse of what the request path does.
        """

        payload = self._get(self._account_path("/openPositions"))
        rows = payload.get("positions", []) if isinstance(payload, dict) else []
        trades = self._open_trades() if rows else []
        positions: List[Dict[str, Any]] = []
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            long_leg = row.get("long") if isinstance(row.get("long"), dict) else {}
            short_leg = row.get("short") if isinstance(row.get("short"), dict) else {}
            long_units = _opt_float(long_leg.get("units")) or 0.0
            short_units = _opt_float(short_leg.get("units")) or 0.0
            size = long_units + short_units
            if size == 0:
                continue
            open_leg = long_leg if size > 0 else short_leg
            instrument = str(row.get("instrument") or "")
            # The trades on the net side carry the protection; a hedged
            # opposite leg is not what the stop guards.
            legs = [
                t
                for t in trades
                if t["instrument"] == instrument and (t["units"] > 0) == (size > 0)
            ]
            positions.append(
                {
                    "symbol": _from_instrument(instrument),
                    "position": size,
                    "market_price": None,  # not carried on openPositions
                    "market_value": None,
                    "average_cost": _opt_float(open_leg.get("averagePrice")),
                    "unrealized_pnl": _opt_float(row.get("unrealizedPL")),
                    # The protection currently attached at the venue (E-2/E-3).
                    # The trail compares against this, and its absence on a
                    # position that should have one is a kill-switch trigger.
                    "stop_loss": _least_protective([t["stop_loss"] for t in legs], size > 0),
                    "take_profit": _first_to_hit([t["take_profit"] for t in legs], size > 0),
                    "currency": str(row.get("currency") or "USD"),
                }
            )
        return positions

    def account_summary(self) -> Dict[str, Any]:
        """Account state normalised to the app's ``models.AccountSummary``.

        OANDA's ``NAV`` is the net asset value — its name for net liquidation,
        and the figure `pct_equity` sizing needs. ``marginAvailable`` is the
        closest analogue to buying power; ``marginUsed`` to maintenance margin.
        """

        payload = self._get(self._account_path("/summary"))
        account = payload.get("account", payload) if isinstance(payload, dict) else {}
        if not isinstance(account, dict):
            account = {}
        return {
            "account_id": str(account.get("id") or self._account_id),
            "net_liquidation": _opt_float(account.get("NAV")),
            "currency": str(account.get("currency") or "USD"),
            "last_updated": datetime.now(UTC).isoformat(),
            "total_cash_value": _opt_float(account.get("balance")),
            "buying_power": _opt_float(account.get("marginAvailable")),
            "maintenance_margin": _opt_float(account.get("marginUsed")),
        }

    def open_orders(self) -> List[Dict[str, Any]]:
        """Pending orders normalised to the app's ``models.Order`` shape.

        OANDA has no side field — ``units`` is signed — so direction and size
        are split back out here, the inverse of what ``place_order`` does.
        """

        payload = self._get(self._account_path("/pendingOrders"))
        rows = payload.get("orders", []) if isinstance(payload, dict) else []
        orders: List[Dict[str, Any]] = []
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            units = _opt_float(row.get("units")) or 0.0
            orders.append(
                {
                    "order_id": str(row.get("id") or ""),
                    "symbol": _from_instrument(str(row.get("instrument") or "")),
                    "action": "SELL" if units < 0 else "BUY",
                    "quantity": abs(units),
                    "order_type": _OANDA_TO_ORDER_TYPE.get(
                        str(row.get("type") or ""), str(row.get("type") or "MKT").upper()
                    ),
                    "status": str(row.get("state") or "PENDING"),
                    "filled_quantity": None,
                    "remaining_quantity": abs(units),
                    "avg_fill_price": None,
                }
            )
        return orders

    def instrument_spec(self, symbol: str) -> Dict[str, Any]:
        """OANDA sizes in **units of the base currency**, so a "unit" already
        is one unit of the underlying — hence ``contract_size`` 1, unlike MT5's
        lots. What varies per instrument is the granularity:
        ``tradeUnitsPrecision`` gives the number of decimals allowed, which is
        the step, and ``minimumTradeSize`` the floor.
        """

        instrument = _to_instrument(symbol)
        payload = self._get(self._account_path("/instruments"), {"instruments": instrument})
        rows = payload.get("instruments", []) if isinstance(payload, dict) else []
        row = rows[0] if isinstance(rows, list) and rows else {}
        if not isinstance(row, dict):
            row = {}

        precision = _opt_float(row.get("tradeUnitsPrecision"))
        step = 10 ** -int(precision) if precision is not None else 1.0
        minimum = _opt_float(row.get("minimumTradeSize"))
        maximum = _opt_float(row.get("maximumOrderUnits"))
        return {
            "symbol": _from_instrument(instrument),
            "broker": "oanda",
            "unit": "units",
            "min_size": minimum if minimum and minimum > 0 else step,
            "size_step": step,
            "max_size": maximum,
            "contract_size": 1.0,
            "currency": instrument.split("_")[-1] if "_" in instrument else "USD",
        }

    def executions(self, days: int = 1) -> List[Dict[str, Any]]:
        """Recent fills, normalised to the app's ``models.Execution`` shape.

        A fill on OANDA is an ``ORDER_FILL`` transaction. The transactions
        endpoint does not return the transactions themselves — it returns a
        list of **page URLs** to fetch, so this walks those pages (capped, so a
        long window can't turn into an unbounded fan-out; the backend polls a
        short overlapping window anyway).

        Two OANDA-isms are absorbed here. ``units`` is signed rather than
        carrying a side, so the sign becomes ``side`` and the magnitude becomes
        ``quantity`` — the inverse of what ``place_order`` does. And OANDA
        reports commission as a positive ``commission`` alongside a separate
        ``financing`` charge; only the former is a trade cost, so financing is
        deliberately left out rather than folded into it.
        """

        start = (datetime.now(UTC) - timedelta(days=max(1, days))).isoformat()
        index = self._get(
            self._account_path("/transactions"),
            {"from": start, "type": "ORDER_FILL", "pageSize": 500},
        )
        pages = index.get("pages", []) if isinstance(index, dict) else []
        fills: List[Dict[str, Any]] = []
        for page_url in list(pages)[:_MAX_TRANSACTION_PAGES]:
            payload = self._get_absolute(str(page_url))
            transactions = payload.get("transactions", []) if isinstance(payload, dict) else []
            for row in transactions if isinstance(transactions, list) else []:
                if not isinstance(row, dict) or row.get("type") != "ORDER_FILL":
                    continue
                units = _opt_float(row.get("units"))
                price = _opt_float(row.get("price"))
                exec_id = str(row.get("id") or "")
                if not exec_id or units is None or units == 0 or price is None:
                    continue
                fills.append(
                    {
                        "exec_id": exec_id,
                        "order_id": str(row.get("orderID")) if row.get("orderID") else None,
                        "audit_id": audit_id_from(row.get("clientOrderID")),
                        "symbol": _from_instrument(str(row.get("instrument") or "")),
                        "side": "BUY" if units > 0 else "SELL",
                        "quantity": abs(units),
                        "price": price,
                        "commission": _opt_float(row.get("commission")),
                        "realized_pnl": _opt_float(row.get("pl")),
                        "executed_at": _iso_from(row.get("time")),
                        "account": str(row.get("accountID") or "") or None,
                        "currency": str(row.get("accountBalanceCurrency") or "USD"),
                        "broker": "oanda",
                    }
                )
        return fills


def _price(value: float, digits: int) -> str:
    """A price as OANDA wants it: a string with at most ``digits`` decimals."""
    return f"{float(value):.{digits}f}"


def _least_protective(stops: List[Optional[float]], long_side: bool) -> Optional[float]:
    """The stop that leaves the most at risk, or None when any trade has none
    (or there are no trades): one unprotected trade makes the position
    unprotected."""
    if not stops or any(s is None for s in stops):
        return None
    values = [s for s in stops if s is not None]
    return min(values) if long_side else max(values)


def _first_to_hit(targets: List[Optional[float]], long_side: bool) -> Optional[float]:
    """The nearest take profit, or None when any trade has none."""
    if not targets or any(t is None for t in targets):
        return None
    values = [t for t in targets if t is not None]
    return min(values) if long_side else max(values)


def _opt_float(v: Any) -> Optional[float]:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _iso_from(value: Any) -> str:
    """ISO-8601 UTC string from an OANDA RFC-3339 timestamp, defaulting to now."""
    if value is None:
        return datetime.now(UTC).isoformat()
    try:
        # OANDA timestamps carry nanosecond precision (e.g. ...123456789Z),
        # which fromisoformat can't parse directly — truncate to microseconds.
        s = str(value)
        if "." in s:
            head, frac = s.split(".", 1)
            frac = frac.rstrip("Z")[:6]
            s = f"{head}.{frac}+00:00"
        else:
            s = s.replace("Z", "+00:00")
        return datetime.fromisoformat(s).isoformat()
    except (ValueError, OSError):
        return datetime.now(UTC).isoformat()
