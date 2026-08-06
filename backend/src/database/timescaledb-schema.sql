-- TradingApp TimescaleDB Schema - Raw Data Only
-- Stores only raw market data from IB Gateway
-- All technical indicators calculated by TradingView Lightweight Charts

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "timescaledb";

-- ==============================================
-- CORE TABLES
-- ==============================================

-- Symbols/Contracts table - stores contract information from IB Gateway
CREATE TABLE IF NOT EXISTS contracts (
    id SERIAL PRIMARY KEY,
    broker VARCHAR(16) NOT NULL DEFAULT 'ib', -- venue (B1): 'ib' | 'mt5' | 'alpaca' | 'oanda'
    symbol VARCHAR(20) NOT NULL,
    sec_type VARCHAR(10) NOT NULL, -- STK, OPT, FUT, CASH, etc.
    exchange VARCHAR(20),
    currency VARCHAR(3) DEFAULT 'USD',
    multiplier VARCHAR(10),
    expiry DATE,
    strike DECIMAL(20,8),
    "right" VARCHAR(4), -- CALL, PUT for options
    local_symbol VARCHAR(50),
    contract_id INTEGER, -- IB contract ID
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- Composite unique constraint. Broker-scoped (B1) so the same symbol on two
    -- venues (e.g. MSFT@ib and an FX pair @mt5) never collide in the catalogue.
    CONSTRAINT contracts_broker_key
        UNIQUE (broker, symbol, sec_type, exchange, currency, expiry, strike, "right")
);

-- Create index for efficient contract lookups
CREATE INDEX IF NOT EXISTS idx_contracts_symbol ON contracts(symbol);
CREATE INDEX IF NOT EXISTS idx_contracts_sec_type ON contracts(sec_type);
CREATE INDEX IF NOT EXISTS idx_contracts_exchange ON contracts(exchange);
CREATE INDEX IF NOT EXISTS idx_contracts_contract_id ON contracts(contract_id);
CREATE INDEX IF NOT EXISTS idx_contracts_broker_symbol ON contracts(broker, symbol);

-- Existing deployments: add the broker column and re-key the uniqueness to
-- include it (B1). Idempotent — safe to re-run.
DO $$
DECLARE cname text;
BEGIN
    ALTER TABLE contracts ADD COLUMN IF NOT EXISTS broker VARCHAR(16) NOT NULL DEFAULT 'ib';
    -- Drop the pre-broker unique constraint (its generated name varies) so it
    -- can be replaced by the broker-scoped one.
    SELECT conname INTO cname
      FROM pg_constraint
     WHERE conrelid = 'contracts'::regclass
       AND contype = 'u'
       AND pg_get_constraintdef(oid) LIKE 'UNIQUE (symbol,%';
    IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE contracts DROP CONSTRAINT %I', cname);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'contracts'::regclass AND conname = 'contracts_broker_key'
    ) THEN
        ALTER TABLE contracts ADD CONSTRAINT contracts_broker_key
            UNIQUE (broker, symbol, sec_type, exchange, currency, expiry, strike, "right");
    END IF;
END $$;

-- ==============================================
-- RAW DATA TABLES (HYPERTABLES)
-- ==============================================

-- OHLCV candlestick data - RAW DATA ONLY from IB Gateway
CREATE TABLE IF NOT EXISTS candlestick_data (
    id BIGSERIAL,
    contract_id INTEGER NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    timeframe VARCHAR(10) NOT NULL, -- 1min, 5min, 15min, 30min, 1hour, 4hour, 8hour, 1day
    open DECIMAL(20,8) NOT NULL,
    high DECIMAL(20,8) NOT NULL,
    low DECIMAL(20,8) NOT NULL,
    close DECIMAL(20,8) NOT NULL,
    volume BIGINT NOT NULL DEFAULT 0,
    wap DECIMAL(20,8), -- Volume Weighted Average Price from IB
    count INTEGER, -- Number of trades from IB
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Composite unique constraint to prevent duplicates
    UNIQUE(contract_id, timestamp, timeframe)
);

-- Convert to hypertable with 1-day chunks for optimal performance
SELECT create_hypertable('candlestick_data', 'timestamp', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);

-- Create TimescaleDB-optimized indexes
-- Primary index for most common queries (contract + timeframe + timestamp)
CREATE INDEX IF NOT EXISTS idx_candlestick_contract_timeframe_timestamp ON candlestick_data(contract_id, timeframe, timestamp DESC);
-- Index for time-based queries across all contracts
CREATE INDEX IF NOT EXISTS idx_candlestick_timestamp_desc ON candlestick_data(timestamp DESC);
-- Index for contract-specific queries without timeframe filter
CREATE INDEX IF NOT EXISTS idx_candlestick_contract_timestamp_desc ON candlestick_data(contract_id, timestamp DESC);

