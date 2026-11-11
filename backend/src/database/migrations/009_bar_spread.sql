-- The broker's bid-to-ask spread on a bar (E-15).
--
-- Bars from a broker that quotes two prices (OANDA) are mid prices: nothing
-- trades at them. `spread` is the ask close less the bid close of the same
-- bar, so a backtest can fill a buy at the ask and a sell at the bid. It is
-- NULL where the broker does not report both sides, on bars stored before
-- this column existed, and on bars the live recorder built.
--
-- The bars built from 1-minute bars (008) do not carry it.
ALTER TABLE candlestick_data
    ADD COLUMN IF NOT EXISTS spread DOUBLE PRECISION;
