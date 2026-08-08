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
    broker VARCHAR(16) NOT NULL DEFAULT 'ib', -- platform (B1): 'ib' | 'mt5' | 'alpaca' | 'oanda'
    -- Account within that platform (C-0). `broker` names the *protocol*;
    -- this names *which account on it*. Together they are a "connection".
    -- Defaults to 'default' so a single-account deployment is unchanged.
    broker_account VARCHAR(64) NOT NULL DEFAULT 'default',
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

    -- Composite unique constraint. Connection-scoped (C-0) so the same symbol
    -- at two venues — or at two accounts on the same venue, where the same
    -- instrument can carry a different suffix per broker — never collide.
    CONSTRAINT contracts_connection_key
        UNIQUE (broker, broker_account, symbol, sec_type, exchange, currency, expiry, strike, "right")
);

-- Create index for efficient contract lookups
CREATE INDEX IF NOT EXISTS idx_contracts_symbol ON contracts(symbol);
CREATE INDEX IF NOT EXISTS idx_contracts_sec_type ON contracts(sec_type);
CREATE INDEX IF NOT EXISTS idx_contracts_exchange ON contracts(exchange);
CREATE INDEX IF NOT EXISTS idx_contracts_contract_id ON contracts(contract_id);
CREATE INDEX IF NOT EXISTS idx_contracts_broker_symbol
    ON contracts(broker, broker_account, symbol);

-- Existing deployments: add the broker + broker_account columns and re-key the
-- uniqueness to include them (B1, then C-0). Idempotent — safe to re-run.
--
-- The pre-B1 constraint keyed on (symbol, …) and the B1 one on (broker, …);
-- both are superseded by the connection-scoped key, and both are matched by
-- definition text because their generated names vary across deployments.
DO $$
DECLARE cname text;
BEGIN
    ALTER TABLE contracts ADD COLUMN IF NOT EXISTS broker VARCHAR(16) NOT NULL DEFAULT 'ib';
    ALTER TABLE contracts ADD COLUMN IF NOT EXISTS broker_account VARCHAR(64) NOT NULL DEFAULT 'default';

    FOR cname IN
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = 'contracts'::regclass
           AND contype = 'u'
           AND (pg_get_constraintdef(oid) LIKE 'UNIQUE (symbol,%'
             OR pg_get_constraintdef(oid) LIKE 'UNIQUE (broker, symbol,%')
    LOOP
        EXECUTE format('ALTER TABLE contracts DROP CONSTRAINT %I', cname);
    END LOOP;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'contracts'::regclass AND conname = 'contracts_connection_key'
    ) THEN
        ALTER TABLE contracts ADD CONSTRAINT contracts_connection_key
            UNIQUE (broker, broker_account, symbol, sec_type, exchange, currency, expiry, strike, "right");
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
    broker VARCHAR(16) NOT NULL DEFAULT 'ib',   -- execution platform: 'ib' | 'mt5' | 'alpaca' | 'oanda' (B1)
    broker_account VARCHAR(64) NOT NULL DEFAULT 'default', -- account on that platform (C-0)
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
-- Existing deployments: add the broker column if it predates B1, and the
-- account column if it predates C-0. **These must run before the indexes
-- below**, which reference `broker_account` — on an existing table the
-- CREATE TABLE above is a no-op, so the ALTER is what actually adds it.
ALTER TABLE order_audit ADD COLUMN IF NOT EXISTS broker VARCHAR(16) NOT NULL DEFAULT 'ib';
ALTER TABLE order_audit ADD COLUMN IF NOT EXISTS broker_account VARCHAR(64) NOT NULL DEFAULT 'default';

