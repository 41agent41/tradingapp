-- TradingApp TimescaleDB Schema
-- Optimized for streaming historical market data
-- Run this script against your TimescaleDB-enabled PostgreSQL instance

-- ==============================================
-- EXTENSIONS
-- ==============================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "timescaledb";

-- ==============================================
-- CORE TABLES
-- ==============================================

-- Symbols/Contracts table - stores contract information
CREATE TABLE IF NOT EXISTS contracts (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) NOT NULL,
    sec_type VARCHAR(10) NOT NULL, -- STK, OPT, FUT, CASH, etc.
    exchange VARCHAR(20),
    currency VARCHAR(3) DEFAULT 'USD',
    multiplier VARCHAR(10),
    expiry DATE,
    strike DECIMAL(10,2),
    right VARCHAR(4), -- CALL, PUT for options
    local_symbol VARCHAR(50),
    contract_id INTEGER, -- IB contract ID
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Composite unique constraint
    UNIQUE(symbol, sec_type, exchange, currency, expiry, strike, right)
);

-- Create index for efficient contract lookups
CREATE INDEX IF NOT EXISTS idx_contracts_symbol ON contracts(symbol);
CREATE INDEX IF NOT EXISTS idx_contracts_sec_type ON contracts(sec_type);
CREATE INDEX IF NOT EXISTS idx_contracts_exchange ON contracts(exchange);
CREATE INDEX IF NOT EXISTS idx_contracts_contract_id ON contracts(contract_id);

-- ==============================================
-- TIMESERIES TABLES (HYPERTABLES)
-- ==============================================

-- OHLCV candlestick data - PRIMARY TIMESERIES TABLE
CREATE TABLE IF NOT EXISTS candlestick_data (
    id BIGSERIAL,
    contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    timestamp TIMESTAMPTZ NOT NULL, -- Changed to TIMESTAMPTZ for timezone support
    timeframe VARCHAR(10) NOT NULL, -- 1min, 5min, 15min, 30min, 1hour, 4hour, 8hour, 1day
    open DECIMAL(15,6) NOT NULL,
    high DECIMAL(15,6) NOT NULL,
    low DECIMAL(15,6) NOT NULL,
    close DECIMAL(15,6) NOT NULL,
    volume BIGINT NOT NULL DEFAULT 0,
    wap DECIMAL(15,6), -- Volume Weighted Average Price
    count INTEGER, -- Number of trades
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Composite unique constraint to prevent duplicates
    UNIQUE(contract_id, timestamp, timeframe)
);

-- Convert to hypertable with 1-day chunks for optimal performance
SELECT create_hypertable('candlestick_data', 'timestamp', chunk_time_interval => INTERVAL '1 day');

