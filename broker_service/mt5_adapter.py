"""MetaTrader 5 adapter — market data (B2a) + execution (B2b).

The MetaTrader5 Python package is Windows-only and attaches to a running
terminal, so it can't `pip install` into this Linux service. Per the roadmap's
resolved Option A, MT5 runs as a **sidecar**: a small HTTP service on a Windows
host (running the terminal + `MetaTrader5`) that exposes bars / quotes / ticks.
This module is the **Linux-side thin HTTP client** — an implementation of the
`MarketDataAdapter` protocol that forwards to the sidecar at `MT5_BRIDGE_URL`
and normalises its responses into the app's shapes (UTC unix-second timestamps,
`CandlestickBar` / `RealTimeQuote`), so `source=mt5` charts and streams exactly
like `source=ib` from the frontend's point of view.

### Sidecar HTTP contract (documented here; implemented on the Windows host)

When `MT5_BRIDGE_SECRET` is set, every request below carries an
`X-MT5-Bridge-Secret: <secret>` header; the sidecar should reject any request
missing it or presenting the wrong value (shared-secret auth — the bridge has
no auth story otherwise, so anything that can reach it can trade the account).

    GET  {base}/health                                   -> {"status": "..."}
    GET  {base}/symbols?query=<q>&limit=<n>              -> {"results": [...], "count": n}
    GET  {base}/history?symbol=&timeframe=<MT5>&count=   -> {"bars": [{time,open,high,low,close,volume}, ...]}
             &start=<iso>&end=<iso>
    GET  {base}/quote?symbol=                            -> {bid, ask, last, volume, time}
    GET  {base}/tick?symbol=                             -> {bid, ask, last, volume, time, ...}
    POST   {base}/orders   {symbol,action,quantity,order_type,tif,...}  -> {order_id|ticket, status}
    DELETE {base}/orders/{id}                            -> {status}
    PUT    {base}/orders/{id}  {symbol,action,quantity,...}             -> {status}
    GET  {base}/positions                                -> {"positions": [...]} | [...]
    GET  {base}/account                                  -> {balance, equity, ...}

`timeframe` is sent in MT5's native form (`M1`, `H1`, `D1`, …); `time` fields
may be unix seconds/millis or ISO — all are coerced to unix **seconds**.

Both sides of the protocol are implemented: market data (B2a) **and** execution
(B2b). Order placement runs the same validation + live-trading gate as the IB
path (defence in depth) before it reaches the bridge, and results are shaped
like the IB path so `order_audit` reconciles uniformly.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Dict, List, Optional

import httpx
import pandas as pd
from fastapi import HTTPException

from indicators import calculator as indicator_calculator
from models import CandlestickBar, HistoricalDataResponse, RealTimeQuote
from observability import get_logger

logger = get_logger(__name__)

# App timeframe -> MT5 native timeframe. MT5 has no direct 8-hour; H8 exists on
# most builds, otherwise the sidecar may resample — the mapping is the contract.
_TIMEFRAME_TO_MT5 = {
    "1min": "M1",
    "5min": "M5",
    "15min": "M15",
    "30min": "M30",
    "1hour": "H1",
    "4hour": "H4",
    "8hour": "H8",
    "1day": "D1",
}

# Rough bar budget per app period, so the sidecar can bound its pull.
_PERIOD_TO_COUNT = {
    "1D": 400,
    "1W": 2000,
    "1M": 6000,
    "3M": 12000,
    "6M": 20000,
    "1Y": 40000,
}

_HTTP_TIMEOUT_SECONDS = 30.0
_SHARED_SECRET_HEADER = "X-MT5-Bridge-Secret"


def _to_unix_seconds(value: Any) -> float:
    """Coerce a sidecar timestamp (unix seconds, unix millis, or ISO-8601) into
    unix **seconds** (UTC), the app's canonical bar/quote time unit."""
    if value is None:
        raise ValueError("missing timestamp")
    if isinstance(value, (int, float)):
        v = float(value)
        # Heuristic: > 1e12 is milliseconds.
        return v / 1000.0 if v > 1_000_000_000_000 else v
    # String: try numeric first, then ISO-8601 (accept a trailing Z).
    s = str(value).strip()
    try:
        return _to_unix_seconds(float(s))
    except ValueError:
        pass
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.timestamp()