-- Backs the net-exposure guard, keyed per **connection** + symbol + mode
-- (C-0). Keying on `broker` alone summed every account on a platform into one
-- number: three MT5 accounts each 1 lot long EURUSD presented as 3 lots
-- against a limit meant to be per-account. The guard fails closed, so the
-- symptom was entries refused on accounts nowhere near their limit — which
-- invites raising the cap, removing the protection from all three.
--
-- Deliberately a **new index name**. `CREATE INDEX IF NOT EXISTS` against the
-- B1 name would find the old index already present and silently keep its old
-- (broker, symbol, …) definition, leaving the bug in place on exactly the
-- deployments that need the fix.
DROP INDEX IF EXISTS idx_order_audit_net_key;
CREATE INDEX IF NOT EXISTS idx_order_audit_conn_net_key
    ON order_audit (broker, broker_account, symbol, account_mode, submitted_at DESC)
    WHERE ib_order_id IS NOT NULL;

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
    -- Default connection for runs created from this definition (C-0). A
    -- definition is not *bound* to one account — deploying it to several is
    -- the point of run groups (C4) — this is only the default a run inherits.
    broker_account VARCHAR(64) NOT NULL DEFAULT 'default',
    symbol VARCHAR(32) NOT NULL,
    sec_type VARCHAR(8) NOT NULL DEFAULT 'STK',
    exchange VARCHAR(32) NOT NULL DEFAULT 'SMART',
    currency VARCHAR(8) NOT NULL DEFAULT 'USD',
    timeframe VARCHAR(16) NOT NULL,
    rule_set JSONB NOT NULL,                 -- the declarative rule-set
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Instrument scope for existing deployments (systematic strategies on any
-- instrument): definitions created before these columns existed default to
-- the previously-implied STK/SMART/USD contract.
ALTER TABLE strategy_definitions ADD COLUMN IF NOT EXISTS sec_type VARCHAR(8) NOT NULL DEFAULT 'STK';
ALTER TABLE strategy_definitions ADD COLUMN IF NOT EXISTS exchange VARCHAR(32) NOT NULL DEFAULT 'SMART';
ALTER TABLE strategy_definitions ADD COLUMN IF NOT EXISTS currency VARCHAR(8) NOT NULL DEFAULT 'USD';
ALTER TABLE strategy_definitions ADD COLUMN IF NOT EXISTS broker_account VARCHAR(64) NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_strategy_definitions_created_desc
    ON strategy_definitions (created_at DESC);

-- ==============================================
-- RUN GROUPS (Component C — C-3)
-- ==============================================
-- One definition deployed to N connections becomes N `strategy_runs` sharing a
-- group. The group is a **lifecycle and reporting** layer, not a risk layer:
-- every cap, kill switch and sizing rule stays per run, so a leg that breaches
-- its own daily loss cap stops on its own account while its siblings continue.
--
-- Legs are created **atomically** — a half-created group is broken state — but
-- **started in stages**. With one strategy on every account the group is a
-- shared failure domain, so a bad rule-set edit would otherwise reach every
-- account simultaneously. One nominated canary starts immediately; the rest
-- sit at status='pending' until the canary has evaluated cleanly for
-- `settle_seconds`, then they are admitted together.

