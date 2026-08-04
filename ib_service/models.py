"""
Pydantic request / response schemas for the IB service.

Extracted from main.py during the GAP_ANALYSIS §3.4 module split. The
schemas have no runtime dependencies — they're pure data — so they're the
safest first move.
"""

from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, Field


class MarketDataRequest(BaseModel):
    symbol: str = Field(..., min_length=1, max_length=10)
    timeframe: str = Field(..., pattern=r"^(tick|1min|5min|15min|30min|1hour|4hour|8hour|1day)$")
    period: str = Field(default="1Y", pattern=r"^(1D|1W|1M|3M|6M|1Y)$")


class CandlestickBar(BaseModel):
    timestamp: float
    open: float
    high: float
    low: float
    close: float
    volume: int

    # Technical Indicators (optional fields)
    sma_20: Optional[float] = None
    sma_50: Optional[float] = None
    ema_12: Optional[float] = None
    ema_26: Optional[float] = None
    rsi: Optional[float] = None
    macd: Optional[float] = None
    macd_signal: Optional[float] = None
    macd_histogram: Optional[float] = None
    bb_upper: Optional[float] = None
    bb_middle: Optional[float] = None
    bb_lower: Optional[float] = None
    stoch_k: Optional[float] = None
    stoch_d: Optional[float] = None
    atr: Optional[float] = None
    obv: Optional[float] = None
    vwap: Optional[float] = None
    volume_sma: Optional[float] = None


class HistoricalDataResponse(BaseModel):
    symbol: str
    timeframe: str
    period: str
    bars: List[CandlestickBar]
    count: int
    last_updated: str


class RealTimeQuote(BaseModel):
    symbol: str
    bid: Optional[float] = None
    ask: Optional[float] = None
    last: Optional[float] = None
    volume: Optional[int] = None
    timestamp: str


class SearchRequest(BaseModel):
    symbol: str
    secType: str = "STK"
    exchange: str = "SMART"
    currency: str = "USD"
    name: bool = False
    account_mode: str = "paper"
    # Broker-scoped source (B1). Defaults to IB; contract universes are keyed
    # per broker (no cross-broker symbol reconciliation).
    source: str = "ib"


class AdvancedSearchRequest(BaseModel):
    symbol: str = ""
    secType: str = "STK"
    exchange: str = "SMART"
    currency: str = "USD"
    expiry: str = ""
    strike: float = 0
    right: str = ""
    multiplier: str = ""
    includeExpired: bool = False
    name: bool = False
    account_mode: str = "paper"


class SymbolDiscoveryRequest(BaseModel):
    pattern: str  # Search pattern (partial symbol)
    secType: str = "STK"
    exchange: str = "SMART"
    currency: str = "USD"
    max_results: int = 50
    use_fallback: bool = True  # Whether to use reqMatchingSymbols as fallback
    account_mode: str = "paper"


# Account-related models
class AccountSummary(BaseModel):
    account_id: str
    net_liquidation: Optional[float] = None
    currency: str = "USD"
    last_updated: str

    # Optional fields
    total_cash_value: Optional[float] = None
    buying_power: Optional[float] = None
    maintenance_margin: Optional[float] = None


class Position(BaseModel):
    symbol: str
    position: float
    market_price: Optional[float] = None
    market_value: Optional[float] = None
    average_cost: Optional[float] = None
    unrealized_pnl: Optional[float] = None
    currency: str = "USD"


class Order(BaseModel):
    order_id: int
    symbol: str
    action: str  # BUY/SELL
    quantity: float
    order_type: str
    status: str
    filled_quantity: Optional[float] = None
    remaining_quantity: Optional[float] = None
    avg_fill_price: Optional[float] = None


class AccountData(BaseModel):
    account: AccountSummary
    positions: List[Position]
    orders: List[Order]
    last_updated: str


class ConnectionInfo(BaseModel):
    connected: bool
    host: str
    port: int
    client_id: int
    last_connected: Optional[str] = None
    last_error: Optional[str] = None
    connection_count: int


# NOTE: StreamSubscribeRequest / StreamSymbolRequest are kept in main.py
# alongside the streaming route handlers because they apply stricter
# Field() validation than the rest of the schemas here.
