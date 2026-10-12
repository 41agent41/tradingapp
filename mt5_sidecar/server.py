"""HTTP front of the MT5 sidecar.

Implements the contract documented at the top of
``broker_service/mt5_adapter.py``. Run it with ``python server.py`` on the
machine (or Wine prefix) where the MT5 terminal runs; see README.md.
"""

from __future__ import annotations

import hmac
import logging
import os
from typing import Any, Callable, Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from config import Config, load_config, read_env_file
from terminal import Terminal, TerminalError

SECRET_HEADER = "X-MT5-Bridge-Secret"

logger = logging.getLogger("mt5_sidecar")


def create_app(terminal: Terminal) -> FastAPI:
    app = FastAPI(title="MT5 sidecar", docs_url=None, redoc_url=None, openapi_url=None)
    secret = terminal.cfg.secret

    @app.middleware("http")
    async def require_secret(request: Request, call_next):
        # Every route, /health included: the runbook checks that an
        # unauthenticated /health is refused, and nothing here is public.
        if secret:
            given = request.headers.get(SECRET_HEADER, "")
            if not hmac.compare_digest(given.encode(), secret.encode()):
                return JSONResponse({"error": "unauthorized"}, status_code=401)
        return await call_next(request)

    def call(fn: Callable[..., Any], *args: Any) -> Any:
        # The MetaTrader5 package is not thread-safe; FastAPI runs sync
        # routes on a thread pool, so every terminal call is serialised.
        try:
            with terminal.lock:
                return fn(*args)
        except TerminalError as exc:
            if exc.status >= 500:
                logger.warning("terminal error: %s", exc.message)
            return JSONResponse({"error": exc.message}, status_code=exc.status)

    @app.get("/health")
    def health():
        body = call(terminal.health)
        if isinstance(body, dict) and not body.get("terminal_connected"):
            return JSONResponse(body, status_code=503)
        return body

    @app.get("/symbols")
    def symbols(query: str = "", limit: int = 50):
        return call(terminal.symbols, query, limit)

    @app.get("/history")
    def history(
        symbol: str,
        timeframe: str,
        count: Optional[int] = None,
        start: Optional[str] = None,
        end: Optional[str] = None,
    ):
        return call(terminal.history, symbol, timeframe, count, start, end)

    @app.get("/quote")
    def quote(symbol: str):
        return call(terminal.tick, symbol)

    @app.get("/tick")
    def tick(symbol: str):
        return call(terminal.tick, symbol)

    @app.get("/symbol")
    def symbol_info(symbol: str):
        return call(terminal.symbol_info, symbol)

    @app.get("/account")
    def account():
        return call(terminal.account)

    @app.get("/positions")
    def positions():
        return call(terminal.positions)

    @app.get("/orders")
    def orders():
        return call(terminal.orders)

    @app.get("/deals")
    def deals(days: int = 1):
        return call(terminal.deals, days)

    @app.post("/orders")
    async def place(request: Request):
        body = await _json(request)
        if isinstance(body, JSONResponse):
            return body
        response = call(terminal.place_order, body)
        if isinstance(response, dict):
            logger.info(
                "order %s %s %s -> %s sl=%s",
                body.get("action"),
                body.get("quantity"),
                body.get("symbol"),
                response.get("status"),
                response.get("sl"),
            )
        return response

    @app.post("/positions/{symbol}/stop")
    async def modify_stop(symbol: str, request: Request):
        body = await _json(request)
        if isinstance(body, JSONResponse):
            return body
        return call(terminal.modify_stop, symbol, body)

    @app.delete("/orders/{ticket}")
    def cancel(ticket: int):
        return call(terminal.cancel_order, ticket)

    @app.put("/orders/{ticket}")
    async def modify(ticket: int, request: Request):
        body = await _json(request)
        if isinstance(body, JSONResponse):
            return body
        return call(terminal.modify_order, ticket, body)

    return app


async def _json(request: Request) -> Any:
    try:
        body = await request.json()
    except ValueError:
        return JSONResponse({"error": "body must be JSON"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"error": "body must be a JSON object"}, status_code=400)
    return body


def main() -> None:  # pragma: no cover - needs a real terminal
    import MetaTrader5 as mt5
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    # Settings from the process environment win over the file.
    env_file = os.environ.get("MT5_SIDECAR_ENV_FILE") or "sidecar.env"
    config: Config = load_config({**read_env_file(env_file), **os.environ})
    terminal = Terminal(mt5, config)
    try:
        terminal.connect()
    except TerminalError as exc:
        # Keep serving: /health reports the problem and the next request
        # retries, so a terminal that starts late does not need a restart.
        logger.error("%s", exc.message)
    if not config.secret:
        logger.warning("MT5_BRIDGE_SECRET is not set; only use this on a loopback address")
    uvicorn.run(create_app(terminal), host=config.host, port=config.port, log_level="info")


if __name__ == "__main__":  # pragma: no cover
    main()
