/**
 * The app's reader of stored bars (`BacktestData`), wired to the database and
 * the broker history path. Backtests and bar replay share it.
 */
import { dbService } from './database.js';
import { marketDataService } from './marketDataService.js';
import { fetchBrokerHistory, historyChunkDays } from './backfillScheduler.js';
import { BacktestData } from './backtestData.js';

export const storedBars = new BacktestData({
  db: dbService,
  getOrCreateContract: (c) => marketDataService.getOrCreateContract(c),
  fetchHistory: fetchBrokerHistory,
  storeCandlestickData: (id, timeframe, bars) =>
    marketDataService.storeCandlestickData(id, timeframe, bars),
  chunkDays: historyChunkDays,
});
