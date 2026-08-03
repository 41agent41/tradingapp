"""
Observability primitives for ib_service (GAP_ANALYSIS §6).

Three concerns wired up in one module:

  1. structlog — structured (JSON in non-TTY contexts) logging with a per-
     request ``request_id`` automatically threaded through every log line
     emitted during the request.
  2. A FastAPI middleware that accepts ``X-Request-Id`` from the caller (or
     mints one), echoes it on the response, and binds it to the context vars
     so log records carry it.
  3. ``prometheus_fastapi_instrumentator`` for /metrics — default HTTP
     histograms plus the process metrics it auto-collects.

This module is import-time safe: it only configures structlog on first
``configure_logging()`` call so test code can opt in or out.
"""

from __future__ import annotations

import logging
import os
import sys
import uuid
from typing import Awaitable, Callable

import structlog
from fastapi import FastAPI, Request, Response
from prometheus_fastapi_instrumentator import Instrumentator
from starlette.middleware.base import BaseHTTPMiddleware

REQUEST_ID_HEADER = "x-request-id"
_REQUEST_ID_MAX_LEN = 128

_configured = False


def configure_logging(level: str | None = None) -> None:
    """Configure structlog + stdlib logging once. Safe to call repeatedly."""

    global _configured
    if _configured:
        return

    log_level = (level or os.getenv("LOG_LEVEL") or "INFO").upper()
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=getattr(logging, log_level, logging.INFO),
    )

    # JSON when stdout is not a TTY (docker / k8s), pretty otherwise (dev).
    renderer = (
        structlog.dev.ConsoleRenderer()
        if sys.stdout.isatty()
        else structlog.processors.JSONRenderer()
    )

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            renderer,
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, log_level, logging.INFO)
        ),
        cache_logger_on_first_use=True,
    )

    _configured = True


def get_logger(name: str = "ib_service") -> structlog.stdlib.BoundLogger:
    configure_logging()
    return structlog.get_logger(name)


class RequestIdMiddleware(BaseHTTPMiddleware):
    """Accept or mint X-Request-Id and bind it to structlog contextvars."""

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        incoming = request.headers.get(REQUEST_ID_HEADER, "").strip()
        request_id = incoming if 0 < len(incoming) <= _REQUEST_ID_MAX_LEN else uuid.uuid4().hex

        # Bind for the lifetime of this request — every structlog call sees
        # `request_id` automatically via merge_contextvars.
        structlog.contextvars.bind_contextvars(request_id=request_id)
        try:
            response = await call_next(request)
        finally:
            structlog.contextvars.clear_contextvars()

        response.headers["X-Request-Id"] = request_id
        return response


def attach_observability(app: FastAPI) -> None:
    """Wire structlog + request-id middleware + prom-client onto a FastAPI app."""

    configure_logging()
    app.add_middleware(RequestIdMiddleware)
    # /metrics endpoint with default HTTP histograms.
    Instrumentator(
        should_instrument_requests_inprogress=True,
        excluded_handlers=["/metrics", "/health"],
    ).instrument(app).expose(app, include_in_schema=False)
