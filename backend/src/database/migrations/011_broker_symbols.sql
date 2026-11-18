-- The symbols each broker connection can trade, grouped by market.
--
-- A data or order request for a symbol the broker does not list, or with the
-- wrong security type for it, fails at the venue. This is the broker's own
-- list, so the symbol pickers can offer only what a connection has, with the
-- security type and currency it needs filled in.
--
-- `account` is the account named on the request, '' for the platform's
-- default account. A listable broker (OANDA, cTrader, MT5, Alpaca) has its
-- whole list here, replaced on each refresh; a search-only broker (IB, IG)
-- has what searches on it have found, added to as they find more.
CREATE TABLE IF NOT EXISTS broker_symbols (
    platform VARCHAR(16) NOT NULL,
    account VARCHAR(64) NOT NULL DEFAULT '',
    symbol VARCHAR(64) NOT NULL,
    sec_type VARCHAR(10) NOT NULL,
    name VARCHAR(256) NOT NULL DEFAULT '',
    -- FX, INDEX, COMMODITY, METAL, BOND, STOCK, ETF, CRYPTO, FUTURE, OPTION, OTHER
    market VARCHAR(16) NOT NULL,
    currency VARCHAR(16) NOT NULL DEFAULT '',
    exchange VARCHAR(32) NOT NULL DEFAULT '',
    -- The broker's own id: OANDA's `AU200_AUD`, a cTrader symbol id, an IB conid.
    venue_id VARCHAR(64) NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (platform, account, symbol, sec_type)
);

CREATE INDEX IF NOT EXISTS idx_broker_symbols_market
    ON broker_symbols (platform, account, market);

-- When each connection's list was last fetched, and whether it is the whole
-- list (a listable broker) or only what searches found (a search-only one).
CREATE TABLE IF NOT EXISTS broker_symbol_lists (
    platform VARCHAR(16) NOT NULL,
    account VARCHAR(64) NOT NULL DEFAULT '',
    complete BOOLEAN NOT NULL,
    symbol_count INTEGER NOT NULL DEFAULT 0,
    refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (platform, account)
);
