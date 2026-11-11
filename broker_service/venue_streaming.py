"""Live prices from brokers other than IB.

IB pushes ticks into :mod:`streaming` through ``reqMktData``. Every other
broker is served here, on one background thread per connection, publishing
through the same :class:`streaming.StreamingManager` so ticks land on the
``marketdata:tick:<platform>:<account>:<SYMBOL>`` channel in the same shape
as IB's. A subscription belongs to one connection, so the same symbol can
stream from two firms at once (docs/plans/E-05-live-recorder.md, D3):

- an adapter with ``stream_prices`` (OANDA's pricing stream, IG's
  Lightstreamer prices) is streamed;
  the stream restarts whenever the set of symbols on that connection changes;
- any other adapter is polled with ``tick()`` every
  ``STREAM_POLL_SECONDS`` (default 2, set on the Settings page), which every
  adapter implements.

A failure never ends a worker: it records the error (shown on
``/market-data/stream/status``), waits, and tries again. The adapter is
looked up afresh on every attempt, so a connection edited on the Settings
page is picked up without resubscribing.

A subscription is held two ways: by reference counts (charts, through the
backend bridge) and by the recorded set (the backend's live recorder, which
sends the whole set it wants and re-sends it on a timer). It streams while
either holds it.
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
SubKey = Tuple[str, str, str]  # (platform, account, symbol)


@dataclass
class VenueSubscription:
    symbol: str
    platform: str
    account: str
    ref_count: int = 0
    # Held by the live recorder, whatever the reference count.
    recorded: bool = False
    # The price the venue builds its own bars from; read from the adapter's
    # ``bar_basis`` at the first recorded quote.
    basis: Optional[str] = None
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
                symbol, self.key, bid=tick.get("bid"), ask=tick.get("ask"), last=tick.get("last")
            )

    def _on_price(self, symbol: str, bid: Optional[float], ask: Optional[float]) -> None:
        last = (bid + ask) / 2 if bid is not None and ask is not None else (bid or ask)
        self.streamer.publish(symbol, self.key, bid=bid, ask=ask, last=last)


class VenueStreamer:
    """Refcounted live-price subscriptions on non-IB connections."""

    def __init__(
        self,
        publish_tick: Optional[Callable[..., None]] = None,
        resolve_adapter: Optional[Callable[[str, str], Any]] = None,
        poll_seconds: Optional[float] = None,
        publish_quote: Optional[Callable[..., Any]] = None,
        forget_quote: Optional[Callable[[str, str, str], None]] = None,
    ) -> None:
        self._publish_quote = publish_quote
        self._forget_quote = forget_quote
        self._publish_tick = publish_tick
        self._resolve_adapter = resolve_adapter
        self._poll_seconds = poll_seconds
        self._subs: Dict[SubKey, VenueSubscription] = {}
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

    def _quote(self, *args: Any, **kwargs: Any) -> None:
        if self._publish_quote is not None:
            self._publish_quote(*args, **kwargs)
            return
        from streaming import streaming_manager

        streaming_manager.add_quote(*args, **kwargs)

    def _forget(self, platform: str, account: str, symbol: str) -> None:
        if self._forget_quote is not None:
            self._forget_quote(platform, account, symbol)
            return
        if self._publish_quote is not None:
            return
        from streaming import streaming_manager

        streaming_manager.forget_quote(platform, account, symbol)

    # -- public API --------------------------------------------------------- #
    def find(
        self, symbol: str, platform: Optional[str] = None, account: Optional[str] = None
    ) -> Optional[VenueSubscription]:
        """The subscription for ``symbol``: on the connection named, or, with
        none named, on any connection (the one started first)."""
        symbol = symbol.upper().strip()
        with self._lock:
            return self._find(symbol, platform, account)

    def _find(
        self, symbol: str, platform: Optional[str], account: Optional[str]
    ) -> Optional[VenueSubscription]:
        for (p, a, s), sub in self._subs.items():
            if s == symbol and platform in (None, p) and account in (None, a):
                return sub
        return None

    def holds(
        self, symbol: str, platform: Optional[str] = None, account: Optional[str] = None
    ) -> bool:
        return self.find(symbol, platform, account) is not None

    def retain(
        self, symbol: str, platform: Optional[str] = None, account: Optional[str] = None
    ) -> Optional[VenueSubscription]:
        """Take another reference on a symbol already streaming, or None."""
        symbol = symbol.upper().strip()
        with self._lock:
            sub = self._find(symbol, platform, account)
            if sub is not None:
                sub.ref_count += 1
            return sub

    def subscribe(self, symbol: str, platform: str, account: str) -> VenueSubscription:
        return self._hold(symbol, platform, account, recorded=False)

    def _hold(self, symbol: str, platform: str, account: str, *, recorded: bool):
        symbol = symbol.upper().strip()
        if not symbol:
            raise ValueError("symbol is required")
        key = (platform, account)
        with self._lock:
            sub = self._subs.get((platform, account, symbol))
            started = sub is None
            if sub is None:
                sub = VenueSubscription(symbol=symbol, platform=platform, account=account)
                self._subs[(platform, account, symbol)] = sub
                self._wake(key)
            if recorded:
                sub.recorded = True
            else:
                sub.ref_count += 1
        if started:
            logger.info("venue_stream_started", symbol=symbol, connection=f"{platform}:{account}")
        return sub

    def unsubscribe(
        self, symbol: str, platform: Optional[str] = None, account: Optional[str] = None
    ) -> Optional[VenueSubscription]:
        """Drop one reference. With no connection named, from the first
        subscription on that symbol that has one."""
        symbol = symbol.upper().strip()
        with self._lock:
            sub = next(
                (
                    sub
                    for (p, a, s), sub in self._subs.items()
                    if s == symbol
                    and platform in (None, p)
                    and account in (None, a)
                    and (sub.ref_count > 0 or platform is not None)
                ),
                None,
            )
            if sub is None:
                return None
            sub.ref_count = max(0, sub.ref_count - 1)
            if not self._release_if_idle(sub):
                return sub
        logger.info("venue_stream_stopped", symbol=symbol)
        return sub

    def _release_if_idle(self, sub: VenueSubscription) -> bool:
        """Stop a subscription nothing holds. Call with the lock held."""
        if sub.ref_count > 0 or sub.recorded:
            return False
        self._subs.pop((sub.platform, sub.account, sub.symbol), None)
        self._wake((sub.platform, sub.account))
        self._forget(sub.platform, sub.account, sub.symbol)
        return True

    def set_recorded(self, wanted: Set[SubKey]) -> Dict[SubKey, str]:
        """Make the recorded set exactly ``wanted`` (platform, account,
        SYMBOL): hold what is new, release what is gone. Safe to repeat.
        Returns the keys that are not streaming, with why: those that could
        not be started, and those whose last fetch failed (a symbol the
        account does not have, a broker that is down)."""
        errors: Dict[SubKey, str] = {}
        with self._lock:
            current = {k for k, sub in self._subs.items() if sub.recorded}
            for key in current - wanted:
                sub = self._subs[key]
                sub.recorded = False
                self._release_if_idle(sub)
        for platform, account, symbol in sorted(wanted - current):
            try:
                self.adapter_for((platform, account))  # fails now if it has no market data
                self._hold(symbol, platform, account, recorded=True)
            except Exception as exc:  # noqa: BLE001 — report it, keep the rest
                detail = getattr(exc, "detail", None)
                errors[(platform, account, symbol)] = str(detail if detail is not None else exc)
        with self._lock:
            for key in wanted:
                sub = self._subs.get(key)
                if sub is not None and sub.last_error and key not in errors:
                    errors[key] = sub.last_error
        return errors

    def recorded(self) -> Set[SubKey]:
        with self._lock:
            return {k for k, sub in self._subs.items() if sub.recorded}

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
                        "recorded": s.recorded,
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
        key: ConnectionKey,
        *,
        bid: Optional[float] = None,
        ask: Optional[float] = None,
        last: Optional[float] = None,
    ) -> None:
        with self._lock:
            sub = self._subs.get((key[0], key[1], symbol))
            if sub is None:
                return
            sub.tick_count += 1
            sub.last_tick_at = time.time()
            sub.last_error = None
            recorded = sub.recorded
        for name, value in (("BID", bid), ("ASK", ask), ("LAST", last)):
            if value is not None:
                self._tick(symbol, name, price=value, source=key[0], account=key[1])
        if recorded:
            if sub.basis is None:
                try:
                    sub.basis = getattr(self.adapter_for(key), "bar_basis", "mid")
                except Exception:  # noqa: BLE001 — the next quote asks again
                    return
            self._quote(key[0], key[1], symbol, bid=bid, ask=ask, last=last, basis=sub.basis)

    def record_error(self, key: ConnectionKey, symbols: Set[str], exc: BaseException) -> None:
        detail = getattr(exc, "detail", None)
        message = str(detail if detail is not None else exc)[:300] or type(exc).__name__
        with self._lock:
            changed = False
            for symbol in symbols:
                sub = self._subs.get((key[0], key[1], symbol))
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