-- Create TimescaleDB-optimized indexes
CREATE INDEX IF NOT EXISTS idx_candlestick_contract_timeframe_timestamp ON candlestick_data(contract_id, timeframe, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_candlestick_timestamp_desc ON candlestick_data(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_candlestick_contract_timestamp_desc ON candlestick_data(contract_id, timestamp DESC);

-- Real-time tick data (for high-frequency data) - SECONDARY TIMESERIES TABLE
CREATE TABLE IF NOT EXISTS tick_data (
    id BIGSERIAL,
    contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    timestamp TIMESTAMPTZ NOT NULL,
    tick_type VARCHAR(20) NOT NULL, -- bid, ask, last, volume, etc.
    price DECIMAL(15,6),
    size INTEGER,
    exchange VARCHAR(20),
    special_conditions VARCHAR(50),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Convert to hypertable with 1-hour chunks for high-frequency data
SELECT create_hypertable('tick_data', 'timestamp', chunk_time_interval => INTERVAL '1 hour');

-- Create TimescaleDB-optimized indexes for tick data
CREATE INDEX IF NOT EXISTS idx_tick_contract_timestamp_desc ON tick_data(contract_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_tick_type_timestamp ON tick_data(tick_type, timestamp DESC);

-- Technical indicators - TIMESERIES TABLE
CREATE TABLE IF NOT EXISTS technical_indicators (
    id BIGSERIAL,
    candlestick_id BIGINT NOT NULL REFERENCES candlestick_data(id) ON DELETE CASCADE,
    contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    timestamp TIMESTAMPTZ NOT NULL,
    timeframe VARCHAR(10) NOT NULL,
    indicator_name VARCHAR(20) NOT NULL, -- SMA, EMA, RSI, MACD, etc.
    period INTEGER, -- Period for the indicator (e.g., 20 for SMA20)
    value DECIMAL(15,6),
    additional_data JSONB, -- For indicators with multiple values (e.g., MACD signal, histogram)
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(contract_id, timestamp, timeframe, indicator_name, period)
);

-- Convert to hypertable with 1-day chunks
SELECT create_hypertable('technical_indicators', 'timestamp', chunk_time_interval => INTERVAL '1 day');

-- Create TimescaleDB-optimized indexes for indicators
CREATE INDEX IF NOT EXISTS idx_indicators_contract_timeframe_timestamp ON technical_indicators(contract_id, timeframe, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_indicators_name_timestamp ON technical_indicators(indicator_name, timestamp DESC);

-- ==============================================
-- METADATA TABLES (NON-TIMESERIES)
-- ==============================================

-- Track data collection sessions
CREATE TABLE IF NOT EXISTS data_collection_sessions (
    id SERIAL PRIMARY KEY,
    contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS idx_sessions_start_time ON data_collection_sessions(start_time DESC);

-- Data quality metrics
CREATE TABLE IF NOT EXISTS data_quality_metrics (
    id SERIAL PRIMARY KEY,
    contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    timeframe VARCHAR(10) NOT NULL,
    date DATE NOT NULL,
    total_bars INTEGER DEFAULT 0,
    missing_bars INTEGER DEFAULT 0,
    duplicate_bars INTEGER DEFAULT 0,
    invalid_bars INTEGER DEFAULT 0,
    data_quality_score DECIMAL(3,2), -- 0.00 to 1.00
    last_updated TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(contract_id, timeframe, date)
);

CREATE INDEX IF NOT EXISTS idx_quality_contract_date ON data_quality_metrics(contract_id, date DESC);

-- Data collection configuration
CREATE TABLE IF NOT EXISTS data_collection_config (
    id SERIAL PRIMARY KEY,
    contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    timeframe VARCHAR(10) NOT NULL,
    enabled BOOLEAN DEFAULT true,
    auto_collect BOOLEAN DEFAULT false,
    collection_interval_minutes INTEGER DEFAULT 5,
    retention_days INTEGER DEFAULT 365, -- How long to keep data
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(contract_id, timeframe)
);

-- ==============================================
-- CONTINUOUS AGGREGATES
-- ==============================================

-- Daily aggregated data for faster queries
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

-- Add refresh policy for continuous aggregates (refresh every hour)
SELECT add_continuous_aggregate_policy('daily_candlestick_data',
    start_offset => INTERVAL '3 days',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');

-- Hourly aggregated data for intraday analysis
CREATE MATERIALIZED VIEW IF NOT EXISTS hourly_candlestick_data
WITH (timescaledb.continuous) AS
SELECT 
    contract_id,
    timeframe,
    time_bucket('1 hour', timestamp) AS hour,
    FIRST(open, timestamp) AS hour_open,
    MAX(high) AS hour_high,
    MIN(low) AS hour_low,
    LAST(close, timestamp) AS hour_close,
    SUM(volume) AS hour_volume,
    AVG(wap) AS hour_avg_wap,
    SUM(count) AS hour_trade_count
FROM candlestick_data
WHERE timeframe IN ('1min', '5min', '15min', '30min') -- Only for intraday timeframes
GROUP BY contract_id, timeframe, hour;

-- Add refresh policy for hourly aggregates
SELECT add_continuous_aggregate_policy('hourly_candlestick_data',
    start_offset => INTERVAL '1 day',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');

-- ==============================================
-- DATA RETENTION POLICIES
-- ==============================================

-- Set up automated data retention policies
-- Keep candlestick data for 2 years
SELECT add_retention_policy('candlestick_data', INTERVAL '2 years');

-- Keep tick data for 30 days (high frequency, large volume)
SELECT add_retention_policy('tick_data', INTERVAL '30 days');

-- Keep technical indicators for 2 years (same as candlestick data)
SELECT add_retention_policy('technical_indicators', INTERVAL '2 years');

-- ==============================================
-- VIEWS FOR EASY DATA ACCESS
-- ==============================================

-- Enhanced view for latest candlestick data with indicators
CREATE OR REPLACE VIEW latest_candlestick_data AS
SELECT 
    c.symbol,
    c.sec_type,
    c.exchange,
    cd.timestamp,
    cd.timeframe,
    cd.open,
    cd.high,
    cd.low,
    cd.close,
    cd.volume,
    cd.wap,
    cd.count,
    -- Technical indicators
    MAX(CASE WHEN ti.indicator_name = 'SMA' AND ti.period = 20 THEN ti.value END) as sma_20,
    MAX(CASE WHEN ti.indicator_name = 'SMA' AND ti.period = 50 THEN ti.value END) as sma_50,
    MAX(CASE WHEN ti.indicator_name = 'EMA' AND ti.period = 12 THEN ti.value END) as ema_12,
    MAX(CASE WHEN ti.indicator_name = 'EMA' AND ti.period = 26 THEN ti.value END) as ema_26,
    MAX(CASE WHEN ti.indicator_name = 'RSI' AND ti.period = 14 THEN ti.value END) as rsi_14,
    MAX(CASE WHEN ti.indicator_name = 'MACD' AND ti.period = 12 THEN ti.value END) as macd,
    MAX(CASE WHEN ti.indicator_name = 'MACD_SIGNAL' AND ti.period = 26 THEN ti.value END) as macd_signal,
    MAX(CASE WHEN ti.indicator_name = 'BB_UPPER' AND ti.period = 20 THEN ti.value END) as bb_upper,
    MAX(CASE WHEN ti.indicator_name = 'BB_MIDDLE' AND ti.period = 20 THEN ti.value END) as bb_middle,
    MAX(CASE WHEN ti.indicator_name = 'BB_LOWER' AND ti.period = 20 THEN ti.value END) as bb_lower
FROM candlestick_data cd
JOIN contracts c ON cd.contract_id = c.id
LEFT JOIN technical_indicators ti ON cd.id = ti.candlestick_id
GROUP BY c.symbol, c.sec_type, c.exchange, cd.timestamp, cd.timeframe, cd.open, cd.high, cd.low, cd.close, cd.volume, cd.wap, cd.count
ORDER BY cd.timestamp DESC;

-- View for daily aggregated data with contract info
CREATE OR REPLACE VIEW daily_trading_summary AS
SELECT 
    c.symbol,
    c.sec_type,
    c.exchange,
    dcd.day,
    dcd.timeframe,
    dcd.day_open,
    dcd.day_high,
    dcd.day_low,
    dcd.day_close,
    dcd.day_volume,
    dcd.day_avg_wap,
    dcd.day_trade_count,
    -- Calculate daily change
    dcd.day_close - dcd.day_open AS daily_change,
    ROUND(((dcd.day_close - dcd.day_open) / dcd.day_open * 100), 2) AS daily_change_percent
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

-- Trigger for contracts table
CREATE TRIGGER update_contracts_updated_at 
    BEFORE UPDATE ON contracts 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Trigger for data_collection_sessions table
CREATE TRIGGER update_sessions_updated_at 
    BEFORE UPDATE ON data_collection_sessions 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Trigger for data_collection_config table
CREATE TRIGGER update_config_updated_at 
    BEFORE UPDATE ON data_collection_config 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Enhanced function for data quality monitoring
CREATE OR REPLACE FUNCTION update_data_quality_metrics()
RETURNS TRIGGER AS $$
DECLARE
    total_bars INTEGER;
    missing_bars INTEGER;
    duplicate_bars INTEGER;
    invalid_bars INTEGER;
    quality_score DECIMAL(3,2);
BEGIN
    -- Calculate metrics for the day
    SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE open IS NULL OR high IS NULL OR low IS NULL OR close IS NULL) as missing,
        COUNT(*) - COUNT(DISTINCT timestamp) as duplicates,
        COUNT(*) FILTER (WHERE open <= 0 OR high <= 0 OR low <= 0 OR close <= 0 OR high < low) as invalid
    INTO total_bars, missing_bars, duplicate_bars, invalid_bars
    FROM candlestick_data 
    WHERE contract_id = NEW.contract_id 
    AND timeframe = NEW.timeframe
    AND DATE(timestamp) = DATE(NEW.timestamp);
    
    -- Calculate quality score (0.0 to 1.0)
    quality_score := CASE 
        WHEN total_bars = 0 THEN 0.0
        ELSE (total_bars - missing_bars - duplicate_bars - invalid_bars)::DECIMAL / total_bars
    END;
    
    -- Insert or update quality metrics
    INSERT INTO data_quality_metrics (contract_id, timeframe, date, total_bars, missing_bars, duplicate_bars, invalid_bars, data_quality_score)
    VALUES (NEW.contract_id, NEW.timeframe, DATE(NEW.timestamp), total_bars, missing_bars, duplicate_bars, invalid_bars, quality_score)
    ON CONFLICT (contract_id, timeframe, date) 
    DO UPDATE SET 
        total_bars = EXCLUDED.total_bars,
        missing_bars = EXCLUDED.missing_bars,
        duplicate_bars = EXCLUDED.duplicate_bars,
        invalid_bars = EXCLUDED.invalid_bars,
        data_quality_score = EXCLUDED.data_quality_score,
        last_updated = NOW();
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update data quality metrics
CREATE TRIGGER update_quality_metrics_trigger
    AFTER INSERT OR UPDATE ON candlestick_data
    FOR EACH ROW EXECUTE FUNCTION update_data_quality_metrics();

-- ==============================================
-- INITIAL DATA
-- ==============================================

-- Insert some common contracts for testing
INSERT INTO contracts (symbol, sec_type, exchange, currency) VALUES
    ('MSFT', 'STK', 'NASDAQ', 'USD'),
    ('AAPL', 'STK', 'NASDAQ', 'USD'),
    ('GOOGL', 'STK', 'NASDAQ', 'USD'),
    ('SPY', 'STK', 'ARCA', 'USD'),
    ('QQQ', 'STK', 'NASDAQ', 'USD'),
    ('TSLA', 'STK', 'NASDAQ', 'USD'),
    ('NVDA', 'STK', 'NASDAQ', 'USD'),
    ('AMZN', 'STK', 'NASDAQ', 'USD'),
    ('META', 'STK', 'NASDAQ', 'USD'),
    ('NFLX', 'STK', 'NASDAQ', 'USD')
ON CONFLICT (symbol, sec_type, exchange, currency, expiry, strike, right) DO NOTHING;

-- ==============================================
-- COMMENTS
-- ==============================================

COMMENT ON TABLE contracts IS 'Stores contract information from Interactive Brokers';
COMMENT ON TABLE candlestick_data IS 'OHLCV candlestick data for all timeframes - TimescaleDB hypertable';
COMMENT ON TABLE tick_data IS 'Real-time tick data for high-frequency analysis - TimescaleDB hypertable';
COMMENT ON TABLE technical_indicators IS 'Calculated technical indicators - TimescaleDB hypertable';
COMMENT ON TABLE data_collection_sessions IS 'Tracks data collection sessions';
COMMENT ON TABLE data_quality_metrics IS 'Data quality metrics and monitoring';
COMMENT ON TABLE data_collection_config IS 'Configuration for data collection';
COMMENT ON MATERIALIZED VIEW daily_candlestick_data IS 'Daily aggregated candlestick data - TimescaleDB continuous aggregate';
COMMENT ON MATERIALIZED VIEW hourly_candlestick_data IS 'Hourly aggregated candlestick data - TimescaleDB continuous aggregate';

-- ==============================================
-- VERIFICATION QUERIES
-- ==============================================

-- Verify TimescaleDB extension is enabled
SELECT * FROM pg_extension WHERE extname = 'timescaledb';

-- Verify hypertables were created
SELECT * FROM timescaledb_information.hypertables;

-- Verify continuous aggregates were created
SELECT * FROM timescaledb_information.continuous_aggregates;

-- Verify retention policies were created
SELECT * FROM timescaledb_information.policies;

-- Verify tables were created
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN ('contracts', 'candlestick_data', 'tick_data', 'technical_indicators', 'data_collection_sessions', 'data_quality_metrics', 'data_collection_config')
ORDER BY table_name;

-- Verify initial data was inserted
SELECT symbol, sec_type, exchange, currency FROM contracts ORDER BY symbol;

-- ==============================================
-- COMPLETION MESSAGE
-- ==============================================

DO $$
BEGIN
    RAISE NOTICE 'TradingApp TimescaleDB schema initialization completed successfully!';
    RAISE NOTICE 'TimescaleDB extension enabled';
    RAISE NOTICE 'Hypertables created: candlestick_data, tick_data, technical_indicators';
    RAISE NOTICE 'Continuous aggregates created: daily_candlestick_data, hourly_candlestick_data';
    RAISE NOTICE 'Retention policies configured for automated data cleanup';
    RAISE NOTICE 'Tables created: contracts, data_collection_sessions, data_quality_metrics, data_collection_config';
    RAISE NOTICE 'Views created: latest_candlestick_data, daily_trading_summary';
    RAISE NOTICE 'Functions created: update_updated_at_column, update_data_quality_metrics';
    RAISE NOTICE 'Triggers created: update_contracts_updated_at, update_sessions_updated_at, update_config_updated_at, update_quality_metrics_trigger';
    RAISE NOTICE 'Initial data: 10 common stock contracts inserted';
    RAISE NOTICE 'Ready for high-performance time-series data streaming!';
END $$;
