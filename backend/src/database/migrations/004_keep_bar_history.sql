-- Bars are kept until the app's own cleanup removes them.
--
-- The baseline schema used to add a TimescaleDB retention policy that dropped
-- every candlestick_data chunk older than two years. A policy works on whole
-- chunks by age, so it also deleted deep history collected back to an entry's
-- history_start, which cleanOldData is careful to keep. The baseline no longer
-- adds it; this removes it from databases that already have it. Bars already
-- dropped are not restored: the backfill scheduler fetches them again once an
-- entry's history cursor (backfilled_to) is reset.
SELECT remove_retention_policy('candlestick_data', if_exists => true);

-- Entries whose history start is more than two years back may have lost bars
-- to the old policy. Clearing the cursor makes the scheduler walk back again
-- from the oldest bar still stored, re-collecting what was dropped.
UPDATE data_collection_config
   SET backfilled_to = NULL
 WHERE history_start IS NOT NULL
   AND history_start < (NOW() - INTERVAL '2 years')::date
   AND backfilled_to IS NOT NULL;
