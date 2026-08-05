"""
Unit tests for `indicators.py`.

The indicator math is pure pandas/numpy and the easiest first target
for the test suite (see GAP_ANALYSIS.md §4.1). The goal is to lock down
the known-good outputs so refactors of the IB service don't silently
drift the indicator values.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest

from indicators import IndicatorCalculator, TechnicalIndicators, calculator

# ---------------------------------------------------------------------------
# TREND
# ---------------------------------------------------------------------------


class TestTrend:
    def test_sma_constant_series_equals_constant(self, constant_series: pd.Series) -> None:
        out = TechnicalIndicators.sma(constant_series, period=10)
        assert (out == 50.0).all()
        assert len(out) == len(constant_series)

    def test_sma_linear_series_lags_by_half_window(self, linear_series: pd.Series) -> None:
        # For 1..100, SMA(10) at index 9 is mean(1..10) = 5.5; at index 99
        # it's mean(91..100) = 95.5.
        out = TechnicalIndicators.sma(linear_series, period=10)
        assert out.iloc[9] == pytest.approx(5.5)
        assert out.iloc[99] == pytest.approx(95.5)

    def test_sma_min_periods_one_means_first_value_is_first_observation(
        self, linear_series: pd.Series
    ) -> None:
        # Implementation passes `min_periods=1`, so the first value is
        # the first observation rather than NaN.
        out = TechnicalIndicators.sma(linear_series, period=10)
        assert out.iloc[0] == pytest.approx(1.0)
        assert not out.isna().any()

    def test_ema_constant_series_equals_constant(self, constant_series: pd.Series) -> None:
        out = TechnicalIndicators.ema(constant_series, period=20)
        assert (out == 50.0).all()

    def test_ema_responds_faster_than_sma_to_shock(self) -> None:
        # 50 flat values then a sudden jump to 100. The EMA should
        # converge towards 100 faster than the SMA across the same
        # period.
        data = pd.Series([50.0] * 50 + [100.0] * 50)
        period = 10
        sma_tail = TechnicalIndicators.sma(data, period=period).iloc[55]
        ema_tail = TechnicalIndicators.ema(data, period=period).iloc[55]
        assert ema_tail > sma_tail
        # And both must be between 50 and 100.
        assert 50.0 < sma_tail < 100.0
        assert 50.0 < ema_tail < 100.0


# ---------------------------------------------------------------------------
# MACD
# ---------------------------------------------------------------------------


class TestMACD:
    def test_macd_keys(self, synthetic_ohlcv: pd.DataFrame) -> None:
        out = TechnicalIndicators.macd(synthetic_ohlcv["close"])
        assert set(out.keys()) == {"macd", "signal", "histogram"}
        for series in out.values():
            assert len(series) == len(synthetic_ohlcv)

    def test_macd_histogram_is_difference_of_macd_and_signal(
        self, synthetic_ohlcv: pd.DataFrame
    ) -> None:
        out = TechnicalIndicators.macd(synthetic_ohlcv["close"])
        diff = out["macd"] - out["signal"]
        # Tail comparison — the EMA initialisation creates noise in the
        # first few rows.
        pd.testing.assert_series_equal(out["histogram"].iloc[20:], diff.iloc[20:])

    def test_macd_on_constant_series_is_zero(self, constant_series: pd.Series) -> None:
        out = TechnicalIndicators.macd(constant_series)
        # After enough warm-up everything should round to zero.
        assert out["macd"].iloc[-1] == pytest.approx(0.0, abs=1e-9)
        assert out["signal"].iloc[-1] == pytest.approx(0.0, abs=1e-9)
        assert out["histogram"].iloc[-1] == pytest.approx(0.0, abs=1e-9)


# ---------------------------------------------------------------------------
# MOMENTUM
# ---------------------------------------------------------------------------


class TestMomentum:
    def test_rsi_strictly_rising_prices_drives_value_to_100(self, linear_series: pd.Series) -> None:
        out = TechnicalIndicators.rsi(linear_series, period=14)
        # Once warmed up, every delta is +1, so loss=0 and RSI=100.
        assert out.iloc[-1] == pytest.approx(100.0)

    def test_rsi_strictly_falling_prices_drives_value_to_zero(self) -> None:
        data = pd.Series(np.arange(100.0, 0.0, -1.0))
        out = TechnicalIndicators.rsi(data, period=14)
        assert out.iloc[-1] == pytest.approx(0.0)

    def test_stochastic_keys_and_bounds(self, synthetic_ohlcv: pd.DataFrame) -> None:
        out = TechnicalIndicators.stochastic(
            synthetic_ohlcv["high"], synthetic_ohlcv["low"], synthetic_ohlcv["close"]
        )
        assert set(out.keys()) == {"%K", "%D"}
        # Once warmed up, both %K and %D must sit in [0, 100].
        warm_k = out["%K"].dropna()
        warm_d = out["%D"].dropna()
        assert (warm_k >= 0).all() and (warm_k <= 100).all()
        assert (warm_d >= 0).all() and (warm_d <= 100).all()

    def test_williams_r_is_non_positive(self, synthetic_ohlcv: pd.DataFrame) -> None:
        out = TechnicalIndicators.williams_r(
            synthetic_ohlcv["high"], synthetic_ohlcv["low"], synthetic_ohlcv["close"]
        )
        # Williams %R is defined as a non-positive value in [-100, 0].
        assert (out.dropna() <= 0).all()
        assert (out.dropna() >= -100).all()

    def test_roc_on_constant_series_is_zero(self, constant_series: pd.Series) -> None:
        out = TechnicalIndicators.roc(constant_series, period=10)
        # NaNs in the warm-up, but everything after must be zero.
        assert out.iloc[10:].abs().max() == pytest.approx(0.0)


# ---------------------------------------------------------------------------
# VOLATILITY
# ---------------------------------------------------------------------------


class TestVolatility:
    def test_bollinger_bands_ordering(self, synthetic_ohlcv: pd.DataFrame) -> None:
        bb = TechnicalIndicators.bollinger_bands(synthetic_ohlcv["close"], period=20)
        warm = bb["upper"].notna()
        assert (bb["upper"][warm] >= bb["middle"][warm]).all()
        assert (bb["middle"][warm] >= bb["lower"][warm]).all()

    def test_bollinger_bands_on_constant_series_collapse_to_the_mean(
        self, constant_series: pd.Series
    ) -> None:
        bb = TechnicalIndicators.bollinger_bands(constant_series, period=20)
        # With zero variance the bands collapse onto the middle line.
        warm = bb["middle"].notna()
        assert (bb["upper"][warm] == bb["middle"][warm]).all()
        assert (bb["lower"][warm] == bb["middle"][warm]).all()

    def test_atr_is_non_negative(self, synthetic_ohlcv: pd.DataFrame) -> None:
        out = TechnicalIndicators.atr(
            synthetic_ohlcv["high"], synthetic_ohlcv["low"], synthetic_ohlcv["close"]
        )
        warm = out.dropna()
        assert (warm >= 0).all()


# ---------------------------------------------------------------------------
# VOLUME
# ---------------------------------------------------------------------------


class TestVolume:
    def test_obv_strictly_rising_close_accumulates_volume(self) -> None:
        close = pd.Series([10.0, 11.0, 12.0, 13.0, 14.0])
        volume = pd.Series([100, 200, 300, 400, 500])
        out = TechnicalIndicators.obv(close, volume)
        # First diff is NaN → direction 0, then +1 every step.
        # cumsum of (100*0, 200*1, 300*1, 400*1, 500*1)
        expected = pd.Series([0, 200, 500, 900, 1400], dtype=out.dtype)
        pd.testing.assert_series_equal(out.astype("int64"), expected.astype("int64"))

    def test_vwap_matches_closed_form_for_constant_typical_price(self) -> None:
        # Typical price (h+l+c)/3 = constant 100 with any volume profile
        # should produce a flat VWAP at 100.
        n = 20
        high = pd.Series([101.0] * n)
        low = pd.Series([99.0] * n)
        close = pd.Series([100.0] * n)
        volume = pd.Series([1] * n)
        out = TechnicalIndicators.vwap(high, low, close, volume)
        # Compare element-wise via numpy.allclose so pytest.approx isn't
        # in the way of the Series-vs-scalar broadcast.
        assert np.allclose(out.values, 100.0)

    def test_volume_sma_default_period_matches_rolling_mean(
        self, synthetic_ohlcv: pd.DataFrame
    ) -> None:
        out = TechnicalIndicators.volume_sma(synthetic_ohlcv["volume"])
        # Period defaults to 20.
        expected = synthetic_ohlcv["volume"].rolling(window=20).mean()
        pd.testing.assert_series_equal(out, expected)


# ---------------------------------------------------------------------------
# PIVOT POINTS
# ---------------------------------------------------------------------------


class TestPivotPoints:
    def test_pivot_points_keys(self, synthetic_ohlcv: pd.DataFrame) -> None:
        out = TechnicalIndicators.pivot_points(
            synthetic_ohlcv["high"], synthetic_ohlcv["low"], synthetic_ohlcv["close"]
        )
        assert set(out.keys()) == {"pivot", "r1", "r2", "s1", "s2"}

    def test_pivot_relations(self, synthetic_ohlcv: pd.DataFrame) -> None:
        out = TechnicalIndicators.pivot_points(
            synthetic_ohlcv["high"], synthetic_ohlcv["low"], synthetic_ohlcv["close"]
        )
        # By construction R1 > pivot > S1 once the series is warm.
        warm = out["pivot"].notna()
        assert (out["r1"][warm] > out["pivot"][warm]).all()
        assert (out["pivot"][warm] > out["s1"][warm]).all()


# ---------------------------------------------------------------------------
# IndicatorCalculator façade
# ---------------------------------------------------------------------------


class TestIndicatorCalculator:
    def test_global_singleton_is_instance(self) -> None:
        assert isinstance(calculator, IndicatorCalculator)

    def test_calculate_indicators_adds_requested_columns(
        self, synthetic_ohlcv: pd.DataFrame
    ) -> None:
        out = calculator.calculate_indicators(synthetic_ohlcv, ["sma_20", "ema_12", "rsi"])
        assert "sma_20" in out.columns
        assert "ema_12" in out.columns
        assert "rsi" in out.columns
        # Original frame must not be mutated.
        assert "sma_20" not in synthetic_ohlcv.columns
        # Row count is preserved.
        assert len(out) == len(synthetic_ohlcv)

    def test_calculate_indicators_macd_expands_into_three_columns(
        self, synthetic_ohlcv: pd.DataFrame
    ) -> None:
        out = calculator.calculate_indicators(synthetic_ohlcv, ["macd"])
        assert {"macd", "macd_signal", "macd_histogram"}.issubset(out.columns)

    def test_calculate_indicators_unknown_indicator_is_ignored_with_warning(
        self, synthetic_ohlcv: pd.DataFrame, caplog: pytest.LogCaptureFixture
    ) -> None:
        with caplog.at_level("WARNING"):
            out = calculator.calculate_indicators(synthetic_ohlcv, ["definitely_not_real"])
        assert "definitely_not_real" in caplog.text
        # No new columns added beyond the OHLCV input.
        assert set(out.columns) == set(synthetic_ohlcv.columns)

    def test_get_available_indicators_returns_expected_categories(self) -> None:
        catalogue = calculator.get_available_indicators()
        for category in ("trend", "momentum", "volatility", "volume"):
            assert category in catalogue
            assert isinstance(catalogue[category], dict)
            assert len(catalogue[category]) > 0


# ---------------------------------------------------------------------------
# Numerical sanity
# ---------------------------------------------------------------------------


def test_no_indicator_emits_inf_for_well_formed_input(synthetic_ohlcv: pd.DataFrame) -> None:
    """A regression guard: no indicator should ever emit +/- inf for a
    well-formed OHLCV frame."""
    indicators_to_run = [
        "sma_20",
        "sma_50",
        "ema_12",
        "ema_26",
        "rsi",
        "macd",
        "bollinger",
        "stochastic",
        "atr",
        "obv",
        "vwap",
        "volume_sma",
    ]
    out = calculator.calculate_indicators(synthetic_ohlcv, indicators_to_run)
    numeric = out.select_dtypes(include=[np.number])
    finite = numeric.replace([np.inf, -np.inf], np.nan)
    # No infinities anywhere.
    assert not numeric.isin([np.inf, -np.inf]).any().any()
    # And the NaN counts haven't changed because of inf masking.
    assert finite.isna().sum().sum() == numeric.isna().sum().sum()


def test_macd_signal_period_is_used() -> None:
    """If we pass an absurdly long signal period the histogram tail
    must still be finite — this exercises the signal_period kwarg."""
    data = pd.Series(np.linspace(50.0, 150.0, 200))
    out = TechnicalIndicators.macd(data, fast_period=12, slow_period=26, signal_period=50)
    assert math.isfinite(out["histogram"].iloc[-1])
