/**
 * The time zone a chart's axis and crosshair are shown in (E-23): UTC, the
 * instrument's exchange, or the browser's own.
 *
 * Bars keep their UTC times; only the labels change. Daily bars are dated,
 * not timed, so a chart of them stays in UTC whatever is chosen.
 */

export type ChartZone = 'utc' | 'exchange' | 'local';

export const CHART_ZONES: Array<{ value: ChartZone; label: string }> = [
  { value: 'utc', label: 'UTC' },
  { value: 'exchange', label: 'Exchange' },
  { value: 'local', label: 'Local' },
];

export function isChartZone(value: string): value is ChartZone {
  return value === 'utc' || value === 'exchange' || value === 'local';
}

/** What `<Chart timeZone>` takes: an IANA zone, or `local` for the browser's. */
export const LOCAL_ZONE = 'local';

const NEW_YORK = 'America/New_York';

const EXCHANGE_ZONES: Record<string, string> = {
  NYSE: NEW_YORK,
  NASDAQ: NEW_YORK,
  ARCA: NEW_YORK,
  AMEX: NEW_YORK,
  BATS: NEW_YORK,
  IEX: NEW_YORK,
  ISLAND: NEW_YORK,
  SMART: NEW_YORK,
  CME: 'America/Chicago',
  CBOT: 'America/Chicago',
  GLOBEX: 'America/Chicago',
  NYMEX: NEW_YORK,
  COMEX: NEW_YORK,
  TSE: 'America/Toronto',
  LSE: 'Europe/London',
  IBIS: 'Europe/Berlin',
  XETRA: 'Europe/Berlin',
  FWB: 'Europe/Berlin',
  EUREX: 'Europe/Berlin',
  SBF: 'Europe/Paris',
  AEB: 'Europe/Amsterdam',
  EBS: 'Europe/Zurich',
  ASX: 'Australia/Sydney',
  SNFE: 'Australia/Sydney',
  TSEJ: 'Asia/Tokyo',
  OSE: 'Asia/Tokyo',
  SEHK: 'Asia/Hong_Kong',
  HKFE: 'Asia/Hong_Kong',
  SGX: 'Asia/Singapore',
};

const CURRENCY_ZONES: Record<string, string> = {
  USD: NEW_YORK,
  CAD: 'America/Toronto',
  GBP: 'Europe/London',
  EUR: 'Europe/Berlin',
  CHF: 'Europe/Zurich',
  AUD: 'Australia/Sydney',
  JPY: 'Asia/Tokyo',
  HKD: 'Asia/Hong_Kong',
  SGD: 'Asia/Singapore',
};

/**
 * The zone an instrument trades in. A named exchange decides. FX, CFDs and
 * crypto have no one exchange, so they use New York, where the FX trading
 * day ends at 17:00. Otherwise a stock's currency decides, then New York.
 */
export function exchangeTimeZone(instrument: {
  secType?: string;
  exchange?: string;
  currency?: string;
}): string {
  const exchange = (instrument.exchange ?? '').toUpperCase();
  if (EXCHANGE_ZONES[exchange] && exchange !== 'SMART') return EXCHANGE_ZONES[exchange];
  const secType = (instrument.secType ?? 'STK').toUpperCase();
  if (secType === 'CASH' || secType === 'CFD' || secType === 'CRYPTO') return NEW_YORK;
  return CURRENCY_ZONES[(instrument.currency ?? '').toUpperCase()] ?? NEW_YORK;
}

/** The zone to give `<Chart>` for a choice, an instrument and a timeframe. */
export function chartTimeZone(
  zone: ChartZone,
  instrument: { secType?: string; exchange?: string; currency?: string },
  timeframe: string
): string {
  if (zone === 'utc' || timeframe === '1day') return 'UTC';
  return zone === 'local' ? LOCAL_ZONE : exchangeTimeZone(instrument);
}

type Parts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function parts(seconds: number, timeZone: string): Parts {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      ...(timeZone === LOCAL_ZONE ? {} : { timeZone }),
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  const out: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(seconds * 1000))) out[part.type] = part.value;
  return out as Parts;
}

/** The crosshair's time label: `11 Nov 2026 07:00`. */
export function formatChartTime(seconds: number, timeZone: string): string {
  const p = parts(seconds, timeZone);
  return `${p.day} ${p.month} ${p.year} ${p.hour}:${p.minute}`;
}

/** lightweight-charts' TickMarkType. */
const YEAR = 0;
const MONTH = 1;
const DAY = 2;
const TIME_WITH_SECONDS = 4;

/**
 * One label on the time axis. The library places its year, month and day
 * marks at UTC midnights, which in another zone fall mid-day. So a mark shows
 * the date only where the zone's own day starts, and the time elsewhere.
 */
export function formatTick(seconds: number, tickMarkType: number, timeZone: string): string {
  const p = parts(seconds, timeZone);
  const midnight = p.hour === '00' && p.minute === '00' && p.second === '00';
  if (!midnight) {
    return tickMarkType === TIME_WITH_SECONDS
      ? `${p.hour}:${p.minute}:${p.second}`
      : `${p.hour}:${p.minute}`;
  }
  if (tickMarkType === YEAR || (p.day === '1' && p.month === 'Jan')) return p.year;
  if (tickMarkType === MONTH || p.day === '1') return p.month;
  return tickMarkType === DAY ? p.day : `${p.day} ${p.month}`;
}
