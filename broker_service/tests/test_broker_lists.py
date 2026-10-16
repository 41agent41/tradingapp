"""Every supported broker is wired in every place it has to be.

Adding a broker touches the broker service, the backend and the frontend
(see docs/DEVELOPMENT.md, "Adding a broker"). This test reads each list and fails, naming the
file, when one of them is missing the broker or disagrees on the order, so a
half-added broker cannot pass CI. It also checks every adapter implements the
whole adapter contract, plus ``probe()``.
"""

from __future__ import annotations

import ast
import importlib
import inspect
import re
from pathlib import Path

import pytest

import adapters
import connections

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend" / "src"
FRONTEND = ROOT / "frontend" / "app"

PLATFORMS = set(connections.SUPPORTED_PLATFORMS)
PRIORITY = list(connections.BROKER_PRIORITY)

ADAPTER_CLASSES = {
    "ib": ("ib_adapter", "IBAdapter"),
    "mt5": ("mt5_adapter", "MT5Adapter"),
    "alpaca": ("alpaca_adapter", "AlpacaAdapter"),
    "oanda": ("oanda_adapter", "OANDAAdapter"),
}


def _read(path: Path) -> str:
    if not path.exists():
        pytest.skip(f"{path} is not in this checkout")
    return path.read_text(encoding="utf-8")


def _string_list(source: str, name: str, path: Path) -> list[str]:
    """The quoted strings in ``name = [...]`` / ``name: T = [...]``."""
    m = re.search(rf"\b{name}\b[^=\n]*=\s*\[([^\]]*)\]", source)
    assert m, f"{path}: could not find the list {name}"
    return re.findall(r"'([^']+)'", m.group(1))


def _object_keys(source: str, name: str, path: Path) -> set[str]:
    """The top-level keys of ``name ... = { key: ..., }``."""
    m = re.search(rf"\b{name}\b[^=]*=\s*\{{", source)
    assert m, f"{path}: could not find the object {name}"
    depth, i, start = 1, m.end(), m.end()
    while depth:
        depth += {"{": 1, "}": -1}.get(source[i], 0)
        i += 1
    body = source[start : i - 1]
    keys, depth = set(), 0
    for line in body.splitlines():
        if depth == 0:
            km = re.match(r"\s*([a-z0-9_]+)\s*:", line)
            if km:
                keys.add(km.group(1))
        depth += line.count("{") + line.count("[") - line.count("}") - line.count("]")
    return keys


def test_priority_covers_every_platform():
    assert set(PRIORITY) == PLATFORMS
    assert len(PRIORITY) == len(PLATFORMS)


def test_backend_lists_match():
    path = BACKEND / "services" / "brokers.ts"
    assert set(_string_list(_read(path), "BROKERS", path)) == PLATFORMS, path

    path = BACKEND / "services" / "orderTypes.ts"
    assert _string_list(_read(path), "BROKER_PRIORITY", path) == PRIORITY, path

    path = BACKEND / "services" / "brokerConnections.ts"
    assert _object_keys(_read(path), "PLATFORM_FIELDS", path) == PLATFORMS, path


def test_frontend_lists_match():
    path = FRONTEND / "lib" / "brokerConnections.ts"
    src = _read(path)
    assert _string_list(src, "BROKERS_BY_PRIORITY", path) == PRIORITY, path
    assert _object_keys(src, "PLATFORM_FORM", path) == PLATFORMS, path
    assert _object_keys(src, "PLATFORM_NAME", path) == PLATFORMS, path


def test_every_platform_builds_an_adapter_and_has_a_hint():
    src = inspect.getsource(adapters._build_adapters)
    built = set(re.findall(r'conn\.platform == "([a-z0-9]+)"', src))
    assert built == PLATFORMS, "adapters._build_adapters"
    # IB's hint comes from ib_client (IB_HOST); every other platform has one.
    assert set(adapters._UNAVAILABLE_HINTS) == PLATFORMS - {"ib"}
    assert set(ADAPTER_CLASSES) == PLATFORMS


def _protocol_methods(protocol) -> set[str]:
    tree = ast.parse(inspect.getsource(protocol))
    return {n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}


@pytest.mark.parametrize("platform", sorted(ADAPTER_CLASSES))
def test_adapter_implements_the_contract(platform):
    module_name, class_name = ADAPTER_CLASSES[platform]
    cls = getattr(importlib.import_module(module_name), class_name)
    required = (
        _protocol_methods(adapters.MarketDataAdapter)
        | _protocol_methods(adapters.BrokerAdapter)
        | {"probe"}
    )
    if platform == "ib":
        # IB's history is served inline by routes/market_data.py, not its adapter.
        required -= {"historical_bars"}
    missing = sorted(m for m in required if not callable(getattr(cls, m, None)))
    assert not missing, f"{class_name} is missing {missing}"
    if platform != "ib":
        assert getattr(cls, "name", None) == platform, f"{class_name}.name"
