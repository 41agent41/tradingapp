"""Tests for ib_service/observability.py."""

from __future__ import annotations

import re

from fastapi import FastAPI
from fastapi.testclient import TestClient

from observability import attach_observability, configure_logging


UUID_HEX = re.compile(r"^[0-9a-f]{32}$")


def _build_app() -> TestClient:
    app = FastAPI()
    attach_observability(app)

    @app.get("/echo")
    async def echo():
        return {"ok": True}

    return TestClient(app)


def test_passes_through_caller_request_id():
    client = _build_app()
    res = client.get("/echo", headers={"X-Request-Id": "caller-abc"})
    assert res.status_code == 200
    assert res.headers["x-request-id"] == "caller-abc"


def test_mints_uuid_when_absent():
    client = _build_app()
    res = client.get("/echo")
    assert res.status_code == 200
    rid = res.headers["x-request-id"]
    assert UUID_HEX.match(rid), f"expected uuid hex, got {rid!r}"


def test_rejects_overlong_request_id():
    client = _build_app()
    res = client.get("/echo", headers={"X-Request-Id": "x" * 1024})
    rid = res.headers["x-request-id"]
    assert len(rid) <= 128
    assert rid != "x" * 1024


def test_metrics_endpoint_is_exposed_and_serves_prometheus_text():
    client = _build_app()
    # Warm the histogram so something is registered.
    client.get("/echo")
    res = client.get("/metrics")
    assert res.status_code == 200
    body = res.text
    # prometheus_fastapi_instrumentator names its default request histogram
    # `http_requests_total` (Counter) and `http_request_duration_seconds`
    # (Histogram). Be lenient — either is fine evidence the instrumentator
    # is wired.
    assert (
        "http_request_duration_seconds" in body
        or "http_requests_total" in body
    ), body[:500]


def test_configure_logging_is_idempotent():
    # Should not raise on repeated calls.
    configure_logging()
    configure_logging()
    configure_logging(level="DEBUG")
