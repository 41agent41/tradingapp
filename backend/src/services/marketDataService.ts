import { dbService } from './database.js';
import { PoolClient } from 'pg';

// Interfaces for market data
export interface CandlestickBar {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  wap?: number;
  count?: number;
}

export interface Contract {
  symbol: string;
  secType: string;
  exchange?: string;
  currency?: string;
  multiplier?: string;
  expiry?: string;
  strike?: number;
  right?: string;
  localSymbol?: string;
  contractId?: number;
}

export interface TechnicalIndicator {
  name: string;
  period: number;
  value: number;
  additionalData?: Record<string, any>;
}

// Market Data Service Class
export class MarketDataService {
  
  // Get or create contract in database
  async getOrCreateContract(contract: Contract): Promise<number> {
    const query = `
      INSERT INTO contracts (symbol, sec_type, exchange, currency, multiplier, expiry, strike, right, local_symbol, contract_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (symbol, sec_type, exchange, currency, expiry, strike, right)
      DO UPDATE SET 
        local_symbol = EXCLUDED.local_symbol,
        contract_id = EXCLUDED.contract_id,
        updated_at = NOW()
      RETURNING id
    `;
    
    const params = [
      contract.symbol,
      contract.secType,
      contract.exchange || null,
      contract.currency || 'USD',
      contract.multiplier || null,
      contract.expiry ? new Date(contract.expiry) : null,
      contract.strike || null,
      contract.right || null,
      contract.localSymbol || null,
      contract.contractId || null
    ];
    
    const result = await dbService.query(query, params);
    return result.rows[0].id;
  }

  // Store candlestick data
  async storeCandlestickData(
    contractId: number, 
    timeframe: string, 
    bars: CandlestickBar[]
  ): Promise<{ inserted: number; updated: number; errors: number }> {
    let inserted = 0;
    let updated = 0;
    let errors = 0;

    await dbService.transaction(async (client: PoolClient) => {
      for (const bar of bars) {
        try {
          const query = `
            INSERT INTO candlestick_data (contract_id, timestamp, timeframe, open, high, low, close, volume, wap, count)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (contract_id, timestamp, timeframe)
            DO UPDATE SET 
              open = EXCLUDED.open,
              high = EXCLUDED.high,
              low = EXCLUDED.low,
              close = EXCLUDED.close,
              volume = EXCLUDED.volume,
              wap = EXCLUDED.wap,
              count = EXCLUDED.count
            RETURNING id
          `;
          
          const params = [
            contractId,
            bar.timestamp,
            timeframe,
            bar.open,
            bar.high,
            bar.low,
            bar.close,
            bar.volume,
            bar.wap || null,
            bar.count || null
          ];
          
          const result = await client.query(query, params);
          
          if (result.rowCount === 1) {
            inserted++;
          } else {
            updated++;
          }
        } catch (error) {
          console.error('Error storing candlestick data:', error);
          errors++;
        }
      }
    });

    return { inserted, updated, errors };
  }

  // Store technical indicators
  async storeTechnicalIndicators(
    contractId: number,
    timeframe: string,
    timestamp: Date,
    indicators: TechnicalIndicator[]
  ): Promise<{ inserted: number; updated: number; errors: number }> {
    let inserted = 0;
    let updated = 0;
    let errors = 0;

    // First, get the candlestick_id for this timestamp
    const candlestickQuery = `
      SELECT id FROM candlestick_data 
      WHERE contract_id = $1 AND timeframe = $2 AND timestamp = $3
    `;
    
    const candlestickResult = await dbService.query(candlestickQuery, [contractId, timeframe, timestamp]);
    
    if (candlestickResult.rows.length === 0) {
      console.warn(`No candlestick data found for contract ${contractId}, timeframe ${timeframe}, timestamp ${timestamp}`);
      return { inserted: 0, updated: 0, errors: indicators.length };
    }

    const candlestickId = candlestickResult.rows[0].id;

    await dbService.transaction(async (client: PoolClient) => {
      for (const indicator of indicators) {
        try {
          const query = `
            INSERT INTO technical_indicators (candlestick_id, contract_id, timestamp, timeframe, indicator_name, period, value, additional_data)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (contract_id, timestamp, timeframe, indicator_name, period)
            DO UPDATE SET 
              value = EXCLUDED.value,
              additional_data = EXCLUDED.additional_data
            RETURNING id
          `;
          
          const params = [
            candlestickId,
            contractId,
            timestamp,
            timeframe,
            indicator.name,
            indicator.period,
            indicator.value,
            indicator.additionalData ? JSON.stringify(indicator.additionalData) : null
          ];
          
          const result = await client.query(query, params);
          
          if (result.rowCount === 1) {
            inserted++;
          } else {
            updated++;
          }
        } catch (error) {
          console.error('Error storing technical indicator:', error);
          errors++;
        }
      }
    });

    return { inserted, updated, errors };
  }

