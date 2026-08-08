"""
Route tests for ``POST /strategies/evaluate`` (Systematic Trading roadmap A2).

A fresh FastAPI app mounts just the ``strategies`` router, so no IB gateway is
touched — the endpoint is stateless (bars + rule-set → latest signal).
"""

from __future__ import annotations

import numpy as np
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routes import strategies


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(strategies.router)
    return TestClient(app)


def _rising_bars(n: int = 60) -> list[dict]:
    close = np.linspace(100.0, 120.0, n)
    start = 1_700_000_000
    return [
        {
            "timestamp": start + i * 86_400,
            "open": float(close[i]),
            "high": float(close[i]) + 0.5,
            "low": float(close[i]) - 0.5,
            "close": float(close[i]),
            "volume": 1000.0,
        }
        for i in range(n)
    ]


MA_RULES = {
    "name": "MA",
    "entry": {
        "all": [
            {"left": "sma_20", "op": ">", "right": "sma_50"},
            {"left": "position.size", "op": "<=", "right": 0},
        ]
    },
    "exit": {"all": [{"left": "sma_20", "op": "<", "right": "sma_50"}]},
}


def test_evaluate_inline_rule_set_returns_long_when_flat() -> None:
    res = _client().post(
        "/strategies/evaluate",
        json={"bars": _rising_bars(), "rule_set": MA_RULES},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["success"] is True
    assert body["signal"] == "long"
    assert body["bars_evaluated"] == 60
    assert body["in_session"] is True


def test_evaluate_respects_supplied_position() -> None:
    res = _client().post(
        "/strategies/evaluate",
        json={
            "bars": _rising_bars(),
            "rule_set": MA_RULES,
            "position": {"size": 100, "avg_price": 100},
        },
    )
    assert res.status_code == 200
    # Already long -> the position.size <= 0 gate blocks a fresh buy.
    assert res.json()["signal"] == "none"


def test_evaluate_registered_strategy_key() -> None:
    res = _client().post(
        "/strategies/evaluate",
        json={"bars": _rising_bars(), "strategy": "rule_ma_crossover"},
    )
    assert res.status_code == 200
    assert res.json()["success"] is True


def test_evaluate_rejects_both_rule_set_and_strategy() -> None:
    res = _client().post(
        "/strategies/evaluate",
        json={"bars": _rising_bars(), "rule_set": MA_RULES, "strategy": "rule_ma_crossover"},
    )
    assert res.status_code == 400


def test_evaluate_rejects_neither_rule_set_nor_strategy() -> None:
    res = _client().post("/strategies/evaluate", json={"bars": _rising_bars()})
    assert res.status_code == 400


def test_evaluate_unknown_strategy_key_404() -> None:
    res = _client().post(
        "/strategies/evaluate",
        json={"bars": _rising_bars(), "strategy": "does_not_exist"},
    )
    assert res.status_code == 404


def test_evaluate_non_rule_strategy_key_400() -> None:
    # ma_crossover is a plain (non-rule) strategy, so it can't be evaluated here.
    res = _client().post(
        "/strategies/evaluate",
        json={"bars": _rising_bars(), "strategy": "ma_crossover"},
    )
    assert res.status_code == 400


def test_evaluate_invalid_rule_set_400() -> None:
    res = _client().post(
        "/strategies/evaluate",
        json={"bars": _rising_bars(), "rule_set": {"name": "bad"}},  # no 'entry'
    )
    assert res.status_code == 400


def test_evaluate_empty_bars_422() -> None:
    # Pydantic min_length=1 rejects an empty bar list before the handler runs.
    res = _client().post("/strategies/evaluate", json={"bars": [], "rule_set": MA_RULES})
    assert res.status_code == 422
