"""
Pure transformations from IB-Gateway ``BarData`` rows into
``HistoricalDataResponse`` objects, with optional indicator columns and
optional date-range filtering.

The four functions (process_bars / process_bars_with_date_range /
process_bars_with_indicators / process_bars_with_date_range_and_indicators)
are deliberately kept as separate entry points to preserve the behaviour
the route handlers rely on. They are pure functions of the input bar list
— no IB-client globals, no thread state — so they sit cleanly in their
own module.

Extracted from main.py during the GAP_ANALYSIS §3.4 module split.
"""

from __future__ import annotations

import calendar
from datetime import datetime
from typing import List, Optional

import pandas as pd

from indicators import calculator as indicator_calculator
from models import CandlestickBar, HistoricalDataResponse
from observability import get_logger

logger = get_logger(__name__)


INDICATOR_FIELDS = (
    "sma_20",
    "sma_50",
    "ema_12",
    "ema_26",
    "rsi",
    "macd",
    "macd_signal",
    "macd_histogram",
    "bb_upper",
    "bb_middle",
    "bb_lower",
    "stoch_k",
    "stoch_d",
    "atr",
    "obv",
    "vwap",
    "volume_sma",
)


def _parse_bar_timestamp(bar) -> int:
    """Robustly turn whatever ``bar.date`` is into a Unix epoch second.

    IB bar dates arrive as one of:
      - ``"YYYYMMDD HH:MM:SS"`` (intraday, sometimes with double spaces)
      - ``"YYYYMMDD"`` (daily / weekly / monthly)
      - an ``int``/``float`` Unix timestamp (already-numeric formats)
      - a ``datetime`` object (rare, but supported)
    """
    raw = bar.date
    if isinstance(raw, str):
        date_str = " ".join(raw.strip().split())
        if " " in date_str:
            for fmt in ("%Y%m%d %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y%m%d %H:%M:%S.%f"):
                try:
                    return calendar.timegm(datetime.strptime(date_str, fmt).timetuple())
                except ValueError:
                    continue
            raise ValueError(f"unrecognised IB datetime string: {raw!r}")
        return calendar.timegm(datetime.strptime(date_str, "%Y%m%d").timetuple())
    if isinstance(raw, (int, float)):
        return int(raw)
    if hasattr(raw, "timestamp"):
        return int(raw.timestamp())
    return calendar.timegm(datetime.strptime(str(raw).strip(), "%Y%m%d %H:%M:%S").timetuple())


def _candlestick_from_bar(bar, timestamp: int) -> CandlestickBar:
    return CandlestickBar(
        timestamp=timestamp,
        open=float(bar.open),
        high=float(bar.high),
        low=float(bar.low),
        close=float(bar.close),
        volume=int(bar.volume),
    )


def _calculate_indicators(bars_data: List[dict], indicators: List[str]) -> List[CandlestickBar]:
    df = pd.DataFrame(bars_data)
    df_with_indicators = indicator_calculator.calculate_indicators(df, indicators)

    candlesticks: List[CandlestickBar] = []
    for _, row in df_with_indicators.iterrows():
        data = {
            "timestamp": float(row["timestamp"]),
            "open": float(row["open"]),
            "high": float(row["high"]),
            "low": float(row["low"]),
            "close": float(row["close"]),
            "volume": int(row["volume"]),
        }
        for field in INDICATOR_FIELDS:
            if field in row and pd.notna(row[field]):
                data[field] = float(row[field])
        candlesticks.append(CandlestickBar(**data))
    return candlesticks


def process_bars(bars, symbol: str, timeframe: str, period: str) -> HistoricalDataResponse:
    """Process IB bars into candlestick data — basic path, no indicators."""

    candlesticks: List[CandlestickBar] = []
    for bar in bars:
        try:
            timestamp = _parse_bar_timestamp(bar)
            candlesticks.append(_candlestick_from_bar(bar, timestamp))
        except Exception as e:  # noqa: BLE001
            logger.warning("bar_parse_failed", err=str(e), raw_date=str(bar.date))
            continue

    candlesticks.sort(key=lambda x: x.timestamp, reverse=True)
    logger.info(
        "bars_processed",
        symbol=symbol,
        timeframe=timeframe,
        period=period,
        processed=len(candlesticks),
        received=len(bars),
    )
    return HistoricalDataResponse(
        symbol=symbol,
        timeframe=timeframe,
        period=period,
        bars=candlesticks,
        count=len(candlesticks),
        last_updated=datetime.now().isoformat(),
    )


