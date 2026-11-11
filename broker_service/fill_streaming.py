"""Fills streamed from the broker as they happen (E-10).

The backend learns of fills by polling ``/account/executions`` on a timer, so
a fill can be minutes old before the app knows of it. A broker whose adapter
has ``stream_fills`` (OANDA's transaction stream) is also listened to here, on
one background thread per connection, and each fill is published on the Redis
channel ``executions:fill:<platform>:<account>`` in the same shape the poll
returns. The backend stores it at once.

A broker whose stream says only that something traded (IG's trade
subscription; ``stream_trade_events`` on the adapter) is listened to the same
way, and each event is published on ``executions:changed:<platform>:<account>``.
The backend then polls that connection straight away, so the fill is still
read from the one place the poll reads it and cannot be stored twice under
two ids.

The stream adds speed, not correctness. Redis publish is not durable and a
stream can drop, so the poll stays on and remains the record: it reads an
overlapping window, and a fill seen both ways is stored once.

Streams run only while the backend's executions sync is on (it sends
``FILL_STREAM_ENABLED`` with the settings; see app_settings.py). A supervisor
compares the connections that should stream with the threads running every
few seconds, so a connection added, removed or edited on the Settings page, or
the sync being turned on or off, is picked up without a restart. A failure
never ends a worker: it records the error, waits, and tries again.
"""

from __future__ import annotations

import asyncio
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple

import app_settings
from observability import get_logger

logger = get_logger(__name__)

RETRY_SECONDS = 5.0
SUPERVISE_SECONDS = 10.0

ConnectionKey = Tuple[str, str]  # (platform, account)


@dataclass
class FillStreamState:
    platform: str
    account: str
    started_at: float
    # A stream is open, or being opened.
    listening: bool = False
    fills: int = 0
    last_fill_at: Optional[float] = None
    last_error: Optional[str] = None


class _Worker:
    """One thread listening for fills on one connection."""

    def __init__(self, streamer: FillStreamer, key: ConnectionKey) -> None:
        self.streamer = streamer
        self.key = key
        self.state = FillStreamState(platform=key[0], account=key[1], started_at=time.time())
        self.stop = threading.Event()
        self.thread = threading.Thread(
            target=self._run, name=f"fill-stream-{key[0]}-{key[1]}", daemon=True
        )

    def _run(self) -> None:
        while not self.stop.is_set():
            try:
                # Looked up on every attempt, so an edited connection is used.
                adapter = self.streamer.adapter_for(self.key)
                self.state.listening = True
                if hasattr(adapter, "stream_fills"):
                    adapter.stream_fills(self._on_fill, self.stop.is_set)
                else:
                    adapter.stream_trade_events(self._on_trade_event, self.stop.is_set)
                self.state.last_error = None
            except Exception as exc:  # noqa: BLE001 — a worker must outlive any failure
                error = str(getattr(exc, "detail", None) or exc)
                if error != self.state.last_error:
                    logger.warning(
                        "fill_stream_error", connection=f"{self.key[0]}:{self.key[1]}", error=error
                    )
                self.state.last_error = error
            finally:
                self.state.listening = False
            # The broker closed the stream, or it failed: reopen after a pause.
            self.stop.wait(RETRY_SECONDS)

    def _on_fill(self, fill: Dict[str, Any]) -> None:
        self.state.fills += 1
        self.state.last_fill_at = time.time()
        self.streamer.publish(self.key, fill)

    def _on_trade_event(self) -> None:
        self.state.fills += 1
        self.state.last_fill_at = time.time()
        self.streamer.publish_changed(self.key)


