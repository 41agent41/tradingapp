-- Migration Script: Standard PostgreSQL to TimescaleDB
-- This script migrates existing TradingApp data to TimescaleDB-optimized schema
-- Run this AFTER setting up TimescaleDB and BEFORE running the new schema

-- ==============================================
-- PRE-MIGRATION CHECKS
-- ==============================================

-- Check if TimescaleDB extension is available
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
        RAISE EXCEPTION 'TimescaleDB extension not found. Please install TimescaleDB first.';
    END IF;
    RAISE NOTICE 'TimescaleDB extension found. Proceeding with migration...';
END $$;

-- Check if old tables exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'candlestick_data') THEN
        RAISE EXCEPTION 'Old candlestick_data table not found. Nothing to migrate.';
    END IF;
    RAISE NOTICE 'Old tables found. Starting migration...';
END $$;

-- ==============================================
-- BACKUP EXISTING DATA
-- ==============================================

-- Create backup tables
CREATE TABLE IF NOT EXISTS contracts_backup AS SELECT * FROM contracts;
CREATE TABLE IF NOT EXISTS candlestick_data_backup AS SELECT * FROM candlestick_data;
CREATE TABLE IF NOT EXISTS tick_data_backup AS SELECT * FROM tick_data;
CREATE TABLE IF NOT EXISTS technical_indicators_backup AS SELECT * FROM technical_indicators;
CREATE TABLE IF NOT EXISTS data_collection_sessions_backup AS SELECT * FROM data_collection_sessions;
CREATE TABLE IF NOT EXISTS data_quality_metrics_backup AS SELECT * FROM data_quality_metrics;
CREATE TABLE IF NOT EXISTS data_collection_config_backup AS SELECT * FROM data_collection_config;

-- ==============================================
-- DROP OLD CONSTRAINTS AND INDEXES
-- ==============================================

-- Drop foreign key constraints that reference candlestick_data
ALTER TABLE technical_indicators DROP CONSTRAINT IF EXISTS technical_indicators_candlestick_id_fkey;

-- Drop old indexes
DROP INDEX IF EXISTS idx_candlestick_contract_timeframe;
DROP INDEX IF EXISTS idx_candlestick_timestamp;
DROP INDEX IF EXISTS idx_candlestick_contract_timestamp;
DROP INDEX IF EXISTS idx_tick_contract_timestamp;
DROP INDEX IF EXISTS idx_tick_type;
DROP INDEX IF EXISTS idx_indicators_contract_timeframe;
DROP INDEX IF EXISTS idx_indicators_name;

-- ==============================================
-- ALTER EXISTING TABLES FOR TIMESCALEDB
-- ==============================================

-- Convert timestamp columns to TIMESTAMPTZ
ALTER TABLE contracts ALTER COLUMN created_at TYPE TIMESTAMPTZ;
ALTER TABLE contracts ALTER COLUMN updated_at TYPE TIMESTAMPTZ;

ALTER TABLE candlestick_data ALTER COLUMN timestamp TYPE TIMESTAMPTZ;
ALTER TABLE candlestick_data ALTER COLUMN created_at TYPE TIMESTAMPTZ;

ALTER TABLE tick_data ALTER COLUMN timestamp TYPE TIMESTAMPTZ;
ALTER TABLE tick_data ALTER COLUMN created_at TYPE TIMESTAMPTZ;

ALTER TABLE technical_indicators ALTER COLUMN timestamp TYPE TIMESTAMPTZ;
ALTER TABLE technical_indicators ALTER COLUMN created_at TYPE TIMESTAMPTZ;

ALTER TABLE data_collection_sessions ALTER COLUMN start_time TYPE TIMESTAMPTZ;
ALTER TABLE data_collection_sessions ALTER COLUMN end_time TYPE TIMESTAMPTZ;
ALTER TABLE data_collection_sessions ALTER COLUMN created_at TYPE TIMESTAMPTZ;
ALTER TABLE data_collection_sessions ALTER COLUMN updated_at TYPE TIMESTAMPTZ;

