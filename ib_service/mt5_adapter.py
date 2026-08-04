"""MetaTrader 5 market-data adapter (Systematic Trading roadmap — B2a).

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

    GET  {base}/health                                   -> {"status": "..."}
    GET  {base}/symbols?query=<q>&limit=<n>              -> {"results": [...], "count": n}
    GET  {base}/history?symbol=&timeframe=<MT5>&count=   -> {"bars": [{time,open,high,low,close,volume}, ...]}
             &start=<iso>&end=<iso>
    GET  {base}/quote?symbol=                            -> {bid, ask, last, volume, time}
    GET  {base}/tick?symbol=                             -> {bid, ask, last, volume, time, ...}

`timeframe` is sent in MT5's native form (`M1`, `H1`, `D1`, …); `time` fields
may be unix seconds/millis or ISO — all are coerced to unix **seconds**.

The MT5 execution/broker side (`place_order` et al.) is **not** implemented here
— that is B2b. This adapter is data-only.
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
    """Data-only `MarketDataAdapter` backed by the MT5 sidecar over HTTP."""

    name = "mt5"

    def __init__(self, base_url: str, *, timeout: float = _HTTP_TIMEOUT_SECONDS) -> None:
        self._base = base_url.rstrip("/")
        self._timeout = timeout

    # -- HTTP plumbing ----------------------------------------------------- #
    def _get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Any:
        url = f"{self._base}{path}"
        try:
            with httpx.Client(timeout=self._timeout) as client:
                resp = client.get(
                    url, params={k: v for k, v in (params or {}).items() if v is not None}
                )
        except httpx.HTTPError as exc:
            logger.error("mt5_bridge_unreachable", url=url, error=str(exc))
            raise HTTPException(503, f"MT5 bridge unreachable: {exc}")
        if resp.status_code >= 400:
            raise HTTPException(
                502, f"MT5 bridge error {resp.status_code} for {path}: {resp.text[:200]}"
            )
        try:
            return resp.json()
        except ValueError as exc:
            raise HTTPException(502, f"MT5 bridge returned non-JSON for {path}: {exc}")

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