  // Retrieve historical data from database
  async getHistoricalData(
    symbol: string,
    timeframe: string,
    startDate: Date,
    endDate: Date,
    includeIndicators: boolean = false
  ): Promise<CandlestickBar[]> {
    const query = `
      SELECT 
        cd.timestamp,
        cd.open,
        cd.high,
        cd.low,
        cd.close,
        cd.volume,
        cd.wap,
        cd.count
        ${includeIndicators ? `
        , MAX(CASE WHEN ti.indicator_name = 'SMA' AND ti.period = 20 THEN ti.value END) as sma_20
        , MAX(CASE WHEN ti.indicator_name = 'SMA' AND ti.period = 50 THEN ti.value END) as sma_50
        , MAX(CASE WHEN ti.indicator_name = 'EMA' AND ti.period = 12 THEN ti.value END) as ema_12
        , MAX(CASE WHEN ti.indicator_name = 'EMA' AND ti.period = 26 THEN ti.value END) as ema_26
        , MAX(CASE WHEN ti.indicator_name = 'RSI' AND ti.period = 14 THEN ti.value END) as rsi_14
        , MAX(CASE WHEN ti.indicator_name = 'MACD' AND ti.period = 12 THEN ti.value END) as macd
        , MAX(CASE WHEN ti.indicator_name = 'MACD_SIGNAL' AND ti.period = 26 THEN ti.value END) as macd_signal
        , MAX(CASE WHEN ti.indicator_name = 'BB_UPPER' AND ti.period = 20 THEN ti.value END) as bb_upper
        , MAX(CASE WHEN ti.indicator_name = 'BB_MIDDLE' AND ti.period = 20 THEN ti.value END) as bb_middle
        , MAX(CASE WHEN ti.indicator_name = 'BB_LOWER' AND ti.period = 20 THEN ti.value END) as bb_lower
        ` : ''}
      FROM candlestick_data cd
      JOIN contracts c ON cd.contract_id = c.id
      ${includeIndicators ? 'LEFT JOIN technical_indicators ti ON cd.id = ti.candlestick_id' : ''}
      WHERE c.symbol = $1 
        AND cd.timeframe = $2 
        AND cd.timestamp >= $3 
        AND cd.timestamp <= $4
      ${includeIndicators ? 'GROUP BY cd.id, cd.timestamp, cd.open, cd.high, cd.low, cd.close, cd.volume, cd.wap, cd.count' : ''}
      ORDER BY cd.timestamp ASC
    `;
    
    const params = [symbol, timeframe, startDate, endDate];
    const result = await dbService.query(query, params);
    
    return result.rows.map(row => ({
      timestamp: new Date(row.timestamp),
      open: parseFloat(row.open),
      high: parseFloat(row.high),
      low: parseFloat(row.low),
      close: parseFloat(row.close),
      volume: parseInt(row.volume),
      wap: row.wap ? parseFloat(row.wap) : undefined,
      count: row.count ? parseInt(row.count) : undefined,
      ...(includeIndicators && {
        sma_20: row.sma_20 ? parseFloat(row.sma_20) : undefined,
        sma_50: row.sma_50 ? parseFloat(row.sma_50) : undefined,
        ema_12: row.ema_12 ? parseFloat(row.ema_12) : undefined,
        ema_26: row.ema_26 ? parseFloat(row.ema_26) : undefined,
        rsi_14: row.rsi_14 ? parseFloat(row.rsi_14) : undefined,
        macd: row.macd ? parseFloat(row.macd) : undefined,
        macd_signal: row.macd_signal ? parseFloat(row.macd_signal) : undefined,
        bb_upper: row.bb_upper ? parseFloat(row.bb_upper) : undefined,
        bb_middle: row.bb_middle ? parseFloat(row.bb_middle) : undefined,
        bb_lower: row.bb_lower ? parseFloat(row.bb_lower) : undefined,
      })
    }));
  }

