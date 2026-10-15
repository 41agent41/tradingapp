-- Risk caps and prop-firm rules belong to the connection they limit, edited
-- on Settings > Connections rather than as CONNECTION_MAX_*__<CONN> and
-- PROP_RULES__<CONN> lines in .env (which still win when set).
--
--   limits      {"max_orders_per_day": 20, "max_daily_loss": 500,
--                "max_daily_equity_loss": 800, "max_drawdown": 2000}
--               any subset; an absent key falls back to the fleet-wide cap.
--   prop_rules  the prop firm's rules, same JSON as PROP_RULES__<CONN>
--               (services/propRules.ts), or NULL for an ordinary account.
ALTER TABLE broker_connections
    ADD COLUMN IF NOT EXISTS limits JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS prop_rules JSONB;
