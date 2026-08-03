export interface SecurityType {
  value: string;
  label: string;
  description: string;
}

export interface Exchange {
  value: string;
  label: string;
}

export interface Currency {
  value: string;
  label: string;
}

export interface Timeframe {
  value: string;
  label: string;
  minutes: number;
}

export interface ContractResult {
  conid: string;
  symbol: string;
  companyName: string;
  description: string;
  secType: string;
  currency?: string;
  exchange?: string;
  primaryExchange?: string;
  localSymbol?: string;
  tradingClass?: string;
  multiplier?: string;
  strike?: string;
  right?: string;
  expiry?: string;
  includeExpired?: boolean;
  comboLegsDescrip?: string;
  contractMonth?: string;
  industry?: string;
  category?: string;
  subcategory?: string;
  timeZoneId?: string;
  tradingHours?: string;
  liquidHours?: string;
  evRule?: string;
  evMultiplier?: string;
  secIdList?: any[];
  aggGroup?: string;
  underSymbol?: string;
  underSecType?: string;
  marketRuleIds?: string;
  realExpirationDate?: string;
  lastTradingDay?: string;
  stockType?: string;
  minSize?: string;
  sizeIncrement?: string;
  suggestedSizeIncrement?: string;
  sections?: any[];
}

export interface MarketData {
  symbol: string;
  last?: number;
  bid?: number;
  ask?: number;
  volume?: number;
  change?: number;
  changePercent?: number;
}
