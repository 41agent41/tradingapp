"""
Tests for the broker service's shared-secret check (``service_auth.py``).

The broker service can place orders, so with ``BROKER_SERVICE_TOKEN`` set every
call except liveness must carry it. Without the token the service stays open
(development and the rest of this suite rely on that).
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service_auth import attach_service_auth

TOKEN = "t" * 40


def _client() -> TestClient:
    app = FastAPI()
    attach_service_auth(app)

    @app.get("/health")
    def health():
        return {"ok": True}

    @app.post("/orders")
    def orders():
        return {"placed": True}

    return TestClient(app)


def test_open_when_no_token_configured(monkeypatch):
    monkeypatch.delenv("BROKER_SERVICE_TOKEN", raising=False)
    assert _client().post("/orders").status_code == 200


def test_rejects_orders_without_the_token(monkeypatch):
    monkeypatch.setenv("BROKER_SERVICE_TOKEN", TOKEN)
    r = _client().post("/orders")
    assert r.status_code == 401


def test_rejects_a_wrong_token(monkeypatch):
    monkeypatch.setenv("BROKER_SERVICE_TOKEN", TOKEN)
    r = _client().post("/orders", headers={"X-Broker-Service-Token": "x" * 40})
    assert r.status_code == 401


def test_accepts_the_right_token(monkeypatch):
    monkeypatch.setenv("BROKER_SERVICE_TOKEN", TOKEN)
    r = _client().post("/orders", headers={"X-Broker-Service-Token": TOKEN})
    assert r.status_code == 200
    assert r.json() == {"placed": True}


def test_health_stays_open(monkeypatch):
    monkeypatch.setenv("BROKER_SERVICE_TOKEN", TOKEN)
    assert _client().get("/health").status_code == 200
