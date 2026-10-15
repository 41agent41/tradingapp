"""Live prices from brokers other than IB.

IB pushes ticks into :mod:`streaming` through ``reqMktData``. Every other
broker is served here, on one background thread per connection, publishing
through the same :class:`streaming.StreamingManager` so ticks land on the
same ``marketdata:tick:<SYMBOL>`` channel in the same shape, and the backend
and charts work unchanged whichever broker is the default:

- an adapter with ``stream_prices`` (OANDA's pricing stream) is streamed;
  the stream restarts whenever the set of symbols on that connection changes;
- any other adapter is polled with ``tick()`` every
  ``STREAM_POLL_SECONDS`` (default 2, set on the Settings page), which every
  adapter implements.

A failure never ends a worker: it records the error (shown on
``/market-data/stream/status``), waits, and tries again. The adapter is
looked up afresh on every attempt, so a connection edited on the Settings
page is picked up without resubscribing.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional, Set, Tuple

import app_settings
from observability import get_logger

logger = get_logger(__name__)

RETRY_SECONDS = 5.0

ConnectionKey = Tuple[str, str]  # (platform, account)


@dataclass
class VenueSubscription:
    symbol: str
    platform: str
    account: str
    ref_count: int = 0
    started_at: float = field(default_factory=time.time)
    tick_count: int = 0
    last_tick_at: Optional[float] = None
    last_error: Optional[str] = None


class _Worker:
    """One thread serving every subscribed symbol on one connection."""

    def __init__(self, streamer: VenueStreamer, key: ConnectionKey) -> None:
        self.streamer = streamer
        self.key = key
        self.stop = threading.Event()
        self.changed = threading.Event()
        self.thread = threading.Thread(
            target=self._run, name=f"venue-stream-{key[0]}-{key[1]}", daemon=True
        )

    def start(self) -> None:
        self.thread.start()

    def _run(self) -> None:
        while not self.stop.is_set():
            symbols = self.streamer.symbols_for(self.key, self)
            if not symbols:
                return
            self.changed.clear()
            try:
                adapter = self.streamer.adapter_for(self.key)
                if hasattr(adapter, "stream_prices"):
                    adapter.stream_prices(
                        sorted(symbols),
                        self._on_price,
                        lambda: self.stop.is_set() or self.changed.is_set(),
                    )
                    if not (self.stop.is_set() or self.changed.is_set()):
                        # The venue closed the stream; reopen after a pause.
                        self.stop.wait(RETRY_SECONDS)
                else:
                    self._poll_once(adapter, symbols)
                    self.stop.wait(self.streamer.poll_seconds)
            except Exception as exc:  # noqa: BLE001 — a worker must outlive any failure
                self.streamer.record_error(self.key, symbols, exc)
                self.stop.wait(RETRY_SECONDS)

    def _poll_once(self, adapter: Any, symbols: Set[str]) -> None:
        for symbol in sorted(symbols):
            if self.stop.is_set():
                return
            try:
                tick = adapter.tick(symbol)
            except Exception as exc:  # noqa: BLE001 — one bad symbol must not stop the rest
                self.streamer.record_error(self.key, {symbol}, exc)
                continue
            self.streamer.publish(
                symbol, bid=tick.get("bid"), ask=tick.get("ask"), last=tick.get("last")
            )

    def _on_price(self, symbol: str, bid: Optional[float], ask: Optional[float]) -> None:
        last = (bid + ask) / 2 if bid is not None and ask is not None else (bid or ask)
        self.streamer.publish(symbol, bid=bid, ask=ask, last=last)


class VenueStreamer:
    """Refcounted live-price subscriptions on non-IB connections."""

    def __init__(
        self,
        publish_tick: Optional[Callable[..., None]] = None,
        resolve_adapter: Optional[Callable[[str, str], Any]] = None,
        poll_seconds: Optional[float] = None,
    ) -> None:
        self._publish_tick = publish_tick
        self._resolve_adapter = resolve_adapter
        self._poll_seconds = poll_seconds
        self._subs: Dict[str, VenueSubscription] = {}
        self._workers: Dict[ConnectionKey, _Worker] = {}
        self._lock = threading.Lock()

    @property
    def poll_seconds(self) -> float:
        """The fixed interval given, else STREAM_POLL_SECONDS, read on every wait
        so a change on the Settings page applies without a restart."""
        if self._poll_seconds is not None:
            return self._poll_seconds
        return app_settings.stream_poll_seconds()

    # -- wiring (defaults resolved lazily to keep imports light) ----------- #
    def adapter_for(self, key: ConnectionKey) -> Any:
        if self._resolve_adapter is not None:
            return self._resolve_adapter(*key)
        from adapters import get_market_data_adapter

        return get_market_data_adapter(*key)

    def _tick(self, *args: Any, **kwargs: Any) -> None:
        if self._publish_tick is not None:
            self._publish_tick(*args, **kwargs)
            return
        from streaming import streaming_manager

        streaming_manager.publish_tick(*args, **kwargs)

    # -- public API --------------------------------------------------------- #
    def holds(self, symbol: str) -> bool:
        with self._lock:
            return symbol.upper().strip() in self._subs

    def retain(self, symbol: str) -> Optional[VenueSubscription]:
        """Take another reference on a symbol already streaming, or None."""
        with self._lock:
            sub = self._subs.get(symbol.upper().strip())
            if sub is not None:
                sub.ref_count += 1
            return sub

    def subscribe(self, symbol: str, platform: str, account: str) -> VenueSubscription:
        symbol = symbol.upper().strip()
        if not symbol:
            raise ValueError("symbol is required")
        key = (platform, account)
        with self._lock:
            sub = self._subs.get(symbol)
            if sub is not None:
                sub.ref_count += 1
                return sub
            sub = VenueSubscription(symbol=symbol, platform=platform, account=account, ref_count=1)
            self._subs[symbol] = sub
            self._wake(key)
        logger.info("venue_stream_started", symbol=symbol, connection=f"{platform}:{account}")
        return sub

    def unsubscribe(self, symbol: str) -> Optional[VenueSubscription]:
        symbol = symbol.upper().strip()
        with self._lock:
            sub = self._subs.get(symbol)
            if sub is None:
                return None
            sub.ref_count = max(0, sub.ref_count - 1)
            if sub.ref_count > 0:
                return sub
            self._subs.pop(symbol, None)
            self._wake((sub.platform, sub.account))
        logger.info("venue_stream_stopped", symbol=symbol)
        return sub

    def stop_all(self) -> None:
        with self._lock:
            self._subs.clear()
            workers = list(self._workers.values())
            self._workers.clear()
        for w in workers:
            w.stop.set()
        for w in workers:
            w.thread.join(timeout=2)

    def status(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "poll_seconds": self.poll_seconds,
                "subscriptions": [
                    {
                        "symbol": s.symbol,
                        "connection": f"{s.platform}:{s.account}",
                        "ref_count": s.ref_count,
                        "started_at": s.started_at,
                        "tick_count": s.tick_count,
                        "last_tick_at": s.last_tick_at,
                        "last_error": s.last_error,
                    }
                    for s in self._subs.values()
                ],
            }

    # -- used by workers ---------------------------------------------------- #
    def symbols_for(self, key: ConnectionKey, worker: Optional[_Worker] = None) -> Set[str]:
        with self._lock:
            symbols = {s.symbol for s in self._subs.values() if (s.platform, s.account) == key}
            if not symbols and worker is not None and self._workers.get(key) is worker:
                # Nothing left: retire the worker under the lock, so a
                # subscribe racing with this starts a fresh one.
                self._workers.pop(key)
                worker.stop.set()
            return symbols

    def publish(
        self,
        symbol: str,
        *,
        bid: Optional[float] = None,
        ask: Optional[float] = None,
        last: Optional[float] = None,
    ) -> None:
        with self._lock:
            sub = self._subs.get(symbol)
            if sub is None:
                return
            sub.tick_count += 1
            sub.last_tick_at = time.time()
            sub.last_error = None
            source = sub.platform
        for name, value in (("BID", bid), ("ASK", ask), ("LAST", last)):
            if value is not None:
                self._tick(symbol, name, price=value, source=source)

    def record_error(self, key: ConnectionKey, symbols: Set[str], exc: BaseException) -> None:
        detail = getattr(exc, "detail", None)
        message = str(detail if detail is not None else exc)[:300] or type(exc).__name__
        with self._lock:
            changed = False
            for symbol in symbols:
                sub = self._subs.get(symbol)
                if sub is not None:
                    changed = changed or sub.last_error != message
                    sub.last_error = message
        if changed:
            logger.warning("venue_stream_error", connection=f"{key[0]}:{key[1]}", error=message)

    # -- internal ----------------------------------------------------------- #
    def _wake(self, key: ConnectionKey) -> None:
        """Start the connection's worker, or tell it the symbol set changed.
        Call with the lock held."""
        worker = self._workers.get(key)
        if worker is not None and worker.thread.is_alive() and not worker.stop.is_set():
            worker.changed.set()
            return
        worker = _Worker(self, key)
        self._workers[key] = worker
        worker.start()


venue_streamer = VenueStreamer()
