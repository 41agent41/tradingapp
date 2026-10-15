-- Deep history for a collected instrument: the backfill scheduler walks back
-- from the oldest bar it has to `history_start`, a chunk at a time.
--
--   history_start  the date to collect back to, or NULL for recent bars only.
--                  Bars from this date on are kept whatever retention_days says.
--   backfilled_to  how far back the scheduler has asked the broker so far: its
--                  cursor, so a gap with no bars (a weekend, a holiday, the
--                  broker's own limit) is passed over rather than retried.
ALTER TABLE data_collection_config
    ADD COLUMN IF NOT EXISTS history_start DATE,
    ADD COLUMN IF NOT EXISTS backfilled_to TIMESTAMPTZ;
