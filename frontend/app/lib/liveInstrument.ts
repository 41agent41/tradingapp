/** The live chart's instrument, read from and written to the page address. */
import type { LiveInstrument } from '../components/LiveChart';

/** The instrument named in the address, so a chart can be bookmarked or linked. */
export function instrumentFromParams(params: URLSearchParams): LiveInstrument {
  const symbol = (params.get('symbol') ?? 'MSFT').trim().toUpperCase() || 'MSFT';
  return {
    symbol,
    source: params.get('source') ?? '',
    account: params.get('account') ?? '',
    secType: params.get('secType') ?? 'STK',
    exchange: params.get('exchange') ?? '',
    currency: params.get('currency') ?? '',
  };
}

export function paramsFromInstrument(i: LiveInstrument): string {
  const params = new URLSearchParams({ symbol: i.symbol });
  for (const key of ['source', 'account', 'secType', 'exchange', 'currency'] as const) {
    const value = i[key];
    if (value && !(key === 'secType' && value === 'STK')) params.set(key, value);
  }
  return params.toString();
}
