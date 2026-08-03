import type { Currency, Exchange, SecurityType, Timeframe } from './types';

export const SECURITY_TYPES: SecurityType[] = [
  { value: 'STK', label: 'Stocks', description: 'Stocks and ETFs' },
  { value: 'OPT', label: 'Options', description: 'Stock and Index Options' },
  { value: 'FUT', label: 'Futures', description: 'Futures Contracts' },
  { value: 'CASH', label: 'Forex', description: 'Currency Pairs' },
  { value: 'BOND', label: 'Bonds', description: 'Fixed Income' },
  { value: 'CFD', label: 'CFDs', description: 'Contracts for Difference' },
  { value: 'CMDTY', label: 'Commodities', description: 'Commodity Contracts' },
  { value: 'CRYPTO', label: 'Crypto', description: 'Cryptocurrencies' },
  { value: 'WAR', label: 'Warrants', description: 'Stock Warrants' },
  { value: 'FUND', label: 'Funds', description: 'Mutual Funds' },
  { value: 'IND', label: 'Indices', description: 'Market Indices' },
  { value: 'BAG', label: 'Baskets', description: 'Basket Products' },
];

export const EXCHANGES: Exchange[] = [
  { value: 'SMART', label: 'SMART (Best Execution)' },
  { value: 'NYSE', label: 'New York Stock Exchange' },
  { value: 'NASDAQ', label: 'NASDAQ' },
  { value: 'AMEX', label: 'American Stock Exchange' },
  { value: 'EUREX', label: 'Eurex' },
  { value: 'LSE', label: 'London Stock Exchange' },
  { value: 'TSE', label: 'Tokyo Stock Exchange' },
  { value: 'IDEALPRO', label: 'Forex (IDEALPRO)' },
  { value: 'CME', label: 'Chicago Mercantile Exchange' },
  { value: 'CBOE', label: 'Chicago Board Options Exchange' },
];

export const CURRENCIES: Currency[] = [
  { value: 'USD', label: 'US Dollar' },
  { value: 'EUR', label: 'Euro' },
  { value: 'GBP', label: 'British Pound' },
  { value: 'JPY', label: 'Japanese Yen' },
  { value: 'CAD', label: 'Canadian Dollar' },
  { value: 'AUD', label: 'Australian Dollar' },
  { value: 'CHF', label: 'Swiss Franc' },
  { value: 'HKD', label: 'Hong Kong Dollar' },
];

export const TIMEFRAMES: Timeframe[] = [
  { value: 'tick', label: 'Tick', minutes: 0 },
  { value: '1min', label: '1m', minutes: 1 },
  { value: '5min', label: '5m', minutes: 5 },
  { value: '15min', label: '15m', minutes: 15 },
  { value: '30min', label: '30m', minutes: 30 },
  { value: '1hour', label: '1h', minutes: 60 },
  { value: '4hour', label: '4h', minutes: 240 },
  { value: '8hour', label: '8h', minutes: 480 },
  { value: '1day', label: '1d', minutes: 1440 },
];

export const POPULAR_SYMBOLS = [
  { symbol: 'AAPL', name: 'Apple Inc.' },
  { symbol: 'MSFT', name: 'Microsoft Corporation' },
  { symbol: 'GOOGL', name: 'Alphabet Inc.' },
  { symbol: 'AMZN', name: 'Amazon.com Inc.' },
  { symbol: 'TSLA', name: 'Tesla Inc.' },
  { symbol: 'NVDA', name: 'NVIDIA Corporation' },
  { symbol: 'META', name: 'Meta Platforms Inc.' },
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF' },
  { symbol: 'QQQ', name: 'Invesco QQQ Trust' },
  { symbol: 'IWM', name: 'iShares Russell 2000 ETF' },
];
