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
    # A string, not an int: IB's order ids are numeric but Alpaca's are UUIDs
    # and OANDA's are numeric *strings*, so the venue-agnostic contract has to
    # be the wider type. IB ids still round-trip as their decimal text.
    order_id: str
    symbol: str
    action: str  # BUY/SELL
    quantity: float
    order_type: str
    status: str
    filled_quantity: Optional[float] = None
    remaining_quantity: Optional[float] = None
    avg_fill_price: Optional[float] = None


class Execution(BaseModel):
    """One **fill** (execution report) from a venue.

    This is the authoritative record of what actually traded, as opposed to
    `order_audit`'s record of what the app *asked* to trade. Partial fills,
    post-acknowledgement rejections and manual trades placed outside the app
    all show up here and nowhere else, which is why positions and realised P&L
    are derived from this feed rather than from submitted orders.

    Every venue normalises into this shape (same contract as `Position`):

    - ``exec_id`` is the venue's own unique id for the fill and is what makes
      polling idempotent — re-fetching an overlapping window re-delivers the
      same ids and the backend upserts them away.
    - ``quantity`` is always **positive**; direction lives in ``side``.
    - ``commission`` / ``realized_pnl`` are optional because not every venue
      reports them per fill (IB sends them in a separate `commissionReport`
      callback; Alpaca is commission-free).
    """

    exec_id: str
    order_id: Optional[str] = None
    symbol: str
    side: str  # BUY/SELL
    quantity: float
    price: float
    commission: Optional[float] = None
    realized_pnl: Optional[float] = None
    executed_at: str  # ISO-8601, UTC
    account: Optional[str] = None
    currency: str = "USD"
    broker: str = "ib"


class InstrumentSpec(BaseModel):
    """What one unit of quantity *means* at a venue, and how it may be sized.

    Sizing is only abstract until it has to become a number. "Buy 100" means
    100 shares on IB or Alpaca, but 100 **lots** on MT5 — which, at a standard
    contract size, is ten million units of the base currency. That is why
    `lots` and `units` sizing was refused outright rather than approximated:
    pricing a lot as if it were a share is not a rounding error.

    This is the venue's own answer, so the sizer can convert instead of guess:

    - ``unit`` — what a quantity of 1 is called here (`shares` / `lots` / `units`).
    - ``contract_size`` — how many units of the underlying one quantity unit
      controls. 1 for shares and for OANDA units (an OANDA "unit" *is* one unit
      of the base currency); typically 100000 for a standard FX lot on MT5.
      Notional and percent-of-equity sizing divide by ``price * contract_size``.
    - ``min_size`` / ``size_step`` — the venue's smallest tradable size and its
      increment. A resolved size is floored onto the step and refused below the
      minimum, rather than being rounded up into an order larger than intended.
    """

    symbol: str
    broker: str
    unit: str = "shares"
    min_size: float = 1.0
    size_step: float = 1.0
    max_size: Optional[float] = None
    contract_size: float = 1.0
    currency: str = "USD"


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
