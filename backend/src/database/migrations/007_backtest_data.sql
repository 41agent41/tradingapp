-- What a backtest ran on (E-02): where the bars came from, how many, the first
-- and last bar, and a hash of exactly those bars, so a run can be repeated on
-- the same data and shown to have been.
--   {"source": "stored" | "broker", "contract_id": 12, "bars": 6210,
--    "first_bar": "...", "last_bar": "...", "hash": "<sha256>", "complete": true}
-- NULL on runs made before this, and for bars fetched by the broker service.
ALTER TABLE backtest_runs
    ADD COLUMN IF NOT EXISTS data JSONB;
