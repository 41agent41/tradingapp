"""
Service-to-service authentication for the broker service.

The broker service can place, cancel and modify orders, so anything that can
reach it can trade the account. Only the backend should call it: the backend
is where the order audit, the position cap, the live gate and the trader
role / MFA checks live. Calling the broker service directly skips all of them.

When ``BROKER_SERVICE_TOKEN`` is set, every request must carry it in the
``X-Broker-Service-Token`` header, compared in constant time. Liveness paths
stay open so container health checks keep working.

When it is unset the service still starts (local development and the test
suite rely on that) but logs a loud warning on every boot. The backend refuses
to start in production without it, so a production stack never runs open.
"""

from __future__ import annotations

import hmac
import os

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from observability import get_logger

logger = get_logger(__name__)

HEADER = "x-broker-service-token"
OPEN_PATHS = frozenset({"/", "/health", "/metrics"})


def expected_token() -> str:
    return (os.getenv("BROKER_SERVICE_TOKEN") or "").strip()


def attach_service_auth(app: FastAPI) -> None:
    """Install the shared-secret check on every route of ``app``."""
    if not expected_token():
        logger.warning(
            "BROKER_SERVICE_TOKEN is not set: the broker service accepts "
            "unauthenticated requests, including orders. docker-compose.yml "
            "provides it from the internal_secrets volume."
        )

    @app.middleware("http")
    async def require_service_token(request: Request, call_next):
        expected = expected_token()
        if not expected or request.url.path in OPEN_PATHS or request.method == "OPTIONS":
            return await call_next(request)
        supplied = (request.headers.get(HEADER) or "").strip()
        if not supplied or not hmac.compare_digest(supplied.encode(), expected.encode()):
            return JSONResponse(
                status_code=401,
                content={"detail": "A valid X-Broker-Service-Token header is required."},
            )
        return await call_next(request)