ALTER TABLE data_quality_metrics ALTER COLUMN last_updated TYPE TIMESTAMPTZ;

ALTER TABLE data_collection_config ALTER COLUMN created_at TYPE TIMESTAMPTZ;
ALTER TABLE data_collection_config ALTER COLUMN updated_at TYPE TIMESTAMPTZ;

-- ==============================================
-- CONVERT TO HYPERTABLES
-- ==============================================

-- Convert candlestick_data to hypertable
SELECT create_hypertable('candlestick_data', 'timestamp', chunk_time_interval => INTERVAL '1 day');

-- Convert tick_data to hypertable
SELECT create_hypertable('tick_data', 'timestamp', chunk_time_interval => INTERVAL '1 hour');

-- Convert technical_indicators to hypertable
SELECT create_hypertable('technical_indicators', 'timestamp', chunk_time_interval => INTERVAL '1 day');

-- ==============================================
-- RECREATE OPTIMIZED INDEXES
-- ==============================================

-- TimescaleDB-optimized indexes for candlestick_data
CREATE INDEX IF NOT EXISTS idx_candlestick_contract_timeframe_timestamp ON candlestick_data(contract_id, timeframe, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_candlestick_timestamp_desc ON candlestick_data(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_candlestick_contract_timestamp_desc ON candlestick_data(contract_id, timestamp DESC);

-- TimescaleDB-optimized indexes for tick_data
CREATE INDEX IF NOT EXISTS idx_tick_contract_timestamp_desc ON tick_data(contract_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_tick_type_timestamp ON tick_data(tick_type, timestamp DESC);

-- TimescaleDB-optimized indexes for technical_indicators
CREATE INDEX IF NOT EXISTS idx_indicators_contract_timeframe_timestamp ON technical_indicators(contract_id, timeframe, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_indicators_name_timestamp ON technical_indicators(indicator_name, timestamp DESC);

-- ==============================================
-- RECREATE FOREIGN KEY CONSTRAINTS
-- ==============================================

-- Recreate foreign key constraint for technical_indicators
ALTER TABLE technical_indicators 
ADD CONSTRAINT technical_indicators_candlestick_id_fkey 
FOREIGN KEY (candlestick_id) REFERENCES candlestick_data(id) ON DELETE CASCADE;

-- ==============================================
-- CREATE CONTINUOUS AGGREGATES
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

-- ==============================================
-- SET UP CONTINUOUS AGGREGATE POLICIES
-- ==============================================

-- Add refresh policy for daily aggregates (refresh every hour)
SELECT add_continuous_aggregate_policy('daily_candlestick_data',
    start_offset => INTERVAL '3 days',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');

-- Add refresh policy for hourly aggregates
SELECT add_continuous_aggregate_policy('hourly_candlestick_data',
    start_offset => INTERVAL '1 day',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');

-- ==============================================
-- SET UP DATA RETENTION POLICIES
-- ==============================================

-- Set up automated data retention policies
-- Keep candlestick data for 2 years
SELECT add_retention_policy('candlestick_data', INTERVAL '2 years');

-- Keep tick data for 30 days (high frequency, large volume)
SELECT add_retention_policy('tick_data', INTERVAL '30 days');

-- Keep technical indicators for 2 years (same as candlestick data)
SELECT add_retention_policy('technical_indicators', INTERVAL '2 years');

-- ==============================================
-- UPDATE VIEWS
-- ==============================================

-- Update the latest_candlestick_data view
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

-- Create new view for daily aggregated data
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
-- UPDATE FUNCTIONS AND TRIGGERS
-- ==============================================

-- Update the data quality monitoring function
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

-- Recreate the trigger for data quality metrics
DROP TRIGGER IF EXISTS update_quality_metrics_trigger ON candlestick_data;
CREATE TRIGGER update_quality_metrics_trigger
    AFTER INSERT OR UPDATE ON candlestick_data
    FOR EACH ROW EXECUTE FUNCTION update_data_quality_metrics();

-- ==============================================
-- VERIFICATION
-- ==============================================

-- Verify TimescaleDB extension is enabled
SELECT 'TimescaleDB Extension' as check_type, 
       CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') 
            THEN 'OK' ELSE 'FAIL' END as status;

-- Verify hypertables were created
SELECT 'Hypertables Created' as check_type,
       COUNT(*) as count,
       CASE WHEN COUNT(*) >= 3 THEN 'OK' ELSE 'FAIL' END as status
FROM timescaledb_information.hypertables
WHERE hypertable_name IN ('candlestick_data', 'tick_data', 'technical_indicators');

-- Verify continuous aggregates were created
SELECT 'Continuous Aggregates Created' as check_type,
       COUNT(*) as count,
       CASE WHEN COUNT(*) >= 2 THEN 'OK' ELSE 'FAIL' END as status
FROM timescaledb_information.continuous_aggregates
WHERE view_name IN ('daily_candlestick_data', 'hourly_candlestick_data');

-- Verify retention policies were created
SELECT 'Retention Policies Created' as check_type,
       COUNT(*) as count,
       CASE WHEN COUNT(*) >= 3 THEN 'OK' ELSE 'FAIL' END as status
FROM timescaledb_information.policies
WHERE hypertable_name IN ('candlestick_data', 'tick_data', 'technical_indicators');

-- Verify data integrity
SELECT 'Data Integrity Check' as check_type,
       (SELECT COUNT(*) FROM candlestick_data) as candlestick_count,
       (SELECT COUNT(*) FROM tick_data) as tick_count,
       (SELECT COUNT(*) FROM technical_indicators) as indicators_count,
       CASE WHEN (SELECT COUNT(*) FROM candlestick_data) > 0 THEN 'OK' ELSE 'WARNING' END as status;

-- ==============================================
-- CLEANUP (OPTIONAL)
-- ==============================================

-- Uncomment the following lines to remove backup tables after successful migration
-- DROP TABLE IF EXISTS contracts_backup;
-- DROP TABLE IF EXISTS candlestick_data_backup;
-- DROP TABLE IF EXISTS tick_data_backup;
-- DROP TABLE IF EXISTS technical_indicators_backup;
-- DROP TABLE IF EXISTS data_collection_sessions_backup;
-- DROP TABLE IF EXISTS data_quality_metrics_backup;
-- DROP TABLE IF EXISTS data_collection_config_backup;

-- ==============================================
-- COMPLETION MESSAGE
-- ==============================================

DO $$
BEGIN
    RAISE NOTICE '==============================================';
    RAISE NOTICE 'TimescaleDB Migration Completed Successfully!';
    RAISE NOTICE '==============================================';
    RAISE NOTICE 'Migration Summary:';
    RAISE NOTICE '- TimescaleDB extension enabled';
    RAISE NOTICE '- Tables converted to hypertables';
    RAISE NOTICE '- Continuous aggregates created';
    RAISE NOTICE '- Retention policies configured';
    RAISE NOTICE '- Optimized indexes created';
    RAISE NOTICE '- Data quality monitoring updated';
    RAISE NOTICE '- Backup tables created for safety';
    RAISE NOTICE '';
    RAISE NOTICE 'Next Steps:';
    RAISE NOTICE '1. Test your application with the new schema';
    RAISE NOTICE '2. Monitor continuous aggregate refresh policies';
    RAISE NOTICE '3. Verify data retention policies are working';
    RAISE NOTICE '4. Remove backup tables after confirming everything works';
    RAISE NOTICE '5. Update your application configuration if needed';
    RAISE NOTICE '';
    RAISE NOTICE 'Your TradingApp is now optimized for time-series data!';
END $$;