-- Real-time tick data (for high-frequency data) - RAW DATA ONLY from IB Gateway
CREATE TABLE IF NOT EXISTS tick_data (
    id BIGSERIAL,
    contract_id INTEGER NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    tick_type VARCHAR(20) NOT NULL, -- bid, ask, last, volume, etc. from IB
    price DECIMAL(20,8),
    size INTEGER,
    exchange VARCHAR(20),
    special_conditions VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Convert to hypertable with 1-hour chunks for high-frequency data
SELECT create_hypertable('tick_data', 'timestamp', chunk_time_interval => INTERVAL '1 hour', if_not_exists => TRUE);

-- Create TimescaleDB-optimized indexes for tick data
CREATE INDEX IF NOT EXISTS idx_tick_contract_timestamp_desc ON tick_data(contract_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_tick_type_timestamp ON tick_data(tick_type, timestamp DESC);

-- Add foreign key constraints after hypertable creation
ALTER TABLE candlestick_data ADD CONSTRAINT fk_candlestick_contract 
    FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE;
ALTER TABLE tick_data ADD CONSTRAINT fk_tick_contract 
    FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE;

-- ==============================================
-- DATA COLLECTION METADATA
-- ==============================================

-- Track data collection sessions from IB Gateway
CREATE TABLE IF NOT EXISTS data_collection_sessions (
    id SERIAL PRIMARY KEY,
    contract_id INTEGER NOT NULL,
    timeframe VARCHAR(10) NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ,
    status VARCHAR(20) DEFAULT 'active', -- active, completed, failed
    records_collected INTEGER DEFAULT 0,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_contract ON data_collection_sessions(contract_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON data_collection_sessions(status);

-- Data quality metrics for raw data validation
CREATE TABLE IF NOT EXISTS data_quality_metrics (
    id SERIAL PRIMARY KEY,
    contract_id INTEGER NOT NULL,
    timeframe VARCHAR(10) NOT NULL,
    date DATE NOT NULL,
    total_bars INTEGER DEFAULT 0,
    missing_bars INTEGER DEFAULT 0,
    duplicate_bars INTEGER DEFAULT 0,
    invalid_bars INTEGER DEFAULT 0,
    data_quality_score DECIMAL(5,4), -- 0.0000 to 1.0000 (higher precision)
    last_updated TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(contract_id, timeframe, date)
);

CREATE INDEX IF NOT EXISTS idx_quality_contract_date ON data_quality_metrics(contract_id, date DESC);

-- Data collection configuration for IB Gateway
CREATE TABLE IF NOT EXISTS data_collection_config (
    id SERIAL PRIMARY KEY,
    contract_id INTEGER NOT NULL,
    timeframe VARCHAR(10) NOT NULL,
    enabled BOOLEAN DEFAULT true,
    auto_collect BOOLEAN DEFAULT false,
    collection_interval_minutes INTEGER DEFAULT 5,
    retention_days INTEGER DEFAULT 365, -- How long to keep raw data
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(contract_id, timeframe)
);

-- ==============================================
-- CONTINUOUS AGGREGATES (TIMESCALEDB FEATURE)
-- ==============================================

-- Daily aggregated raw data for faster queries
CREATE MATERIALIZED VIEW IF NOT EXISTS daily_candlestick_data
WITH (timescaledb.continuous) AS
SELECT 
    contract_id,
    timeframe,
    time_bucket('1 day', timestamp) AS day,
    FIRST(open, timestamp) AS day_open,
    MAX(high) AS day_high,
    MIN(low) AS day_low,
    LAST(close, timestamp) AS day_close,
    SUM(volume) AS day_volume,
    AVG(wap) AS day_avg_wap,
    SUM(count) AS day_trade_count
FROM candlestick_data
GROUP BY contract_id, timeframe, day;

-- Add refresh policy for continuous aggregates (only if not exists)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.continuous_aggregates 
        WHERE view_name = 'daily_candlestick_data'
    ) THEN
        PERFORM add_continuous_aggregate_policy('daily_candlestick_data',
            start_offset => INTERVAL '3 days',
            end_offset => INTERVAL '1 hour',
            schedule_interval => INTERVAL '1 hour');
    END IF;
END $$;

-- ==============================================
-- DATA RETENTION POLICIES (TIMESCALEDB FEATURE)
-- ==============================================

-- Set up automated data retention policies for raw data (only if not exists)
DO $$
BEGIN
    -- Add retention policy for candlestick_data if not exists
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.jobs 
        WHERE proc_name = 'policy_retention' 
        AND hypertable_name = 'candlestick_data'
    ) THEN
        PERFORM add_retention_policy('candlestick_data', INTERVAL '2 years');
    END IF;
    
    -- Add retention policy for tick_data if not exists
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.jobs 
        WHERE proc_name = 'policy_retention' 
        AND hypertable_name = 'tick_data'
    ) THEN
        PERFORM add_retention_policy('tick_data', INTERVAL '30 days');
    END IF;
END $$;

-- ==============================================
-- VIEWS FOR RAW DATA ACCESS
-- ==============================================

-- View for latest raw candlestick data (NO INDICATORS)
-- Note: This view should be used with LIMIT in queries to avoid large result sets
CREATE OR REPLACE VIEW latest_candlestick_data AS
SELECT 
    c.symbol,
    c.sec_type,
    c.exchange,
    c.currency,
    cd.timestamp,
    cd.timeframe,
    cd.open,
    cd.high,
    cd.low,
    cd.close,
    cd.volume,
    cd.wap,
    cd.count
FROM candlestick_data cd
JOIN contracts c ON cd.contract_id = c.id
ORDER BY cd.timestamp DESC;

-- View for daily aggregated raw data with contract info
CREATE OR REPLACE VIEW daily_trading_summary AS
SELECT 
    c.symbol,
    c.sec_type,
    c.exchange,
    c.currency,
    dcd.day,
    dcd.timeframe,
    dcd.day_open,
    dcd.day_high,
    dcd.day_low,
    dcd.day_close,
    dcd.day_volume,
    dcd.day_avg_wap,
    dcd.day_trade_count,
    -- Simple daily change calculation (raw data only)
    dcd.day_close - dcd.day_open AS daily_change,
    CASE 
        WHEN dcd.day_open > 0 THEN ROUND(((dcd.day_close - dcd.day_open) / dcd.day_open * 100), 2)
        ELSE NULL 
    END AS daily_change_percent
FROM daily_candlestick_data dcd
JOIN contracts c ON dcd.contract_id = c.id
ORDER BY dcd.day DESC, c.symbol;

-- ==============================================
-- FUNCTIONS AND TRIGGERS
-- ==============================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers
CREATE TRIGGER update_contracts_updated_at 
    BEFORE UPDATE ON contracts 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_sessions_updated_at 
    BEFORE UPDATE ON data_collection_sessions 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_config_updated_at
    BEFORE UPDATE ON data_collection_config
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_order_audit_updated_at ON order_audit;
CREATE TRIGGER update_order_audit_updated_at
    BEFORE UPDATE ON order_audit
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ==============================================
-- BACKTEST RUNS (GAP_ANALYSIS §5 — persistence)
-- ==============================================
-- One row per backtest invocation. The full input set is kept (so a run
-- can be reproduced) alongside the engine output (metrics + equity curve
-- + trade list) as JSONB so additions in `broker_service/backtesting.py` do
-- not require a schema migration. A `params_hash` lets the UI suppress
-- duplicate re-runs of the same configuration cheaply.

CREATE TABLE IF NOT EXISTS backtest_runs (
    id BIGSERIAL PRIMARY KEY,
    strategy VARCHAR(64) NOT NULL,
    symbol VARCHAR(32) NOT NULL,
    timeframe VARCHAR(16) NOT NULL,
    period VARCHAR(16),                  -- '1Y', '3M', 'CUSTOM', etc.
    start_date DATE,                     -- populated only for CUSTOM range
    end_date DATE,
    initial_capital NUMERIC(20,4) NOT NULL,
    commission NUMERIC(10,6) NOT NULL,
    params JSONB NOT NULL DEFAULT '{}'::jsonb,
    params_hash CHAR(64) NOT NULL,       -- sha256 hex of canonical input
    metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    equity_curve JSONB NOT NULL DEFAULT '[]'::jsonb,
    trades JSONB NOT NULL DEFAULT '[]'::jsonb,
    trade_count INTEGER NOT NULL DEFAULT 0,
    final_equity NUMERIC(20,4),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backtest_runs_created_desc
    ON backtest_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_strategy_symbol
    ON backtest_runs (strategy, symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_params_hash
    ON backtest_runs (params_hash);

-- ==============================================
-- ORDER AUDIT (Tier 4 item 9 — live trading)
-- ==============================================
-- Every order submission attempt — paper or live — gets one row here. The
-- table is an audit log, not a copy of IB's order book: status transitions
-- are recorded as they propagate back through the IB service, but the
-- authoritative state still lives at IB. Used by the blotter on the /trade
-- page and by compliance / diagnostics.
--
-- Indexed by created_at DESC (most-recent-first listing) and by
-- (account_mode, status) so it's cheap to surface "any LIVE orders still
-- working" on the home page.

CREATE TABLE IF NOT EXISTS order_audit (
    id BIGSERIAL PRIMARY KEY,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    account_mode VARCHAR(8) NOT NULL,           -- 'paper' | 'live'
    broker VARCHAR(16) NOT NULL DEFAULT 'ib',   -- execution venue: 'ib' | 'mt5' | 'alpaca' | 'oanda' (B1)
    action VARCHAR(8) NOT NULL,                 -- 'BUY' | 'SELL'
    symbol VARCHAR(32) NOT NULL,
    sec_type VARCHAR(8) NOT NULL DEFAULT 'STK',
    exchange VARCHAR(16) NOT NULL DEFAULT 'SMART',
    currency VARCHAR(8) NOT NULL DEFAULT 'USD',
    quantity NUMERIC(20,4) NOT NULL,
    order_type VARCHAR(8) NOT NULL,             -- 'MKT' | 'LMT' | 'STP' | 'STP_LMT'
    tif VARCHAR(8) NOT NULL DEFAULT 'DAY',      -- 'DAY' | 'GTC' | 'IOC' | 'FOK'
    limit_price NUMERIC(20,4),                  -- required for LMT / STP_LMT
    stop_price NUMERIC(20,4),                   -- required for STP / STP_LMT
    operation VARCHAR(8) NOT NULL DEFAULT 'CREATE', -- 'CREATE' | 'CANCEL' | 'MODIFY'
    ib_order_id INTEGER,                        -- IB's order id once we have it
    request_id VARCHAR(128),                    -- X-Request-Id from the call
    status VARCHAR(24) NOT NULL DEFAULT 'submitted',
    last_error TEXT,
    raw_response JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_audit_created_desc
    ON order_audit (submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_audit_mode_status
    ON order_audit (account_mode, status);
CREATE INDEX IF NOT EXISTS idx_order_audit_ib_order_id
    ON order_audit (ib_order_id) WHERE ib_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_order_audit_symbol_created
    ON order_audit (symbol, submitted_at DESC);
-- Backs the net-exposure guard, now keyed per (broker, symbol, account_mode)
-- so exposure never nets across venues (B1).
CREATE INDEX IF NOT EXISTS idx_order_audit_net_key
    ON order_audit (broker, symbol, account_mode, submitted_at DESC)
    WHERE ib_order_id IS NOT NULL;

-- Existing deployments: add the broker column if it predates B1.
ALTER TABLE order_audit ADD COLUMN IF NOT EXISTS broker VARCHAR(16) NOT NULL DEFAULT 'ib';

-- ==============================================
-- SYSTEMATIC STRATEGIES (Systematic Trading roadmap — Phase 2 / A2 + Phase 3 / A3)
-- ==============================================
-- A strategy is one declarative rule-set (see broker_service/rule_strategy.py)
-- shared by the backtester and the live signal runner. `strategy_definitions`
-- stores the rule-set; a `strategy_runs` row pins a definition to a
-- broker/account_mode and a status; every evaluation the runner makes is
-- recorded in `strategy_signals`.
--
-- Phase 3 (A3) adds gated, audited paper auto-execution: an actionable signal
-- is submitted through the shared /api/orders path, and its `acted` /
-- `order_audit_id` columns are set to link the signal to the resulting
-- `order_audit` row (also the durable one-order-per-bar dedupe). The engine is
-- off unless SYSTEMATIC_EXECUTION_ENABLED=true, so with only SYSTEMATIC_ENABLED
-- these stay unset (signal-only).

CREATE TABLE IF NOT EXISTS strategy_definitions (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    broker VARCHAR(16) NOT NULL DEFAULT 'ib',
    symbol VARCHAR(32) NOT NULL,
    timeframe VARCHAR(16) NOT NULL,
    rule_set JSONB NOT NULL,                 -- the declarative rule-set
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_strategy_definitions_created_desc
    ON strategy_definitions (created_at DESC);

CREATE TABLE IF NOT EXISTS strategy_runs (
    id BIGSERIAL PRIMARY KEY,
    definition_id BIGINT NOT NULL REFERENCES strategy_definitions(id) ON DELETE CASCADE,
    broker VARCHAR(16) NOT NULL DEFAULT 'ib',
    account_mode VARCHAR(8) NOT NULL DEFAULT 'paper',   -- 'paper' | 'live'
    status VARCHAR(16) NOT NULL DEFAULT 'running',       -- 'running' | 'stopped' | 'error'
    sizing JSONB NOT NULL DEFAULT '{}'::jsonb,           -- carried through for A3
    risk JSONB NOT NULL DEFAULT '{}'::jsonb,             -- carried through for A3
    last_evaluated_at TIMESTAMPTZ,
    last_error TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    stopped_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_strategy_runs_status
    ON strategy_runs (status);
CREATE INDEX IF NOT EXISTS idx_strategy_runs_definition
    ON strategy_runs (definition_id, started_at DESC);

CREATE TABLE IF NOT EXISTS strategy_signals (
    id BIGSERIAL PRIMARY KEY,
    run_id BIGINT NOT NULL REFERENCES strategy_runs(id) ON DELETE CASCADE,
    bar_time TIMESTAMPTZ NOT NULL,          -- the closed bar the decision was made on
    signal VARCHAR(8) NOT NULL,             -- 'buy' | 'sell' | 'none'
    reason TEXT,
    entry BOOLEAN NOT NULL DEFAULT FALSE,
    exit BOOLEAN NOT NULL DEFAULT FALSE,
    in_session BOOLEAN NOT NULL DEFAULT TRUE,
    position_size NUMERIC(20,4) NOT NULL DEFAULT 0,
    acted BOOLEAN NOT NULL DEFAULT FALSE,   -- set by the A3 execution layer
    order_audit_id BIGINT REFERENCES order_audit(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (run_id, bar_time)               -- one decision per closed bar (dedupe)
);

CREATE INDEX IF NOT EXISTS idx_strategy_signals_run
    ON strategy_signals (run_id, bar_time DESC);
-- Backs the A3 per-run / global "orders placed today" caps: only acted
-- signals count, so index just those by run + time.
CREATE INDEX IF NOT EXISTS idx_strategy_signals_acted
    ON strategy_signals (run_id, created_at DESC) WHERE acted;

-- ==============================================
-- WATCHLIST
-- ==============================================
-- A single flat watchlist (no per-user scoping — the app has one operator
-- today, mirroring the rest of the schema). Each row is a symbol the
-- operator wants quick access to; live price is fetched on demand from
-- `/api/market-data/realtime`, not stored here. `sort_order` lets the UI
-- persist a manual ordering; ties break on `id` (insertion order).

CREATE TABLE IF NOT EXISTS watchlist_items (
    id BIGSERIAL PRIMARY KEY,
    broker VARCHAR(16) NOT NULL DEFAULT 'ib',   -- execution venue: 'ib' | 'mt5' | 'alpaca' | 'oanda' (B1)
    symbol VARCHAR(32) NOT NULL,
    sec_type VARCHAR(8) NOT NULL DEFAULT 'STK',
    exchange VARCHAR(16) NOT NULL DEFAULT 'SMART',
    currency VARCHAR(8) NOT NULL DEFAULT 'USD',
    notes VARCHAR(256),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT watchlist_items_unique
        UNIQUE (broker, symbol, sec_type, exchange, currency)
);

CREATE INDEX IF NOT EXISTS idx_watchlist_items_sort
    ON watchlist_items (sort_order, id);

-- ==============================================
-- INITIAL DATA
-- ==============================================

-- Insert some common contracts for testing
INSERT INTO contracts (symbol, sec_type, exchange, currency) VALUES
    ('MSFT', 'STK', 'NASDAQ', 'USD'),
    ('AAPL', 'STK', 'NASDAQ', 'USD'),
    ('GOOGL', 'STK', 'NASDAQ', 'USD'),
    ('SPY', 'STK', 'ARCA', 'USD'),
    ('QQQ', 'STK', 'NASDAQ', 'USD')
ON CONFLICT (symbol, sec_type, exchange, currency, expiry, strike, "right") DO NOTHING;

-- ==============================================
-- VERIFICATION QUERIES
-- ==============================================

-- Verify TimescaleDB extension is enabled
SELECT * FROM pg_extension WHERE extname = 'timescaledb';

-- Verify hypertables were created
SELECT * FROM timescaledb_information.hypertables;

-- Verify tables were created
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN ('contracts', 'candlestick_data', 'tick_data')
ORDER BY table_name;

-- ==============================================
-- COMPLETION MESSAGE
-- ==============================================

DO $$
BEGIN
    RAISE NOTICE 'TradingApp TimescaleDB Schema Ready!';
    RAISE NOTICE 'Features: Hypertables, Continuous Aggregates, Retention Policies';
    RAISE NOTICE 'Raw data only - Technical indicators handled by TradingView Charts';
END $$;

