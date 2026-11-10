-- Higher timeframes built from 1-minute bars (E-08).
--
-- One continuous aggregate per timeframe over the 1-minute bars in
-- candlestick_data, whatever their source (broker or live recorder). A built
-- bar is the first open, highest high, lowest low, last close and summed
-- volume of the 1-minute bars inside its bucket. `minutes` is how many
-- 1-minute bars went into it, so a thin bar can be told from a full one.
--
-- Buckets are aligned to UTC: a 4-hour bar starts at 00:00, 04:00, ... UTC and
-- a daily bar at 00:00 UTC. A broker's own 4-hour and daily bars follow its
-- server or session time and can differ.
--
-- Each view is created WITH NO DATA because filling one cannot run inside the
-- transaction a migration is. Nothing is lost: the views are real-time
-- (materialized_only = false), so a query computes whatever is not
-- materialized yet, and the policy below (start_offset NULL: everything that
-- changed, however old) materializes the history in the background, the first
-- time within its schedule interval of being added.

CREATE MATERIALIZED VIEW IF NOT EXISTS bars_5min
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT contract_id,
       time_bucket(INTERVAL '5 minutes', timestamp) AS bucket,
       first(open, timestamp) AS open,
       max(high) AS high,
       min(low) AS low,
       last(close, timestamp) AS close,
       sum(volume) AS volume,
       count(*) AS minutes
  FROM candlestick_data
 WHERE timeframe = '1min'
 GROUP BY contract_id, bucket
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS bars_15min
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT contract_id,
       time_bucket(INTERVAL '15 minutes', timestamp) AS bucket,
       first(open, timestamp) AS open,
       max(high) AS high,
       min(low) AS low,
       last(close, timestamp) AS close,
       sum(volume) AS volume,
       count(*) AS minutes
  FROM candlestick_data
 WHERE timeframe = '1min'
 GROUP BY contract_id, bucket
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS bars_30min
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT contract_id,
       time_bucket(INTERVAL '30 minutes', timestamp) AS bucket,
       first(open, timestamp) AS open,
       max(high) AS high,
       min(low) AS low,
       last(close, timestamp) AS close,
       sum(volume) AS volume,
       count(*) AS minutes
  FROM candlestick_data
 WHERE timeframe = '1min'
 GROUP BY contract_id, bucket
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS bars_1hour
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT contract_id,
       time_bucket(INTERVAL '1 hour', timestamp) AS bucket,
       first(open, timestamp) AS open,
       max(high) AS high,
       min(low) AS low,
       last(close, timestamp) AS close,
       sum(volume) AS volume,
       count(*) AS minutes
  FROM candlestick_data
 WHERE timeframe = '1min'
 GROUP BY contract_id, bucket
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS bars_4hour
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT contract_id,
       time_bucket(INTERVAL '4 hours', timestamp) AS bucket,
       first(open, timestamp) AS open,
       max(high) AS high,
       min(low) AS low,
       last(close, timestamp) AS close,
       sum(volume) AS volume,
       count(*) AS minutes
  FROM candlestick_data
 WHERE timeframe = '1min'
 GROUP BY contract_id, bucket
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS bars_1day
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT contract_id,
       time_bucket(INTERVAL '1 day', timestamp) AS bucket,
       first(open, timestamp) AS open,
       max(high) AS high,
       min(low) AS low,
       last(close, timestamp) AS close,
       sum(volume) AS volume,
       count(*) AS minutes
  FROM candlestick_data
 WHERE timeframe = '1min'
 GROUP BY contract_id, bucket
WITH NO DATA;

-- Keep them current. end_offset leaves the forming bucket to the real-time
-- part of the view; start_offset NULL picks up backfilled and reconciled
-- 1-minute bars of any age.
SELECT add_continuous_aggregate_policy('bars_5min', start_offset => NULL,
    end_offset => INTERVAL '5 minutes', schedule_interval => INTERVAL '15 minutes',
    if_not_exists => TRUE);
SELECT add_continuous_aggregate_policy('bars_15min', start_offset => NULL,
    end_offset => INTERVAL '15 minutes', schedule_interval => INTERVAL '15 minutes',
    if_not_exists => TRUE);
SELECT add_continuous_aggregate_policy('bars_30min', start_offset => NULL,
    end_offset => INTERVAL '30 minutes', schedule_interval => INTERVAL '30 minutes',
    if_not_exists => TRUE);
SELECT add_continuous_aggregate_policy('bars_1hour', start_offset => NULL,
    end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '1 hour',
    if_not_exists => TRUE);
SELECT add_continuous_aggregate_policy('bars_4hour', start_offset => NULL,
    end_offset => INTERVAL '4 hours', schedule_interval => INTERVAL '1 hour',
    if_not_exists => TRUE);
SELECT add_continuous_aggregate_policy('bars_1day', start_offset => NULL,
    end_offset => INTERVAL '1 day', schedule_interval => INTERVAL '1 hour',
    if_not_exists => TRUE);
