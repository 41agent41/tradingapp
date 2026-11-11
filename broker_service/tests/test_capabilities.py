"""What each connection reports it supports (capabilities.py, E-19)."""

from __future__ import annotations

from capabilities import capabilities


def _adapter(cls):
    # The declarations are class attributes; no venue is touched.
    return cls.__new__(cls)


def test_a_connection_with_no_adapters_supports_nothing():
    caps = capabilities(None, None)
    assert caps == {
        "market_data": False,
        "trading": False,
        "timeframes": [],
        "live_prices": None,
        "spread_bars": False,
        "order_types": {},
        "attaches_stops": False,
        "fills": None,
    }


def test_an_adapter_that_declares_nothing_gets_the_standard_set():
    class Plain:
        def tick(self, symbol):
            return {}

    caps = capabilities(Plain(), Plain())
    assert caps["timeframes"] == ["1min", "5min", "15min", "30min", "1hour", "4hour", "1day"]
    assert caps["live_prices"] == "poll"
    assert caps["fills"] == "poll"
    assert list(caps["order_types"]) == ["MKT", "LMT", "STP", "STP_LMT"]
    assert caps["order_types"]["LMT"] == ["DAY", "GTC", "IOC", "FOK"]
    assert caps["attaches_stops"] is False


def test_oanda_streams_prices_and_fills_and_has_spread_bars():
    from oanda_adapter import OANDAAdapter

    oanda = _adapter(OANDAAdapter)
    caps = capabilities(oanda, oanda)
    assert "8hour" in caps["timeframes"] and "tick" not in caps["timeframes"]
    assert caps["live_prices"] == "stream"
    assert caps["fills"] == "stream"
    assert caps["spread_bars"] is True
    assert caps["attaches_stops"] is True
    assert list(caps["order_types"]) == ["MKT", "LMT", "STP", "STP_LMT"]


def test_ig_has_no_stop_limit_and_rests_working_orders_day_or_gtc():
    from ig_adapter import IGAdapter

    ig = _adapter(IGAdapter)
    caps = capabilities(ig, ig)
    assert list(caps["order_types"]) == ["MKT", "LMT", "STP"]
    assert caps["order_types"]["LMT"] == ["DAY", "GTC"]
    assert caps["order_types"]["MKT"] == ["DAY", "GTC", "IOC", "FOK"]
    assert "8hour" not in caps["timeframes"]
    # A push says something traded; the fills are then read.
    assert caps["fills"] == "signal"
    assert caps["spread_bars"] is False


def test_ib_serves_ticks_and_streams_through_its_own_socket():
    from ib_adapter import IBAdapter

    ib = IBAdapter()
    caps = capabilities(ib, ib)
    assert caps["timeframes"][0] == "tick" and "8hour" in caps["timeframes"]
    assert caps["live_prices"] == "stream"
    assert caps["fills"] == "poll"
    assert caps["attaches_stops"] is False


def test_ibweb_takes_no_fill_or_kill():
    from ibweb_adapter import IBWebAdapter

    ibweb = _adapter(IBWebAdapter)
    caps = capabilities(ibweb, ibweb)
    assert caps["order_types"]["MKT"] == ["DAY", "GTC", "IOC"]
    assert caps["live_prices"] == "poll"


def test_every_declared_timeframe_and_order_type_is_one_the_adapter_maps():
    """A declaration that drifts from the adapter's own tables would offer
    something the broker then refuses."""
    import alpaca_adapter
    import ctrader_adapter
    import ibweb_adapter
    import ig_adapter
    import mt5_adapter
    import oanda_adapter

    tables = [
        (alpaca_adapter.AlpacaAdapter, alpaca_adapter._TIMEFRAME_TO_ALPACA),
        (ctrader_adapter.CTraderAdapter, ctrader_adapter._TIMEFRAME_TO_PERIOD),
        (ibweb_adapter.IBWebAdapter, ibweb_adapter._TIMEFRAME_TO_BAR),
        (ig_adapter.IGAdapter, ig_adapter._TIMEFRAME_TO_RESOLUTION),
        (mt5_adapter.MT5Adapter, mt5_adapter._TIMEFRAME_TO_MT5),
        (oanda_adapter.OANDAAdapter, oanda_adapter._TIMEFRAME_TO_GRANULARITY),
    ]
    for cls, table in tables:
        assert set(cls.timeframes) == set(table), cls.__name__
        assert set(cls.order_tifs) <= {"MKT", "LMT", "STP", "STP_LMT"}, cls.__name__


def test_a_split_account_reports_the_execution_sides_orders():
    from mt5_adapter import MT5Adapter
    from split_account_adapter import SplitAccountAdapter

    mt5 = _adapter(MT5Adapter)
    split = SplitAccountAdapter(execution=mt5, account_info=object())
    caps = capabilities(mt5, split)
    assert caps["order_types"]["LMT"] == ["DAY", "GTC"]
    assert caps["attaches_stops"] is True
