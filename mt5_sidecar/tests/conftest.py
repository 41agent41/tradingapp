"""Shared fixtures: a sidecar app wired to the in-memory fake terminal."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

_ROOT = Path(__file__).resolve().parent.parent
for path in (_ROOT, _ROOT / "tests"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from config import load_config  # noqa: E402
from fake_mt5 import FakeMT5  # noqa: E402
from server import SECRET_HEADER, create_app  # noqa: E402
from terminal import Terminal  # noqa: E402

SECRET = "s" * 32


def make(env=None, **fake_kwargs):
    """A (fake terminal, authenticated test client) pair."""
    fake = FakeMT5(**fake_kwargs)
    config = load_config({"MT5_BRIDGE_SECRET": SECRET, **(env or {})})
    terminal = Terminal(fake, config)
    terminal.connect()
    client = TestClient(create_app(terminal))
    client.headers[SECRET_HEADER] = SECRET
    return fake, client


@pytest.fixture
def netting():
    return make()


@pytest.fixture
def hedging():
    return make(hedging=True)
