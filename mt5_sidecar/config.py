"""Sidecar settings, read once from the environment.

One sidecar process serves one MT5 terminal logged in to one account. Run a
second process (on another port, with another terminal) for a second account.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Dict, Mapping, Optional

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


class ConfigError(ValueError):
    """The sidecar must not start with this configuration."""


@dataclass(frozen=True)
class Config:
    secret: str
    host: str
    port: int
    # Terminal login. All optional: when unset the sidecar attaches to a
    # terminal that is already running and logged in.
    terminal_path: Optional[str]
    # Start the terminal in portable mode (data kept next to terminal64.exe),
    # which is how two accounts run side by side from two install folders.
    portable: bool
    login: Optional[int]
    password: Optional[str]
    server: Optional[str]
    # Tags every order this sidecar sends, so its trades can be told apart
    # from manual ones in the terminal.
    magic: int
    # Maximum slippage, in points, accepted on a market order.
    deviation: int
    # The trade server's time zone. MT5 reports bar, tick and deal times as
    # the server's wall clock written as if it were UTC, so they are shifted
    # back to real UTC with this zone (e.g. "Europe/Athens" for the common
    # GMT+2/GMT+3 brokers). "UTC" means no shift.
    server_tz: str
    # Orders on a real-money account are refused unless this is set, as a
    # second gate behind the app's own LIVE_TRADING_ENABLED.
    allow_real: bool


def _flag(value: Optional[str]) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def load_config(env: Mapping[str, str] = os.environ) -> Config:
    secret = (env.get("MT5_BRIDGE_SECRET") or "").strip()
    host = (env.get("MT5_SIDECAR_HOST") or "127.0.0.1").strip()
    if not secret and host not in LOOPBACK_HOSTS:
        # Anything that can reach the port could trade the account.
        raise ConfigError(
            f"MT5_BRIDGE_SECRET is required when listening on {host}; "
            "set it to the same value as the connection's secret in the app."
        )
    if secret and len(secret) < 24:
        raise ConfigError("MT5_BRIDGE_SECRET must be at least 24 characters.")

    login_raw = (env.get("MT5_LOGIN") or "").strip()
    try:
        login = int(login_raw) if login_raw else None
        port = int(env.get("MT5_SIDECAR_PORT") or 9100)
        magic = int(env.get("MT5_MAGIC") or 61_000)
        deviation = int(env.get("MT5_DEVIATION_POINTS") or 20)
    except ValueError as exc:
        raise ConfigError(f"invalid number in sidecar settings: {exc}") from exc

    server_tz = (env.get("MT5_SERVER_TZ") or "UTC").strip()
    _check_zone(server_tz)

    return Config(
        secret=secret,
        host=host,
        port=port,
        terminal_path=(env.get("MT5_TERMINAL_PATH") or "").strip() or None,
        portable=_flag(env.get("MT5_PORTABLE")),
        login=login,
        password=env.get("MT5_PASSWORD") or None,
        server=(env.get("MT5_SERVER") or "").strip() or None,
        magic=magic,
        deviation=deviation,
        server_tz=server_tz,
        allow_real=_flag(env.get("MT5_ALLOW_REAL")),
    )


def read_env_file(path: str) -> Dict[str, str]:
    """``KEY=VALUE`` lines from ``path``, for hosts without a service manager
    that sets the environment (Task Scheduler on Windows). Blank lines and
    ``#`` comments are skipped; surrounding quotes are removed."""
    values: Dict[str, str] = {}
    if not path or not os.path.isfile(path):
        return values
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip("'\"")
    return values


def _check_zone(name: str) -> None:
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ConfigError(
            f"MT5_SERVER_TZ={name!r} is not a known time zone (install tzdata on Windows)"
        ) from exc
