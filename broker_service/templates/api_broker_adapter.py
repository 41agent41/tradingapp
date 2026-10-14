"""Template for a new API broker's adapter. See ../ADDING_A_BROKER.md.

Copy to ``broker_service/<name>_adapter.py``, rename ``ExampleAdapter`` and
``"example"``, and fill in each method. ``oanda_adapter.py`` is the worked
example to follow: every shape below is the one it returns.

Conventions every adapter keeps:

- Errors are ``HTTPException``: 503 when the venue cannot be reached, 502
  when it answers with an error, 400 for a request it can never serve (an
  unsupported timeframe or order type). Market data falls back to the next
  broker on 5xx, never on 4xx (``adapters.falls_back``).
- Symbols arrive in the app's form (``EUR.USD``, ``AAPL``) and leave in it;
  translate to the venue's form inside the adapter.
- ``place_order`` runs ``orders._validate_common`` first, so the live-trading
  gate holds here too, and tags the order with ``client_order_id`` so a retry
  cannot place it twice.
- Nothing here talks to another broker: orders never switch broker.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

import httpx
from fastapi import HTTPException

from observability import get_logger

logger = get_logger(__name__)

_HTTP_TIMEOUT_SECONDS = 30.0


class ExampleAdapter:
    """``MarketDataAdapter`` + ``BrokerAdapter`` for the Example REST API."""

    name = "example"  # the platform name, as in connections.SUPPORTED_PLATFORMS
    # True when a stop can be attached to the entry order itself (the stop
    # then cannot be missed); False makes the app place the stop after the fill.
    attaches_stops = False

    def __init__(self, api_token: str, account_id: str, *, environment: str = "practice") -> None:
        self._base = (
            "https://api.example.com" if environment == "live" else "https://demo.example.com"
        )
        self._account_id = account_id
        self._headers = {"Authorization": f"Bearer {api_token}"}

    # -- HTTP plumbing ----------------------------------------------------- #
    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            with httpx.Client(timeout=_HTTP_TIMEOUT_SECONDS) as client:
                resp = client.request(
                    method, f"{self._base}{path}", headers=self._headers, **kwargs
                )
        except httpx.HTTPError as exc:
            raise HTTPException(503, f"Example unreachable: {exc}")
        if resp.status_code >= 400:
            raise HTTPException(502, f"Example error {resp.status_code}: {resp.text[:200]}")
        return resp.json()

    # -- Connectivity check (probes.py) ------------------------------------ #
    def probe(self) -> None:
        """The cheapest authenticated, read-only call; raise if it fails.
        Runs every BROKER_PROBE_INTERVAL_SECONDS and on the Settings Test button."""
        self._request("GET", f"/accounts/{self._account_id}")

    # -- MarketDataAdapter ------------------------------------------------- #
    def search_contracts(self, request: Any) -> Dict[str, Any]:
        """``{"results": [{conid, symbol, companyName, description, secType,
        exchange, currency, broker}], "count": n, "broker": name}``."""
        raise NotImplementedError

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
    ) -> Any:
        """A ``models.HistoricalDataResponse``; reuse ``indicators.calculator``
        for ``indicators`` exactly as OANDAAdapter.historical_bars does."""
        raise NotImplementedError

    def realtime_quote(self, symbol: str, account_mode: str = "paper") -> Any:
        """A ``models.RealTimeQuote`` (symbol, bid, ask, last, volume, timestamp)."""
        raise NotImplementedError

    def tick(self, symbol: str, account_mode: str = "paper") -> Dict[str, Any]:
        """``{symbol, timestamp, bid, ask, last, volume, broker}``. Live prices
        poll this every STREAM_POLL_SECONDS unless ``stream_prices`` exists."""
        raise NotImplementedError

    # Optional: implement when the venue has a push price feed, and live
    # prices stream from it instead of polling ``tick`` (venue_streaming.py).
    def stream_prices(
        self,
        symbols: List[str],
        on_price: Callable[[str, Optional[float], Optional[float]], None],
        should_stop: Callable[[], bool],
    ) -> None:
        """Call ``on_price(symbol, bid, ask)`` per update until ``should_stop()``.
        Delete this method if the venue has no stream."""
        raise NotImplementedError

    # -- BrokerAdapter ------------------------------------------------------ #
    def place_order(self, request: Any) -> Dict[str, Any]:
        """Validate with ``orders._validate_common`` first, then place. Return
        ``{order_id, symbol, action, quantity, order_type, tif, ...}`` as
        OANDAAdapter.place_order does."""
        raise NotImplementedError

    def cancel_order(self, order_id: int) -> Dict[str, Any]:
        raise NotImplementedError

    def modify_order(self, order_id: int, request: Any) -> Dict[str, Any]:
        raise NotImplementedError

    def positions(self) -> List[Dict[str, Any]]:
        """``models.Position`` dicts."""
        raise NotImplementedError

    def account_summary(self) -> Dict[str, Any]:
        """``models.AccountSummary`` dict. ``net_liquidation`` is the equity
        that ``pct_equity`` sizing divides by, so it must be in ``currency``."""
        raise NotImplementedError

    def open_orders(self) -> List[Dict[str, Any]]:
        """``models.Order`` dicts."""
        raise NotImplementedError

    def executions(self, days: int = 1) -> List[Dict[str, Any]]:
        """``models.Execution`` dicts; fills reconcile the order lifecycle."""
        raise NotImplementedError

    def instrument_spec(self, symbol: str) -> Dict[str, Any]:
        """``models.InstrumentSpec``: what a quantity of 1 is here (``unit``,
        ``contract_size``) and the smallest size and step (``min_size``,
        ``size_step``) that order sizing floors to."""
        raise NotImplementedError
