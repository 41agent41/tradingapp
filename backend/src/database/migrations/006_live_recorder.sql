-- The live recorder (docs/plans/E-05-live-recorder.md): 1-minute bars built
-- from the quote stream, and the quotes themselves for a set number of days.

-- What is recorded. Both are per contract: the app keeps every row of a
-- contract the same. Off until chosen, so an upgrade records nothing by itself.
--   record_live   build and store 1-minute bars from the live stream
--   record_ticks  also store each quote (needs record_live)
ALTER TABLE data_collection_config
    ADD COLUMN IF NOT EXISTS record_live BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS record_ticks BOOLEAN NOT NULL DEFAULT FALSE;

-- Where a bar came from: 'broker' (the broker's own history, which every bar
-- stored before this was) or 'stream' (built by the recorder). A broker bar
-- replaces a stream bar; a stream bar never replaces a broker bar.
ALTER TABLE candlestick_data
    ADD COLUMN IF NOT EXISTS source VARCHAR(8) NOT NULL DEFAULT 'broker';

-- Stored quotes. No unique key: one instant can carry two quotes. The
-- recorder's cursor (below) is what stops a quote being stored twice.
CREATE TABLE IF NOT EXISTS quote_ticks (
    contract_id INTEGER NOT NULL,
    ts          TIMESTAMPTZ NOT NULL,
    bid         DOUBLE PRECISION,
    ask         DOUBLE PRECISION,
    last        DOUBLE PRECISION,
    last_size   DOUBLE PRECISION,
    recv_ts     TIMESTAMPTZ NOT NULL
);
SELECT create_hypertable('quote_ticks', 'ts', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_quote_ticks_contract_ts ON quote_ticks (contract_id, ts DESC);

-- Quotes are only ever appended, so chunks are compressed after a day. Old
-- chunks are dropped by the app's own cleanup (TICK_RETENTION_DAYS), not by a
-- retention policy, so the setting takes effect without a migration.
ALTER TABLE quote_ticks SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'contract_id',
    timescaledb.compress_orderby = 'ts'
);
SELECT add_compression_policy('quote_ticks', INTERVAL '1 day', if_not_exists => TRUE);

-- The last stream entry the recorder has stored. It moves in the same
-- transaction as the bars and quotes that entry produced, so after any restart
-- the recorder resumes at the next entry: nothing twice, nothing skipped.
CREATE TABLE IF NOT EXISTS recorder_cursor (
    id            BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    last_entry_id TEXT NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
