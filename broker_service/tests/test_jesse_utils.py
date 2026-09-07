"""``jesse.utils``, ``jesse.timeframes``, ``jesse.candles`` and ``jesse.helpers``."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from jesse import candles as C
from jesse import helpers, utils
from jesse import timeframes as tf
from jesse.models import StrategyError


class TestSizing:
    def test_size_to_qty_floors(self):
        assert utils.size_to_qty(1000, 3, precision=0) == 333
        assert utils.size_to_qty(1000, 3, precision=3) == 333.333

    def test_size_to_qty_reserves_fees(self):
        assert utils.size_to_qty(1000, 10, precision=3, fee_rate=0.001) == pytest.approx(99.7)

    def test_size_to_qty_rejects_nan(self):
        with pytest.raises(TypeError):
            utils.size_to_qty(float("nan"), 10)

    def test_qty_to_size(self):
        assert utils.qty_to_size(5, 20) == 100

    def test_risk_to_qty_basic(self):
        # Risk 1% of 10,000 = $100 over a $2 stop -> 50 units.
        assert utils.risk_to_qty(10_000, 1, 100, 98) == 50

    def test_risk_to_qty_caps_at_capital(self):
        # A tiny stop would imply more notional than the capital: capped.
        assert utils.risk_to_qty(10_000, 1, 100, 99.99, precision=0) == 100

    def test_risk_to_size_rejects_zero_stop_distance(self):
        with pytest.raises(ValueError):
            utils.risk_to_size(1000, 1, 0, 100)

    def test_limit_stop_loss(self):
        assert utils.limit_stop_loss(100, 90, "long", 5) == 95
        assert utils.limit_stop_loss(100, 110, "short", 5) == 105
        assert utils.limit_stop_loss(100, 97, "long", 5) == 97

    def test_kelly(self):
        assert utils.kelly_criterion(0.6, 2) == pytest.approx(0.4)
        assert utils.kelly_criterion(0.6, 0) == 0.0


class TestCrossed:
    def test_scalar_level(self):
        assert utils.crossed([1, 2, 3], 2.5, "above") is True
        assert utils.crossed([3, 2], 2.5, "below") is True
        assert utils.crossed([3, 2, 1], 2.5, "below") is False  # crossed one candle earlier
        assert utils.crossed([1, 2, 3], 2.5, "below") is False
        assert utils.crossed([1, 2, 3], 2.5) is True

    def test_series_vs_series(self):
        fast = np.array([1.0, 2.0, 4.0])
        slow = np.array([3.0, 3.0, 3.0])
        assert utils.crossed(fast, slow, "above") is True
        assert utils.crossed(fast, slow, "below") is False

    def test_sequential(self):
        flags = utils.crossed([1, 3, 1, 3], 2, sequential=True)
        assert flags.tolist() == [False, True, True, True]

    def test_touching_then_leaving_counts(self):
        # Previous <= level then above: a cross.
        assert utils.crossed([2, 3], 2, "above") is True

    def test_bad_direction(self):
        with pytest.raises(ValueError):
            utils.crossed([1, 2], 1.5, "sideways")


class TestTimeframes:
    def test_normalize_both_dialects(self):
        assert tf.normalize("5min") == "5m"
        assert tf.normalize("5m") == "5m"
        assert tf.normalize("1hour") == "1h"
        assert tf.normalize("1day") == "1D"
        assert tf.normalize("1d") == "1D"

    def test_to_app(self):
        assert tf.to_app("1h") == "1hour"
        assert tf.to_app("4hour") == "4hour"

    def test_seconds(self):
        assert tf.to_seconds("5min") == 300
        assert tf.to_milliseconds("1D") == 86_400_000

    def test_unknown(self):
        with pytest.raises(tf.TimeframeError):
            tf.normalize("3min")

    def test_anchor(self):
        assert utils.anchor_timeframe("5m") == "30m"
        assert utils.anchor_timeframe("5min") == "30m"
        assert utils.anchor_timeframe("1hour") == "4h"
        assert utils.anchor_timeframe("1D") == "1W"
        with pytest.raises(tf.TimeframeError):
            tf.anchor("1W")

    def test_is_higher(self):
        assert tf.is_higher("1h", "5m")
        assert not tf.is_higher("5m", "1h")
        assert not tf.is_higher("5m", "5m")


class TestCandles:
    def _df(self, n=10, unit="ns", start="2025-01-02 14:30"):
        idx = pd.date_range(start, periods=n, freq="5min").as_unit(unit)
        return pd.DataFrame(
            {
                "open": np.arange(n, dtype=float) + 100,
                "high": np.arange(n, dtype=float) + 101,
                "low": np.arange(n, dtype=float) + 99,
                "close": np.arange(n, dtype=float) + 100.5,
                "volume": np.full(n, 1000.0),
            },
            index=idx,
        )

    @pytest.mark.parametrize("unit", ["ns", "us", "ms", "s"])
    def test_from_dataframe_any_index_resolution(self, unit):
        arr = C.from_dataframe(self._df(unit=unit))
        assert arr.shape == (10, 6)
        expected = pd.Timestamp("2025-01-02 14:30").value / 1_000_000
        assert arr[0, C.TIMESTAMP] == expected
        assert arr[1, C.TIMESTAMP] - arr[0, C.TIMESTAMP] == 300_000

    def test_from_dataframe_prefers_timestamp_column(self):
        df = self._df()
        df["timestamp"] = 1_700_000_000 + np.arange(10) * 300
        arr = C.from_dataframe(df)
        assert arr[0, C.TIMESTAMP] == 1_700_000_000_000

    def test_column_order_is_jesse_layout(self):
        arr = C.from_dataframe(self._df())
        assert arr[0, C.OPEN] == 100 and arr[0, C.CLOSE] == 100.5
        assert arr[0, C.HIGH] == 101 and arr[0, C.LOW] == 99

    def test_round_trip(self):
        df = self._df()
        back = C.to_dataframe(C.from_dataframe(df))
        np.testing.assert_allclose(back["close"].to_numpy(), df["close"].to_numpy())
        assert back.index[0] == df.index[0]

    def test_sorted_and_deduplicated(self):
        df = self._df()
        shuffled = pd.concat([df.iloc[::-1], df.iloc[[3]]])
        arr = C.from_dataframe(shuffled)
        assert len(arr) == 10
        assert np.all(np.diff(arr[:, C.TIMESTAMP]) > 0)

    def test_resample_aggregates_ohlcv(self):
        arr = C.from_dataframe(self._df(n=12, start="2025-01-02 14:00"))  # one full hour
        hourly = C.resample(arr, "5m", "1h")
        assert len(hourly) == 1
        assert hourly[0, C.OPEN] == arr[0, C.OPEN]
        assert hourly[0, C.CLOSE] == arr[-1, C.CLOSE]
        assert hourly[0, C.HIGH] == arr[:, C.HIGH].max()
        assert hourly[0, C.LOW] == arr[:, C.LOW].min()
        assert hourly[0, C.VOLUME] == 12_000

    def test_resample_requires_larger_multiple(self):
        arr = C.from_dataframe(self._df())
        with pytest.raises(C.CandleError):
            C.resample(arr, "5m", "1m")

    def test_closed_before_hides_the_forming_candle(self):
        arr = C.from_dataframe(self._df(n=30))  # 2.5 hours from 14:30
        hourly = C.resample(arr, "5m", "1h")  # buckets 14:00, 15:00, 16:00
        assert len(hourly) == 3
        # At the close of the 14:55 candle (15:00) the 14:00 bucket has closed.
        t = arr[5, C.TIMESTAMP] + 300_000
        assert len(C.closed_before(hourly, "1h", t)) == 1
        # One candle earlier, nothing has closed yet.
        assert len(C.closed_before(hourly, "1h", t - 300_000)) == 0
        # At the very end (16:55 close -> 17:00) all three have closed.
        assert len(C.closed_before(hourly, "1h", arr[-1, C.TIMESTAMP] + 300_000)) == 3

    def test_infer_timeframe(self):
        assert C.infer_timeframe(C.from_dataframe(self._df())) == "5m"

    def test_prefix_root_detection(self):
        arr = C.CandleArray(C.from_dataframe(self._df()))
        assert C.prefix_root(arr[:4]) is arr
        assert C.prefix_root(arr[2:6]) is None
        assert C.prefix_root(np.asarray(arr)[:4]) is None


class TestHelpers:
    def test_class_name_to_key(self):
        assert helpers.class_name_to_key("SMACrossover") == "sma_crossover"
        assert helpers.class_name_to_key("MSFTTrendFollower") == "msft_trend_follower"
        assert helpers.class_name_to_key("RSIMeanReversion") == "rsi_mean_reversion"

    def test_timestamps(self):
        assert helpers.timestamp_to_date(1_700_000_000_000) == "2023-11-14"
        assert helpers.date_to_timestamp("2023-11-14") == 1_699_920_000_000
        assert helpers.timeframe_to_one_minutes("1h") == 60


def test_numpy_candles_to_dataframe():
    arr = C.from_dataframe(TestCandles()._df())
    df = utils.numpy_candles_to_dataframe(arr)
    assert list(df.columns) == ["open", "high", "low", "close", "volume"]
    assert df.index.name == "date"


def test_strategy_error_is_exception():
    assert issubclass(StrategyError, Exception)
