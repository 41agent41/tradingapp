-- One connection type per firm (docs/plans/ENHANCEMENT_PLAN.md, E-31). Each
-- connection names its firm, and the firm decides the platform
-- (services/firms.ts): OANDA, IG, the cTrader firms and Alpaca through their
-- web APIs, Axi, Eightcap, Vantage and other firms without one through the
-- MT5 bridge, Interactive Brokers through IB Gateway.
--
-- Existing rows get a firm where it is certain:
--   * OANDA, IG, Alpaca and IB rows: the platform's own firm.
--   * cTrader and MT5 rows named after a firm of that platform (the form
--     named them so): that firm, for example ctrader:icmarkets -> icmarkets.
-- Every other row keeps firm NULL. The Getting started checklist lists them,
-- and saving one asks for its firm. A row that breaks the rule (for example
-- mt5:icmarkets, an IC Markets account on the MT5 bridge) cannot be given a
-- firm: remove it and add the account through the firm's web API.
ALTER TABLE broker_connections ADD COLUMN IF NOT EXISTS firm VARCHAR(32);

UPDATE broker_connections SET firm = platform
 WHERE firm IS NULL AND platform IN ('oanda', 'ig', 'alpaca', 'ib');

UPDATE broker_connections SET firm = account
 WHERE firm IS NULL
   AND ((platform = 'ctrader' AND account IN ('pepperstone', 'icmarkets', 'fpmarkets', 'fusion'))
     OR (platform = 'mt5' AND account IN ('axi', 'eightcap', 'vantage')));