def process_bars_with_date_range(
    bars,
    symbol: str,
    timeframe: str,
    start_date_str: str,
    end_date_str: str,
) -> HistoricalDataResponse:
    """Process IB bars with date-range filtering (no indicators)."""

    start_dt = datetime.strptime(start_date_str, "%Y-%m-%d")
    end_dt = datetime.strptime(end_date_str, "%Y-%m-%d").replace(hour=23, minute=59, second=59)

    candlesticks: List[CandlestickBar] = []
    for bar in bars:
        try:
            timestamp = _parse_bar_timestamp(bar)
            bar_dt = datetime.fromtimestamp(timestamp)
            if start_dt <= bar_dt <= end_dt:
                candlesticks.append(_candlestick_from_bar(bar, timestamp))
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "bar_range_parse_failed",
                err=str(e),
                raw_date=str(bar.date),
            )
            continue

    candlesticks.sort(key=lambda x: x.timestamp, reverse=True)
    logger.info(
        "bars_processed_range",
        symbol=symbol,
        timeframe=timeframe,
        start=start_date_str,
        end=end_date_str,
        processed=len(candlesticks),
    )
    return HistoricalDataResponse(
        symbol=symbol,
        timeframe=timeframe,
        period="CUSTOM",
        bars=candlesticks,
        count=len(candlesticks),
        last_updated=datetime.now().isoformat(),
    )


def process_bars_with_indicators(
    bars,
    symbol: str,
    timeframe: str,
    period: str,
    indicators: Optional[List[str]] = None,
) -> HistoricalDataResponse:
    """Process IB bars with optional indicator columns layered in."""

    try:
        bars_data: List[dict] = []
        for bar in bars:
            try:
                timestamp = _parse_bar_timestamp(bar)
                bars_data.append(
                    {
                        "timestamp": timestamp,
                        "open": float(bar.open),
                        "high": float(bar.high),
                        "low": float(bar.low),
                        "close": float(bar.close),
                        "volume": int(bar.volume),
                    }
                )
            except Exception as e:  # noqa: BLE001
                logger.warning(
                    "bar_indicator_prep_failed",
                    err=str(e),
                    raw_date=str(bar.date),
                )
                continue

        if not bars_data:
            return HistoricalDataResponse(
                symbol=symbol,
                timeframe=timeframe,
                period=period,
                bars=[],
                count=0,
                last_updated=datetime.now().isoformat(),
            )

        if indicators:
            candlesticks = _calculate_indicators(bars_data, indicators)
        else:
            candlesticks = [CandlestickBar(**bar_data) for bar_data in bars_data]

        candlesticks.sort(key=lambda x: x.timestamp, reverse=True)
        logger.info(
            "bars_processed_indicators",
            symbol=symbol,
            timeframe=timeframe,
            period=period,
            processed=len(candlesticks),
        )
        return HistoricalDataResponse(
            symbol=symbol,
            timeframe=timeframe,
            period=period,
            bars=candlesticks,
            count=len(candlesticks),
            last_updated=datetime.now().isoformat(),
        )
    except Exception as e:  # noqa: BLE001
        logger.error("bars_processed_indicators_failed", err=str(e))
        return process_bars(bars, symbol, timeframe, period)


def process_bars_with_date_range_and_indicators(
    bars,
    symbol: str,
    timeframe: str,
    start_date_str: str,
    end_date_str: str,
    indicators: Optional[List[str]] = None,
) -> HistoricalDataResponse:
    """Process IB bars with date-range filtering and optional indicators."""

    try:
        start_dt = datetime.strptime(start_date_str, "%Y-%m-%d")
        end_dt = datetime.strptime(end_date_str, "%Y-%m-%d").replace(hour=23, minute=59, second=59)

        bars_data: List[dict] = []
        for bar in bars:
            try:
                timestamp = _parse_bar_timestamp(bar)
                bar_dt = datetime.fromtimestamp(timestamp)
                if start_dt <= bar_dt <= end_dt:
                    bars_data.append(
                        {
                            "timestamp": timestamp,
                            "open": float(bar.open),
                            "high": float(bar.high),
                            "low": float(bar.low),
                            "close": float(bar.close),
                            "volume": int(bar.volume),
                        }
                    )
            except Exception as e:  # noqa: BLE001
                logger.warning(
                    "bar_range_indicator_prep_failed",
                    err=str(e),
                    raw_date=str(bar.date),
                )
                continue

        if not bars_data:
            return HistoricalDataResponse(
                symbol=symbol,
                timeframe=timeframe,
                period="CUSTOM",
                bars=[],
                count=0,
                last_updated=datetime.now().isoformat(),
            )

        if indicators:
            candlesticks = _calculate_indicators(bars_data, indicators)
        else:
            candlesticks = [CandlestickBar(**bar_data) for bar_data in bars_data]

        candlesticks.sort(key=lambda x: x.timestamp, reverse=True)
        logger.info(
            "bars_processed_range_indicators",
            symbol=symbol,
            timeframe=timeframe,
            start=start_date_str,
            end=end_date_str,
            processed=len(candlesticks),
        )
        return HistoricalDataResponse(
            symbol=symbol,
            timeframe=timeframe,
            period="CUSTOM",
            bars=candlesticks,
            count=len(candlesticks),
            last_updated=datetime.now().isoformat(),
        )
    except Exception as e:  # noqa: BLE001
        logger.error("bars_processed_range_indicators_failed", err=str(e))
        return process_bars_with_date_range(bars, symbol, timeframe, start_date_str, end_date_str)