  // Get latest data for a symbol
  async getLatestData(symbol: string, timeframe: string, limit: number = 100): Promise<CandlestickBar[]> {
    const query = `
      SELECT 
        cd.timestamp,
        cd.open,
        cd.high,
        cd.low,
        cd.close,
        cd.volume,
        cd.wap,
        cd.count
      FROM candlestick_data cd
      JOIN contracts c ON cd.contract_id = c.id
      WHERE c.symbol = $1 AND cd.timeframe = $2
      ORDER BY cd.timestamp DESC
      LIMIT $3
    `;
    
    const params = [symbol, timeframe, limit];
    const result = await dbService.query(query, params);
    
    return result.rows.reverse().map(row => ({
      timestamp: new Date(row.timestamp),
      open: parseFloat(row.open),
      high: parseFloat(row.high),
      low: parseFloat(row.low),
      close: parseFloat(row.close),
      volume: parseInt(row.volume),
      wap: row.wap ? parseFloat(row.wap) : undefined,
      count: row.count ? parseInt(row.count) : undefined,
    }));
  }

  // Start a data collection session
  async startDataCollectionSession(contractId: number, timeframe: string): Promise<number> {
    const query = `
      INSERT INTO data_collection_sessions (contract_id, timeframe, start_time, status)
      VALUES ($1, $2, NOW(), 'active')
      RETURNING id
    `;
    
    const result = await dbService.query(query, [contractId, timeframe]);
    return result.rows[0].id;
  }

  // End a data collection session
  async endDataCollectionSession(sessionId: number, status: string, recordsCollected: number, errorMessage?: string): Promise<void> {
    const query = `
      UPDATE data_collection_sessions 
      SET end_time = NOW(), status = $2, records_collected = $3, error_message = $4
      WHERE id = $1
    `;
    
    await dbService.query(query, [sessionId, status, recordsCollected, errorMessage]);
  }

  // Update data quality metrics
  async updateDataQualityMetrics(
    contractId: number,
    timeframe: string,
    date: Date,
    totalBars: number,
    missingBars: number,
    duplicateBars: number,
    invalidBars: number
  ): Promise<void> {
    const qualityScore = totalBars > 0 ? (totalBars - missingBars - duplicateBars - invalidBars) / totalBars : 0;
    
    const query = `
      INSERT INTO data_quality_metrics (contract_id, timeframe, date, total_bars, missing_bars, duplicate_bars, invalid_bars, data_quality_score)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (contract_id, timeframe, date)
      DO UPDATE SET 
        total_bars = EXCLUDED.total_bars,
        missing_bars = EXCLUDED.missing_bars,
        duplicate_bars = EXCLUDED.duplicate_bars,
        invalid_bars = EXCLUDED.invalid_bars,
        data_quality_score = EXCLUDED.data_quality_score,
        last_updated = NOW()
    `;
    
    await dbService.query(query, [
      contractId, timeframe, date, totalBars, missingBars, duplicateBars, invalidBars, qualityScore
    ]);
  }

  // Get data collection statistics
  async getDataCollectionStats(symbol?: string): Promise<any> {
    let query = `
      SELECT 
        c.symbol,
        cd.timeframe,
        COUNT(cd.id) as total_bars,
        MIN(cd.timestamp) as earliest_data,
        MAX(cd.timestamp) as latest_data,
        AVG(dqm.data_quality_score) as avg_quality_score
      FROM contracts c
      LEFT JOIN candlestick_data cd ON c.id = cd.contract_id
      LEFT JOIN data_quality_metrics dqm ON c.id = dqm.contract_id AND cd.timeframe = dqm.timeframe
    `;
    
    const params: any[] = [];
    
    if (symbol) {
      query += ' WHERE c.symbol = $1';
      params.push(symbol);
    }
    
    query += ' GROUP BY c.symbol, cd.timeframe ORDER BY c.symbol, cd.timeframe';
    
    const result = await dbService.query(query, params);
    return result.rows;
  }

  // Clean old data based on retention policy
  async cleanOldData(): Promise<{ deleted: number }> {
    const query = 'SELECT clean_old_data()';
    await dbService.query(query);
    
    // Get count of deleted records (this would need to be implemented in the function)
    return { deleted: 0 };
  }
}

// Export singleton instance
export const marketDataService = new MarketDataService();
export default marketDataService;