class FillStreamer:
    """Keeps one fill stream open per connection that can stream fills."""

    def __init__(
        self,
        list_connections: Optional[Callable[[], List[Any]]] = None,
        resolve_adapter: Optional[Callable[[str, str], Any]] = None,
        publish_fill: Optional[Callable[[str, str, Dict[str, Any]], None]] = None,
        enabled: Optional[Callable[[], bool]] = None,
        publish_changed: Optional[Callable[[str, str], None]] = None,
    ) -> None:
        self._publish_changed = publish_changed
        self._list_connections = list_connections
        self._resolve_adapter = resolve_adapter
        self._publish_fill = publish_fill
        self._enabled = enabled
        self._workers: Dict[ConnectionKey, _Worker] = {}
        self._lock = threading.Lock()

    # -- wiring (defaults resolved lazily to keep imports light) ----------- #
    def adapter_for(self, key: ConnectionKey) -> Any:
        if self._resolve_adapter is not None:
            return self._resolve_adapter(*key)
        from adapters import get_broker_adapter

        return get_broker_adapter(*key)

    def publish(self, key: ConnectionKey, fill: Dict[str, Any]) -> None:
        if self._publish_fill is not None:
            self._publish_fill(key[0], key[1], fill)
            return
        from streaming import streaming_manager

        streaming_manager.publish_fill(key[0], key[1], fill)

    def publish_changed(self, key: ConnectionKey) -> None:
        if self._publish_changed is not None:
            self._publish_changed(key[0], key[1])
            return
        from streaming import streaming_manager

        streaming_manager.publish_fills_changed(key[0], key[1])

    def _wanted(self) -> set[ConnectionKey]:
        """Every connection that should be streaming now."""
        enabled = (
            self._enabled() if self._enabled is not None else app_settings.fill_stream_enabled()
        )
        if not enabled:
            return set()
        if self._list_connections is not None:
            connections = self._list_connections()
        else:
            from adapters import list_connections

            connections = list_connections()
        wanted: set[ConnectionKey] = set()
        for conn in connections:
            key = (conn.platform, conn.account)
            try:
                adapter = self.adapter_for(key)
            except Exception:  # noqa: BLE001 — a connection with no broker side
                continue
            if hasattr(adapter, "stream_fills") or hasattr(adapter, "stream_trade_events"):
                wanted.add(key)
        return wanted

    # -- public API --------------------------------------------------------- #
    def reconcile(self) -> None:
        """Start a stream for each connection that should have one and stop
        the rest."""
        wanted = self._wanted()
        with self._lock:
            for key in [k for k in self._workers if k not in wanted]:
                self._workers.pop(key).stop.set()
                logger.info("fill_stream_stopped", connection=f"{key[0]}:{key[1]}")
            for key in sorted(wanted - set(self._workers)):
                worker = _Worker(self, key)
                self._workers[key] = worker
                worker.thread.start()
                logger.info("fill_stream_started", connection=f"{key[0]}:{key[1]}")

    def stop_all(self) -> None:
        with self._lock:
            for worker in self._workers.values():
                worker.stop.set()
            self._workers.clear()

    def status(self) -> Dict[str, Any]:
        """Diagnostics for ``GET /account/executions/stream/status``."""
        with self._lock:
            states = [w.state for w in self._workers.values()]
        return {
            "enabled": (
                self._enabled() if self._enabled is not None else app_settings.fill_stream_enabled()
            ),
            "streams": [
                {
                    "connection": f"{s.platform}:{s.account}",
                    "listening": s.listening,
                    "fills": s.fills,
                    "last_fill_at": s.last_fill_at,
                    "last_error": s.last_error,
                    "started_at": s.started_at,
                }
                for s in sorted(states, key=lambda s: (s.platform, s.account))
            ],
        }


fill_streamer = FillStreamer()


async def fill_stream_loop() -> None:
    """Keep the fill streams in step with the connections and the setting."""
    last_error: Optional[str] = None
    while True:
        try:
            await asyncio.to_thread(fill_streamer.reconcile)
            last_error = None
        except Exception as exc:  # noqa: BLE001 — the loop must survive
            error = str(getattr(exc, "detail", None) or exc)
            if error != last_error:
                logger.error("fill_stream_loop_error", error=error)
            last_error = error
        await asyncio.sleep(SUPERVISE_SECONDS)
