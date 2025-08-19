-- TradingApp Database Schema
-- Historical Market Data Storage

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    -- Composite unique constraint
    UNIQUE(symbol, sec_type, exchange, currency, expiry, strike, right)
);

-- Create index for efficient contract lookups
CREATE INDEX IF NOT EXISTS idx_contracts_symbol ON contracts(symbol);
CREATE INDEX IF NOT EXISTS idx_contracts_sec_type ON contracts(sec_type);
CREATE INDEX IF NOT EXISTS idx_contracts_exchange ON contracts(exchange);
CREATE INDEX IF NOT EXISTS idx_contracts_contract_id ON contracts(contract_id);

-- ==============================================
-- HISTORICAL DATA TABLES
-- ==============================================

-- OHLCV candlestick data
CREATE TABLE IF NOT EXISTS candlestick_data (
    id BIGSERIAL PRIMARY KEY,
    contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    timestamp TIMESTAMP NOT NULL,
    timeframe VARCHAR(10) NOT NULL, -- 1min, 5min, 15min, 30min, 1hour, 4hour, 8hour, 1day
    open DECIMAL(15,6) NOT NULL,
    high DECIMAL(15,6) NOT NULL,
    low DECIMAL(15,6) NOT NULL,
    close DECIMAL(15,6) NOT NULL,
    volume BIGINT NOT NULL DEFAULT 0,
    wap DECIMAL(15,6), -- Volume Weighted Average Price
    count INTEGER, -- Number of trades
    created_at TIMESTAMP DEFAULT NOW(),
    
    -- Composite unique constraint to prevent duplicates
    UNIQUE(contract_id, timestamp, timeframe)
);

-- Create indexes for efficient data retrieval
CREATE INDEX IF NOT EXISTS idx_candlestick_contract_timeframe ON candlestick_data(contract_id, timeframe);
CREATE INDEX IF NOT EXISTS idx_candlestick_timestamp ON candlestick_data(timestamp);
CREATE INDEX IF NOT EXISTS idx_candlestick_contract_timestamp ON candlestick_data(contract_id, timestamp);

-- Real-time tick data (for high-frequency data)
CREATE TABLE IF NOT EXISTS tick_data (
    id BIGSERIAL PRIMARY KEY,
    contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    timestamp TIMESTAMP NOT NULL,
    tick_type VARCHAR(20) NOT NULL, -- bid, ask, last, volume, etc.
    price DECIMAL(15,6),
    size INTEGER,
    exchange VARCHAR(20),
    special_conditions VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tick_contract_timestamp ON tick_data(contract_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_tick_type ON tick_data(tick_type);

-- ==============================================
-- TECHNICAL INDICATORS
-- ==============================================

-- Technical indicators calculated from candlestick data
CREATE TABLE IF NOT EXISTS technical_indicators (
    id BIGSERIAL PRIMARY KEY,
    candlestick_id BIGINT NOT NULL REFERENCES candlestick_data(id) ON DELETE CASCADE,
    contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    timestamp TIMESTAMP NOT NULL,
    timeframe VARCHAR(10) NOT NULL,
    indicator_name VARCHAR(20) NOT NULL, -- SMA, EMA, RSI, MACD, etc.
    period INTEGER, -- Period for the indicator (e.g., 20 for SMA20)
    value DECIMAL(15,6),
    additional_data JSONB, -- For indicators with multiple values (e.g., MACD signal, histogram)
    created_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(contract_id, timestamp, timeframe, indicator_name, period)
);

CREATE INDEX IF NOT EXISTS idx_indicators_contract_timeframe ON technical_indicators(contract_id, timeframe);
CREATE INDEX IF NOT EXISTS idx_indicators_name ON technical_indicators(indicator_name);

-- ==============================================
-- DATA COLLECTION METADATA
-- ==============================================

-- Track data collection sessions
CREATE TABLE IF NOT EXISTS data_collection_sessions (
    id SERIAL PRIMARY KEY,
    contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    timeframe VARCHAR(10) NOT NULL,
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP,
    status VARCHAR(20) DEFAULT 'active', -- active, completed, failed
    records_collected INTEGER DEFAULT 0,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_contract ON data_collection_sessions(contract_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON data_collection_sessions(status);

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
    last_updated TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(contract_id, timeframe, date)
);

CREATE INDEX IF NOT EXISTS idx_quality_contract_date ON data_quality_metrics(contract_id, date);

-- ==============================================
-- CONFIGURATION TABLES
-- ==============================================

-- Data collection configuration
CREATE TABLE IF NOT EXISTS data_collection_config (
    id SERIAL PRIMARY KEY,
    contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    timeframe VARCHAR(10) NOT NULL,
    enabled BOOLEAN DEFAULT true,
    auto_collect BOOLEAN DEFAULT false,
    collection_interval_minutes INTEGER DEFAULT 5,
    retention_days INTEGER DEFAULT 365, -- How long to keep data
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(contract_id, timeframe)
);

-- ==============================================
-- VIEWS FOR EASY DATA ACCESS
-- ==============================================

-- View for latest candlestick data with indicators
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

-- Function to clean old data based on retention policy
CREATE OR REPLACE FUNCTION clean_old_data()
RETURNS void AS $$
DECLARE
    config_record RECORD;
BEGIN
    FOR config_record IN 
        SELECT contract_id, timeframe, retention_days 
        FROM data_collection_config 
        WHERE enabled = true
    LOOP
        -- Delete old candlestick data
        DELETE FROM candlestick_data 
        WHERE contract_id = config_record.contract_id 
        AND timeframe = config_record.timeframe
        AND timestamp < NOW() - INTERVAL '1 day' * config_record.retention_days;
        
        -- Delete old tick data (keep only 30 days)
        DELETE FROM tick_data 
        WHERE contract_id = config_record.contract_id 
        AND timestamp < NOW() - INTERVAL '30 days';
        
        -- Delete old technical indicators
        DELETE FROM technical_indicators 
        WHERE contract_id = config_record.contract_id 
        AND timeframe = config_record.timeframe
        AND timestamp < NOW() - INTERVAL '1 day' * config_record.retention_days;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

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
ON CONFLICT (symbol, sec_type, exchange, currency, expiry, strike, right) DO NOTHING;

-- ==============================================
-- COMMENTS
-- ==============================================

COMMENT ON TABLE contracts IS 'Stores contract information from Interactive Brokers';
COMMENT ON TABLE candlestick_data IS 'OHLCV candlestick data for all timeframes';
COMMENT ON TABLE tick_data IS 'Real-time tick data for high-frequency analysis';
COMMENT ON TABLE technical_indicators IS 'Calculated technical indicators';
COMMENT ON TABLE data_collection_sessions IS 'Tracks data collection sessions';
COMMENT ON TABLE data_quality_metrics IS 'Data quality metrics and monitoring';
COMMENT ON TABLE data_collection_config IS 'Configuration for data collection';
