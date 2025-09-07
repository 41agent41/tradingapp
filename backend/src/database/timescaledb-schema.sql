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
    
    -- Composite unique constraint
    UNIQUE(symbol, sec_type, exchange, currency, expiry, strike, "right")
);

-- Create index for efficient contract lookups
CREATE INDEX IF NOT EXISTS idx_contracts_symbol ON contracts(symbol);
CREATE INDEX IF NOT EXISTS idx_contracts_sec_type ON contracts(sec_type);
CREATE INDEX IF NOT EXISTS idx_contracts_exchange ON contracts(exchange);
CREATE INDEX IF NOT EXISTS idx_contracts_contract_id ON contracts(contract_id);

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
        SELECT add_continuous_aggregate_policy('daily_candlestick_data',
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
        SELECT add_retention_policy('candlestick_data', INTERVAL '2 years');
    END IF;
    
    -- Add retention policy for tick_data if not exists
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.jobs 
        WHERE proc_name = 'policy_retention' 
        AND hypertable_name = 'tick_data'
    ) THEN
        SELECT add_retention_policy('tick_data', INTERVAL '30 days');
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

