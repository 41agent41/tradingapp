"""Strategy discovery and lookup.

Strategies live as modules in the ``jesse_strategies`` package next to this one
(Jesse's ``strategies/`` project folder). Every ``Strategy`` subclass found there
is registered under a snake-case key prefixed ``jesse_`` — ``SMACrossover`` ->
``jesse_sma_crossover`` — so it can sit in the app's shared strategy catalogue
beside the rule-driven and built-in strategies without name clashes.

Only reviewed, versioned Python in this repository is loaded: there is no path
that imports user-supplied source, so the live evaluation process (which holds
broker credentials) never executes arbitrary code.
"""

from __future__ import annotations

import importlib
import inspect
import pkgutil
from typing import Dict, Type

from .helpers import class_name_to_key
from .models import StrategyError
from .strategy import Strategy

STRATEGIES_PACKAGE = "jesse_strategies"
KEY_PREFIX = "jesse_"

_registry: Dict[str, Type[Strategy]] = {}
_discovered = False


def key_for(strategy_cls: Type[Strategy]) -> str:
    return KEY_PREFIX + class_name_to_key(strategy_cls.__name__)


def register(strategy_cls: Type[Strategy]) -> Type[Strategy]:
    """Class decorator / function: add a strategy to the registry."""

    if not (inspect.isclass(strategy_cls) and issubclass(strategy_cls, Strategy)):
        raise StrategyError(f"{strategy_cls!r} is not a jesse Strategy subclass")
    if strategy_cls is Strategy:
        raise StrategyError("Cannot register the Strategy base class itself")
    key = key_for(strategy_cls)
    existing = _registry.get(key)
    if existing is not None and existing is not strategy_cls:
        raise StrategyError(
            f"Strategy key '{key}' is already taken by {existing.__module__}.{existing.__name__}"
        )
    _registry[key] = strategy_cls
    return strategy_cls


def discover(force: bool = False) -> Dict[str, Type[Strategy]]:
    """Import every module in ``jesse_strategies`` and register its strategies."""

    global _discovered
    if _discovered and not force:
        return dict(_registry)
    try:
        package = importlib.import_module(STRATEGIES_PACKAGE)
    except ModuleNotFoundError:
        _discovered = True
        return dict(_registry)

    for info in pkgutil.iter_modules(package.__path__):
        if info.name.startswith("_"):
            continue
        module = importlib.import_module(f"{STRATEGIES_PACKAGE}.{info.name}")
        for _, obj in inspect.getmembers(module, inspect.isclass):
            if (
                issubclass(obj, Strategy)
                and obj is not Strategy
                and obj.__module__ == module.__name__
            ):
                register(obj)
    _discovered = True
    return dict(_registry)


def all_strategies() -> Dict[str, Type[Strategy]]:
    return discover()


def normalize_key(name: str) -> str:
    """Accept ``jesse_sma_crossover``, ``sma_crossover`` or ``SMACrossover``."""

    if not isinstance(name, str) or not name.strip():
        raise StrategyError("Strategy name must be a non-empty string")
    name = name.strip()
    if name.startswith(KEY_PREFIX):
        return name
    if "_" in name or name.islower():
        return KEY_PREFIX + name
    return KEY_PREFIX + class_name_to_key(name)


def get(name: str) -> Type[Strategy]:
    registry = discover()
    key = normalize_key(name)
    if key not in registry:
        # A class name whose snake-casing differs from the module's key.
        for cls in registry.values():
            if cls.__name__ == name:
                return cls
        raise StrategyError(f"Unknown jesse strategy '{name}'. Available: {sorted(registry)}")
    return registry[key]


def reset() -> None:
    """Test hook: forget everything and re-discover on next access."""

    global _discovered
    _registry.clear()
    _discovered = False