CREATE TABLE IF NOT EXISTS strategy_run_groups (
    id BIGSERIAL PRIMARY KEY,
    definition_id BIGINT NOT NULL REFERENCES strategy_definitions(id) ON DELETE CASCADE,
    status VARCHAR(16) NOT NULL DEFAULT 'staging',  -- 'staging' | 'running' | 'stopped'
    -- How long the canary must evaluate without error before the rest start.
    -- Should span at least one bar of the slowest timeframe in the group, so
    -- "evaluated cleanly" means it produced a decision rather than merely
    -- started without throwing.
    settle_seconds INTEGER NOT NULL DEFAULT 300,
    admitted_at TIMESTAMPTZ,                        -- when the non-canary legs started
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_strategy_run_groups_status
    ON strategy_run_groups (status);
CREATE INDEX IF NOT EXISTS idx_strategy_run_groups_definition
    ON strategy_run_groups (definition_id, created_at DESC);

CREATE TABLE IF NOT EXISTS strategy_runs (
    id BIGSERIAL PRIMARY KEY,
    definition_id BIGINT NOT NULL REFERENCES strategy_definitions(id) ON DELETE CASCADE,
    broker VARCHAR(16) NOT NULL DEFAULT 'ib',
    -- The connection this run executes on (C-0). One run = one instrument on
    -- one connection; deploying a definition to several accounts creates
    -- several runs (C4).
    broker_account VARCHAR(64) NOT NULL DEFAULT 'default',
    -- The connection's own name for the definition's canonical symbol (C-2),
    -- resolved once at run creation. Stored rather than re-derived per tick so
    -- a live run's instrument is a recorded fact: EURUSD may be EURUSD.a here
    -- and EURUSD_i on the next account, and re-resolving each tick would let a
    -- catalogue change silently move a running strategy to another contract.
    -- NULL means "use the definition's symbol" — every pre-C-2 run.
    native_symbol VARCHAR(64),
    account_mode VARCHAR(8) NOT NULL DEFAULT 'paper',   -- 'paper' | 'live'
    -- The group this leg belongs to (C-3). NULL for a standalone run, which is
    -- every run created before groups existed.
    run_group_id BIGINT REFERENCES strategy_run_groups(id) ON DELETE SET NULL,
    -- The leg that starts first and must evaluate cleanly before the rest are
    -- admitted. Exactly one per group.
    is_canary BOOLEAN NOT NULL DEFAULT FALSE,
    -- 'pending' is new (C-3): created but deliberately not yet evaluating. The
    -- runner only picks up 'running', so a pending leg is inert without any
    -- change to the evaluation loop.
    status VARCHAR(16) NOT NULL DEFAULT 'running',   -- 'pending' | 'running' | 'stopped' | 'error'
    -- The protective stop the app last set for this run's open position (E-5).
    -- Recorded so a *closed* position can be compared against the stop that was
    -- in force: a fill materially worse than it is evidence the market gapped
    -- through, which is the case the kill switch exists to catch and cannot be
    -- reconstructed after the fact from anything else.
    --
    -- One strategy per instrument per account (E10) is what makes the run row
    -- the right home for this: there is only ever one position to describe.
    -- NULL means the run holds no protected position.
    current_stop NUMERIC(20,8),
    sizing JSONB NOT NULL DEFAULT '{}'::jsonb,           -- carried through for A3
    risk JSONB NOT NULL DEFAULT '{}'::jsonb,             -- carried through for A3
    last_evaluated_at TIMESTAMPTZ,
    last_error TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    stopped_at TIMESTAMPTZ
);

-- Existing deployments: add the connection column if it predates C-0.
ALTER TABLE strategy_runs ADD COLUMN IF NOT EXISTS broker_account VARCHAR(64) NOT NULL DEFAULT 'default';
ALTER TABLE strategy_runs ADD COLUMN IF NOT EXISTS native_symbol VARCHAR(64);
ALTER TABLE strategy_runs ADD COLUMN IF NOT EXISTS run_group_id BIGINT REFERENCES strategy_run_groups(id) ON DELETE SET NULL;
ALTER TABLE strategy_runs ADD COLUMN IF NOT EXISTS is_canary BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE strategy_runs ADD COLUMN IF NOT EXISTS current_stop NUMERIC(20,8);

CREATE INDEX IF NOT EXISTS idx_strategy_runs_group
    ON strategy_runs (run_group_id) WHERE run_group_id IS NOT NULL;
-- Guard against deploying the same definition to one connection twice — the
-- second leg would fight the first for the same position.
CREATE UNIQUE INDEX IF NOT EXISTS idx_strategy_runs_one_per_connection_definition
    ON strategy_runs (broker, broker_account, definition_id)
    WHERE status IN ('pending', 'running');

-- One strategy per instrument per account (Component E, E10). Under MT5
-- netting there is a single net position per symbol, so two runs on one
-- instrument at one account each size and exit against exposure neither of
-- them controls — their internal position tracking would be fiction. Keyed on
-- `native_symbol` because that is what actually trades; NULL (pre-C-2) rows
-- are excluded rather than colliding with each other.
--
-- Lifting this is FUTURE_DECISION_POINTS C-P3, and needs a position-ownership
-- layer rather than just dropping the index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_strategy_runs_one_per_connection_symbol
    ON strategy_runs (broker, broker_account, native_symbol)
    WHERE native_symbol IS NOT NULL AND status IN ('pending', 'running');

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
-- EXECUTIONS (FILLS)
-- ==============================================
-- `order_audit` records what the app *asked* a venue to trade. This table
-- records what actually **traded** — the venue's own execution reports, polled
-- from `/account/executions` on the broker service and upserted here.
--
-- The distinction is the whole point. Positions and realised P&L used to be
-- inferred from submitted orders, which silently disagrees with the account on
-- a partial fill, on a rejection that lands after the acknowledgement, and on
-- any trade placed outside the app. Deriving them from fills instead is what
-- makes them authoritative — and is what lets `risk.max_daily_loss` be
-- enforced rather than accepted and ignored.
--
-- `(broker, broker_account, exec_id)` is unique: the poller deliberately
-- re-fetches an overlapping window every tick (a fill can be reported late,
-- and IB's commission arrives on a separate callback from the fill itself), so
-- re-delivery of a row already seen must be a no-op rather than a duplicate.
--
-- The account is part of that key (C-0) because **fill ids are only unique
-- within an account**. MT5 allocates deal tickets per terminal, starting low,
-- so two MT5 accounts both produce deal `12345` within days of each other.
-- Under the old `(broker, exec_id)` key the second one was silently swallowed
-- as a duplicate: the fill never landed, the position was wrong, realised P&L
-- was wrong, and `risk.max_daily_loss` — which is measured from this table —
-- under-counted losses and therefore kept trading.
--
-- `order_audit_id` / `run_id` are the attribution links, resolved from the
-- venue's order id at upsert time and re-resolved for any row that arrived
-- before its audit row had one. They are nullable by design: a manual trade
-- placed directly at the venue is a real fill with no order of ours behind it,
-- and it *should* count toward the account position.

CREATE TABLE IF NOT EXISTS order_executions (
    id BIGSERIAL PRIMARY KEY,
    broker VARCHAR(16) NOT NULL DEFAULT 'ib',
    broker_account VARCHAR(64) NOT NULL DEFAULT 'default', -- account on that platform (C-0)
    account_mode VARCHAR(8) NOT NULL DEFAULT 'paper',   -- 'paper' | 'live'
    exec_id VARCHAR(128) NOT NULL,                      -- the venue's own fill id
    broker_order_id VARCHAR(64),                        -- venue order id (IB's is numeric, others aren't)
    order_audit_id BIGINT REFERENCES order_audit(id) ON DELETE SET NULL,
    run_id BIGINT REFERENCES strategy_runs(id) ON DELETE SET NULL,
    symbol VARCHAR(32) NOT NULL,
    side VARCHAR(4) NOT NULL,                           -- 'BUY' | 'SELL'
    quantity NUMERIC(20,6) NOT NULL,                    -- always positive; direction is in `side`
    price NUMERIC(20,6) NOT NULL,
    commission NUMERIC(20,6),                           -- NULL = not reported (yet)
    realized_pnl NUMERIC(20,6),                         -- the venue's own figure, when it supplies one
    currency VARCHAR(8) NOT NULL DEFAULT 'USD',
    executed_at TIMESTAMPTZ NOT NULL,
    raw JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT order_executions_connection_exec_key
        UNIQUE (broker, broker_account, exec_id)
);

-- Existing deployments: add the account column, then re-key. Must precede the
-- constraint and indexes below, which reference it.
ALTER TABLE order_executions
    ADD COLUMN IF NOT EXISTS broker_account VARCHAR(64) NOT NULL DEFAULT 'default';

-- Replace the B1-era `(broker, exec_id)` key with the connection-scoped one.
-- Matched by definition text because its generated name varies by deployment.
--
-- ⚠️ **Apply this before configuring a second account on any platform.** Once
-- two accounts have both reported the same exec_id, the losing row was never
-- written — the constraint can be widened afterwards, but the swallowed fills
-- are only recoverable by re-polling a window that still covers them.
DO $$
DECLARE cname text;
BEGIN
    FOR cname IN
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = 'order_executions'::regclass
           AND contype = 'u'
           AND pg_get_constraintdef(oid) = 'UNIQUE (broker, exec_id)'
    LOOP
        EXECUTE format('ALTER TABLE order_executions DROP CONSTRAINT %I', cname);
    END LOOP;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'order_executions'::regclass
           AND conname = 'order_executions_connection_exec_key'
    ) THEN
        ALTER TABLE order_executions ADD CONSTRAINT order_executions_connection_exec_key
            UNIQUE (broker, broker_account, exec_id);
    END IF;
END $$;

-- Backs the position / realised-P&L reducers, which always scope by connection
-- + instrument + account mode and walk fills in execution order. New index
-- name for the same reason as the order_audit one: `IF NOT EXISTS` against the
-- old name would keep the old, account-blind definition.
DROP INDEX IF EXISTS idx_order_executions_position_key;
CREATE INDEX IF NOT EXISTS idx_order_executions_conn_position_key
    ON order_executions (broker, broker_account, symbol, account_mode, executed_at);
CREATE INDEX IF NOT EXISTS idx_order_executions_executed_desc
    ON order_executions (executed_at DESC);
-- Backs per-run realised P&L (the `max_daily_loss` cap).
CREATE INDEX IF NOT EXISTS idx_order_executions_run
    ON order_executions (run_id, executed_at) WHERE run_id IS NOT NULL;
-- Backs the re-link pass over fills whose audit row had no venue order id yet.
-- Venue order ids collide across accounts for the same reason exec ids do.
DROP INDEX IF EXISTS idx_order_executions_unlinked;
CREATE INDEX IF NOT EXISTS idx_order_executions_conn_unlinked
    ON order_executions (broker, broker_account, broker_order_id)
    WHERE order_audit_id IS NULL AND broker_order_id IS NOT NULL;

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
-- PRICE ALERTS
-- ==============================================
-- In-app-only price alerts on a watchlist symbol. There is no delivery
-- channel (email/SMS/webhook) here by design — the frontend evaluates
-- `condition`/`target_price` against the quote it already polls for the
-- watchlist row, flips the alert to 'triggered' via the API when crossed,
-- and surfaces it in-page (plus a browser Notification when permitted).
-- Deleting a watchlist item cascades to its alerts.

CREATE TABLE IF NOT EXISTS price_alerts (
    id BIGSERIAL PRIMARY KEY,
    watchlist_item_id BIGINT NOT NULL REFERENCES watchlist_items(id) ON DELETE CASCADE,
    condition VARCHAR(8) NOT NULL,              -- 'above' | 'below'
    target_price NUMERIC(20,4) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'active', -- 'active' | 'triggered' | 'dismissed'
    triggered_at TIMESTAMPTZ,
    triggered_price NUMERIC(20,4),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_price_alerts_item
    ON price_alerts (watchlist_item_id);
CREATE INDEX IF NOT EXISTS idx_price_alerts_status
    ON price_alerts (status);

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