class MT5Adapter:
    """`MarketDataAdapter` + `BrokerAdapter` backed by the MT5 sidecar over HTTP."""

    name = "mt5"

    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = _HTTP_TIMEOUT_SECONDS,
        shared_secret: Optional[str] = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._timeout = timeout
        self._shared_secret = shared_secret or None

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
        headers = {_SHARED_SECRET_HEADER: self._shared_secret} if self._shared_secret else None
        try:
            with httpx.Client(timeout=self._timeout) as client:
                resp = client.request(
                    method,
                    url,
                    params={k: v for k, v in (params or {}).items() if v is not None},
                    json=json,
                    headers=headers,
                )
        except httpx.HTTPError as exc:
            logger.error("mt5_bridge_unreachable", url=url, method=method, error=str(exc))
            raise HTTPException(503, f"MT5 bridge unreachable: {exc}")
        if resp.status_code >= 400:
            raise HTTPException(
                502, f"MT5 bridge error {resp.status_code} for {path}: {resp.text[:200]}"
            )
        try:
            return resp.json()
        except ValueError as exc:
            raise HTTPException(502, f"MT5 bridge returned non-JSON for {path}: {exc}")

    def _get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Any:
        return self._request("GET", path, params=params)

    def _map_timeframe(self, timeframe: str) -> str:
        mt5_tf = _TIMEFRAME_TO_MT5.get(timeframe)
        if mt5_tf is None:
            raise HTTPException(400, f"timeframe '{timeframe}' is not supported on MT5")
        return mt5_tf

    # -- MarketDataAdapter ------------------------------------------------- #
    def search_contracts(self, request: Any) -> Dict[str, Any]:
        symbol = getattr(request, "symbol", "") or ""
        limit = getattr(request, "max_results", None)
        payload = self._get("/symbols", {"query": symbol.upper(), "limit": limit})
        results = payload.get("results", []) if isinstance(payload, dict) else []
        # Normalise to the same result shape the contract-search UI consumes,
        # tagging each with broker=mt5 (broker-scoped catalogues, no collision).
        norm: List[Dict[str, Any]] = []
        for r in results:
            sym = r.get("symbol") or r.get("name") or ""
            norm.append(
                {
                    "conid": str(r.get("conid") or r.get("id") or sym),
                    "symbol": sym,
                    "companyName": r.get("description") or r.get("companyName") or sym,
                    "description": r.get("description") or sym,
                    "secType": r.get("secType") or "CFD",
                    "exchange": r.get("exchange") or "MT5",
                    "currency": r.get("currency") or "",
                    "broker": "mt5",
                }
            )
        return {"results": norm, "count": len(norm), "broker": "mt5"}

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
        mt5_tf = self._map_timeframe(timeframe)
        params: Dict[str, Any] = {"symbol": symbol.upper(), "timeframe": mt5_tf}
        if start_date and end_date:
            params["start"] = start_date
            params["end"] = end_date
        else:
            params["count"] = _PERIOD_TO_COUNT.get(period, 40000)

        payload = self._get("/history", params)
        raw_bars = payload.get("bars", []) if isinstance(payload, dict) else []

        rows = []
        for b in raw_bars:
            ts = _to_unix_seconds(b.get("time", b.get("timestamp")))
            rows.append(
                {
                    "timestamp": ts,
                    "open": float(b["open"]),
                    "high": float(b["high"]),
                    "low": float(b["low"]),
                    "close": float(b["close"]),
                    "volume": int(b.get("volume", b.get("tick_volume", 0)) or 0),
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
        """Attach requested indicators, computed with the same calculator the IB
        path uses, so `source=mt5` and `source=ib` charts render identically."""
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
        q = self._get("/quote", {"symbol": symbol.upper()})
        return RealTimeQuote(
            symbol=symbol.upper(),
            bid=_opt_float(q.get("bid")),
            ask=_opt_float(q.get("ask")),
            last=_opt_float(q.get("last")),
            volume=_opt_int(q.get("volume")),
            timestamp=_iso_from(q.get("time")),
        )

    def tick(self, symbol: str, account_mode: str = "paper") -> Dict[str, Any]:
        t = self._get("/tick", {"symbol": symbol.upper()})
        return {
            "symbol": symbol.upper(),
            "timestamp": _iso_from(t.get("time")),
            "bid": t.get("bid"),
            "ask": t.get("ask"),
            "last": t.get("last"),
            "volume": t.get("volume"),
            "broker": "mt5",
        }

    # -- BrokerAdapter (execution) — B2b ----------------------------------- #
    def place_order(self, request: Any) -> Dict[str, Any]:
        """Place an order on MT5 via the sidecar. The same order validation +
        live-trading gate the IB path applies runs first (defence in depth,
        identical to IB) — so a live order without ``LIVE_TRADING_ENABLED`` is
        refused here just as it is for IB, before anything reaches the bridge."""
        from orders import _validate_common  # shared gate; avoids an import cycle

        _validate_common(request.action, request.order_type, request.tif, request.account_mode)
        body = {
            "symbol": request.symbol.upper(),
            "action": request.action,
            "quantity": request.quantity,
            "order_type": request.order_type,
            "tif": request.tif,
            "limit_price": request.limit_price,
            "stop_price": request.stop_price,
            "account_mode": request.account_mode,
            "audit_id": getattr(request, "audit_id", None),
        }
        resp = self._request("POST", "/orders", json=body)
        # Shape the result like the IB path so order_audit reconciles uniformly.
        return {
            "order_id": resp.get("order_id") or resp.get("ticket") or resp.get("id"),
            "symbol": request.symbol.upper(),
            "action": request.action,
            "quantity": request.quantity,
            "order_type": request.order_type,
            "tif": request.tif,
            "account_mode": request.account_mode,
            "broker": "mt5",
            "status": resp.get("status", "submitted"),
        }

    def cancel_order(self, order_id: int) -> Dict[str, Any]:
        resp = self._request("DELETE", f"/orders/{order_id}")
        return {
            "order_id": order_id,
            "broker": "mt5",
            "status": resp.get("status", "cancel_requested"),
        }

    def modify_order(self, order_id: int, request: Any) -> Dict[str, Any]:
        from orders import _validate_common

        _validate_common(
            request.action, request.order_type, request.tif or "DAY", request.account_mode
        )
        body = {
            "symbol": request.symbol.upper(),
            "action": request.action,
            "quantity": request.quantity,
            "order_type": request.order_type,
            "tif": request.tif or "DAY",
            "limit_price": request.limit_price,
            "stop_price": request.stop_price,
            "account_mode": request.account_mode,
        }
        resp = self._request("PUT", f"/orders/{order_id}", json=body)
        return {
            "order_id": order_id,
            "broker": "mt5",
            "status": resp.get("status", "modify_requested"),
        }

    def positions(self) -> List[Dict[str, Any]]:
        """Open positions normalised to the app's ``models.Position`` shape.

        The sidecar is out-of-repo, so the field names are read defensively:
        MT5's own ``PositionInfo`` uses ``volume`` / ``price_open`` / ``profit``
        with ``type`` 0=buy 1=sell, while a sidecar that already speaks the
        app's vocabulary may send ``position`` / ``average_cost`` directly.
        Both are accepted; an unsigned ``volume`` is signed from ``type``.
        """

        payload = self._get("/positions")
        rows = payload.get("positions", payload) if isinstance(payload, dict) else payload
        positions: List[Dict[str, Any]] = []
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            size = _opt_float(row.get("position"))
            if size is None:
                size = _opt_float(row.get("volume"))
                # MT5 reports volume unsigned with the direction in `type`.
                if size is not None and _opt_int(row.get("type")) == 1:
                    size = -size
            if size is None or size == 0:
                continue
            positions.append(
                {
                    "symbol": str(row.get("symbol") or "").upper(),
                    "position": size,
                    "market_price": _opt_float(row.get("price_current") or row.get("market_price")),
                    "market_value": _opt_float(row.get("market_value")),
                    "average_cost": _opt_float(
                        row.get("price_open")
                        if row.get("price_open") is not None
                        else row.get("average_cost")
                    ),
                    "unrealized_pnl": _opt_float(
                        row.get("profit")
                        if row.get("profit") is not None
                        else row.get("unrealized_pnl")
                    ),
                    "currency": str(row.get("currency") or "USD"),
                }
            )
        return positions

    def account_summary(self) -> Dict[str, Any]:
        """Account state normalised to the app's ``models.AccountSummary``.

        MT5's ``equity`` is net liquidation (balance plus floating P&L) — the
        figure `pct_equity` sizing needs. Read defensively like the rest of the
        sidecar contract: a bridge that already speaks the app's vocabulary is
        accepted alongside MT5's own ``AccountInfo`` field names.
        """

        payload = self._get("/account")
        account = payload if isinstance(payload, dict) else {}
        return {
            "account_id": str(account.get("account_id") or account.get("login") or "mt5"),
            "net_liquidation": _opt_float(
                account.get("net_liquidation")
                if account.get("net_liquidation") is not None
                else account.get("equity")
            ),
            "currency": str(account.get("currency") or "USD"),
            "last_updated": datetime.now(UTC).isoformat(),
            "total_cash_value": _opt_float(account.get("balance")),
            "buying_power": _opt_float(
                account.get("buying_power")
                if account.get("buying_power") is not None
                else account.get("margin_free")
            ),
            "maintenance_margin": _opt_float(
                account.get("maintenance_margin")
                if account.get("maintenance_margin") is not None
                else account.get("margin")
            ),
        }

    def open_orders(self) -> List[Dict[str, Any]]:
        """Working orders normalised to the app's ``models.Order`` shape.

        MT5 order types 0/2/4/6 are buys and 1/3/5/7 are sells (the pairs are
        market / limit / stop / stop-limit), so direction is the low bit when
        the sidecar hasn't already translated it.
        """

        payload = self._get("/orders")
        rows = payload.get("orders", payload) if isinstance(payload, dict) else payload
        orders: List[Dict[str, Any]] = []
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            quantity = _opt_float(row.get("quantity"))
            if quantity is None:
                quantity = _opt_float(row.get("volume_current") or row.get("volume_initial")) or 0.0
            action = str(row.get("action") or "").upper()
            if action not in ("BUY", "SELL"):
                order_type = _opt_int(row.get("type"))
                action = "SELL" if order_type is not None and order_type % 2 == 1 else "BUY"
            orders.append(
                {
                    "order_id": str(row.get("order_id") or row.get("ticket") or ""),
                    "symbol": str(row.get("symbol") or "").upper(),
                    "action": action,
                    "quantity": abs(quantity),
                    "order_type": str(row.get("order_type") or "MKT").upper(),
                    "status": str(row.get("status") or row.get("state") or "working"),
                    "filled_quantity": _opt_float(row.get("filled_quantity")),
                    "remaining_quantity": _opt_float(row.get("remaining_quantity")),
                    "avg_fill_price": _opt_float(
                        row.get("avg_fill_price") or row.get("price_current")
                    ),
                }
            )
        return orders

    def executions(self, days: int = 1) -> List[Dict[str, Any]]:
        """Recent fills, normalised to the app's ``models.Execution`` shape.

        MT5 calls a fill a *deal* (``history_deals_get``). The sidecar is
        out-of-repo, so — as with ``positions()`` — the payload is read
        defensively: either MT5's native ``TradeDeal`` vocabulary (``ticket`` /
        ``order`` / ``volume`` / ``price`` / ``commission`` / ``profit``, with
        the direction in ``type`` where 0=buy 1=sell and ``time`` a unix epoch),
        or the app's own field names if the sidecar already speaks them.

        MT5 deals include non-trade entries (balance adjustments, credits,
        ``type`` >= 2) which have no symbol and are not fills; those are
        dropped rather than folded into the position.
        """

        payload = self._get("/deals", {"days": max(1, days)})
        rows = payload.get("deals", payload) if isinstance(payload, dict) else payload
        if isinstance(rows, dict):
            rows = rows.get("executions", [])
        fills: List[Dict[str, Any]] = []
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            exec_id = str(row.get("exec_id") or row.get("ticket") or row.get("deal") or "")
            symbol = str(row.get("symbol") or "").upper()
            quantity = _opt_float(row.get("quantity"))
            if quantity is None:
                quantity = _opt_float(row.get("volume"))
            price = _opt_float(row.get("price"))
            if not exec_id or not symbol or not quantity or price is None:
                continue

            side = str(row.get("side") or "").upper()
            if side not in ("BUY", "SELL"):
                deal_type = _opt_int(row.get("type"))
                if deal_type is not None and deal_type > 1:
                    continue  # balance/credit/charge entry, not a trade
                side = "SELL" if deal_type == 1 else "BUY"

            fills.append(
                {
                    "exec_id": exec_id,
                    "order_id": str(row.get("order")) if row.get("order") else None,
                    "symbol": symbol,
                    "side": side,
                    "quantity": abs(quantity),
                    "price": price,
                    "commission": _opt_float(row.get("commission")),
                    "realized_pnl": _opt_float(
                        row.get("profit")
                        if row.get("profit") is not None
                        else row.get("realized_pnl")
                    ),
                    "executed_at": _iso_from(row.get("executed_at") or row.get("time")),
                    "account": str(row.get("account") or "") or None,
                    "currency": str(row.get("currency") or "USD"),
                    "broker": "mt5",
                }
            )
        return fills


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
    """ISO-8601 UTC string from a sidecar time value, defaulting to now."""
    if value is None:
        return datetime.now(UTC).isoformat()
    try:
        return datetime.fromtimestamp(_to_unix_seconds(value), tz=UTC).isoformat()
    except (ValueError, OSError):
        return datetime.now(UTC).isoformat()
