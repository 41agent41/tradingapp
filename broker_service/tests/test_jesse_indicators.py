"""``jesse.indicators`` — numerics, calling convention, and the prefix cache."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

import jesse.indicators as ta
from jesse import candles as C
from jesse.strategy import CandleStore


def make_candles(n: int = 300, seed: int = 1) -> np.ndarray:
    rng = np.random.default_rng(seed)
    close = 100 + np.cumsum(rng.normal(0, 1, n))
    high = close + np.abs(rng.normal(0.5, 0.2, n))
    low = close - np.abs(rng.normal(0.5, 0.2, n))
    open_ = np.concatenate([[close[0]], close[:-1]])
    vol = rng.integers(1_000, 5_000, n).astype(float)
    ts = 1_700_000_000_000 + np.arange(n) * 300_000
    return np.column_stack([ts, open_, close, high, low, vol]).astype("float64")


@pytest.fixture
def candles() -> np.ndarray:
    return make_candles()


class TestConvention:
    def test_non_sequential_returns_last_float(self, candles):
        value = ta.sma(candles, 20)
        assert isinstance(value, float)
        assert value == pytest.approx(candles[-20:, C.CLOSE].mean())

    def test_sequential_returns_full_array_with_nan_warmup(self, candles):
        seq = ta.sma(candles, 20, sequential=True)
        assert seq.shape == (len(candles),)
        assert np.isnan(seq[:19]).all()
        assert not np.isnan(seq[19:]).any()

    def test_source_types(self, candles):
        assert ta.sma(candles, 5, source_type="high") == pytest.approx(candles[-5:, C.HIGH].mean())
        hlc3 = (candles[:, C.HIGH] + candles[:, C.LOW] + candles[:, C.CLOSE]) / 3
        assert ta.sma(candles, 5, source_type="hlc3") == pytest.approx(hlc3[-5:].mean())
        with pytest.raises(ValueError):
            ta.sma(candles, 5, source_type="nope")

    def test_one_dimensional_series_input_composes(self, candles):
        rsi_seq = ta.rsi(candles, 14, sequential=True)
        smoothed = ta.ema(rsi_seq, 5)
        assert isinstance(smoothed, float) and np.isfinite(smoothed)

    def test_namedtuple_outputs(self, candles):
        m = ta.macd(candles)
        assert hasattr(m, "macd") and hasattr(m, "signal") and hasattr(m, "hist")
        assert m.hist == pytest.approx(m.macd - m.signal)
        bb = ta.bollinger_bands(candles, 20, sequential=True)
        assert bb.upperband.shape == (len(candles),)
        assert np.all(bb.upperband[19:] >= bb.lowerband[19:])

    def test_invalid_period(self, candles):
        with pytest.raises(ValueError):
            ta.sma(candles, 0)


class TestNumerics:
    def test_ema_matches_talib_style_seed(self, candles):
        close = candles[:, C.CLOSE]
        period = 10
        seq = ta.ema(candles, period, sequential=True)
        # Seed = SMA of the first `period` values, then standard recursion.
        expected = np.full(len(close), np.nan)
        expected[period - 1] = close[:period].mean()
        alpha = 2 / (period + 1)
        for i in range(period, len(close)):
            expected[i] = (close[i] - expected[i - 1]) * alpha + expected[i - 1]
        np.testing.assert_allclose(seq[period - 1 :], expected[period - 1 :])

    def test_rsi_bounds_and_direction(self):
        rising = make_candles(60)
        rising[:, C.CLOSE] = np.linspace(100, 160, 60)
        assert ta.rsi(rising, 14) == pytest.approx(100.0)
        falling = rising.copy()
        falling[:, C.CLOSE] = np.linspace(160, 100, 60)
        assert ta.rsi(falling, 14) == pytest.approx(0.0)
        mixed = ta.rsi(make_candles(400), 14, sequential=True)
        valid = mixed[~np.isnan(mixed)]
        assert (valid >= 0).all() and (valid <= 100).all()

    def test_atr_is_wilder_smoothed_true_range(self, candles):
        tr = ta.trange(candles, sequential=True)
        atr = ta.atr(candles, 14, sequential=True)
        expected = np.full(len(tr), np.nan)
        expected[13] = tr[:14].mean()
        for i in range(14, len(tr)):
            expected[i] = expected[i - 1] + (tr[i] - expected[i - 1]) / 14
        np.testing.assert_allclose(atr[13:], expected[13:])

    def test_bollinger_uses_population_std(self, candles):
        bb = ta.bollinger_bands(candles, 20, 2, 2)
        window = candles[-20:, C.CLOSE]
        assert bb.middleband == pytest.approx(window.mean())
        assert bb.upperband == pytest.approx(window.mean() + 2 * window.std(ddof=0))

    def test_wma_weights_newest_heaviest(self):
        c = make_candles(10)
        c[:, C.CLOSE] = np.arange(1, 11, dtype=float)
        weights = np.arange(1, 4)
        assert ta.wma(c, 3) == pytest.approx(np.dot([8, 9, 10], weights) / weights.sum())

    def test_stoch_within_bounds(self, candles):
        st = ta.stoch(candles, sequential=True)
        valid = st.k[~np.isnan(st.k)]
        assert (valid >= -1e-9).all() and (valid <= 100 + 1e-9).all()

    def test_adx_and_di_finite(self, candles):
        assert np.isfinite(ta.adx(candles, 14))
        d = ta.di(candles, 14)
        assert np.isfinite(d.plus) and np.isfinite(d.minus)

    def test_supertrend_flips_direction(self, candles):
        st = ta.supertrend(candles, 10, 3, sequential=True)
        assert st.changed.sum() >= 1
        assert np.isfinite(st.trend[-1])

    def test_obv_and_vwap(self, candles):
        obv = ta.obv(candles, sequential=True)
        direction = np.sign(np.diff(candles[:, C.CLOSE]))
        assert obv[-1] == pytest.approx(np.sum(direction * candles[1:, C.VOLUME]))
        vwap = ta.vwap(candles)
        hlc3 = (candles[:, C.HIGH] + candles[:, C.LOW] + candles[:, C.CLOSE]) / 3
        assert vwap == pytest.approx(
            np.sum(hlc3 * candles[:, C.VOLUME]) / candles[:, C.VOLUME].sum()
        )

    def test_every_listed_indicator_runs(self, candles):
        for name in ta.AVAILABLE:
            fn = getattr(ta, name)
            result = fn(candles)
            values = result if isinstance(result, tuple) else (result,)
            for v in values:
                assert isinstance(v, float)

    def test_sma_matches_pandas_rolling(self, candles):
        seq = ta.sma(candles, 7, sequential=True)
        ref = pd.Series(candles[:, C.CLOSE]).rolling(7).mean().to_numpy()
        np.testing.assert_allclose(seq[6:], ref[6:])


class TestPrefixCache:
    """``Strategy.candles`` is a prefix view of the store; cached results must be
    indistinguishable from direct computation on the prefix."""

    @pytest.mark.parametrize(
        "fn,kwargs",
        [
            (ta.sma, {"period": 20}),
            (ta.ema, {"period": 9}),
            (ta.rsi, {"period": 14}),
            (ta.atr, {"period": 14}),
            (ta.macd, {}),
            (ta.bollinger_bands, {"period": 20}),
            (ta.supertrend, {}),
            (ta.vwap, {}),
        ],
    )
    def test_cached_prefix_equals_direct(self, candles, fn, kwargs):
        store = CandleStore(candles, "5m")
        for idx in (30, 120, 299):
            store.index = idx
            cached = fn(store.visible, **kwargs)
            direct = fn(np.asarray(candles[: idx + 1]), **kwargs)
            cached_vals = cached if isinstance(cached, tuple) else (cached,)
            direct_vals = direct if isinstance(direct, tuple) else (direct,)
            for a, b in zip(cached_vals, direct_vals, strict=True):
                if np.isnan(b):
                    assert np.isnan(a)
                else:
                    assert a == pytest.approx(b)

    def test_cache_populated_once_and_reused(self, candles):
        store = CandleStore(candles, "5m")
        store.index = 50
        ta.sma(store.visible, 20)
        assert len(store.candles._jesse_cache) == 1
        store.index = 100
        ta.sma(store.visible, 20)
        ta.sma(store.visible, 20, sequential=True)
        assert len(store.candles._jesse_cache) == 1  # same key, sequential is not part of it
        ta.sma(store.visible, 30)
        assert len(store.candles._jesse_cache) == 2

    def test_tail_slice_is_not_served_from_cache(self, candles):
        store = CandleStore(candles, "5m")
        store.index = 299
        tail = store.visible[-50:]
        assert C.prefix_root(tail) is None
        assert ta.sma(tail, 10) == pytest.approx(candles[-10:, C.CLOSE].mean())

    def test_sequential_prefix_length_matches_view(self, candles):
        store = CandleStore(candles, "5m")
        store.index = 41
        assert ta.ema(store.visible, 5, sequential=True).shape == (42,)
