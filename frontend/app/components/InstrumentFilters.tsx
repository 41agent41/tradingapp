'use client';

/**
 * Choose what to fetch history for: a broker connection, then a symbol from
 * that connection's own list (the same SymbolPicker as the live chart), with
 * the security type, currency and exchange the broker needs for it.
 *
 * Picking a listed symbol fills in its type, currency and exchange; they can
 * still be changed by hand for a symbol the list does not have.
 */
import React, { useEffect, useState } from 'react';

import SymbolPicker from './SymbolPicker';
import { apiFetch } from '../lib/api';
import { findConnection, platformName, type LiveConnection } from '../lib/brokerConnections';

export interface Instrument {
  /** Platform; empty for the broker priority's first. */
  source: string;
  /** Account on it; empty for its default. */
  account: string;
  symbol: string;
  secType: string;
  currency: string;
  exchange: string;
}

export const DEFAULT_INSTRUMENT: Instrument = {
  source: '',
  account: '',
  symbol: 'MSFT',
  secType: 'STK',
  currency: 'USD',
  exchange: 'SMART',
};

const SEC_TYPES = [
  { value: 'STK', label: 'Stock' },
  { value: 'ETF', label: 'ETF' },
  { value: 'CASH', label: 'FX' },
  { value: 'CFD', label: 'CFD' },
  { value: 'FUT', label: 'Future' },
  { value: 'OPT', label: 'Option' },
  { value: 'BOND', label: 'Bond' },
  { value: 'CRYPTO', label: 'Crypto' },
];

/** The types to offer, with the one a listed symbol set even if it is not among them. */
function withCurrent(secType?: string) {
  return !secType || SEC_TYPES.some((t) => t.value === secType)
    ? SEC_TYPES
    : [...SEC_TYPES, { value: secType, label: secType }];
}

/** The query parameters for /api/market-data/history that name the instrument. */
export function instrumentParams(instrument: Instrument): Record<string, string> {
  const params: Record<string, string> = {
    symbol: instrument.symbol.trim(),
    secType: instrument.secType,
  };
  if (instrument.exchange.trim()) params.exchange = instrument.exchange.trim();
  if (instrument.currency.trim()) params.currency = instrument.currency.trim().toUpperCase();
  if (instrument.source) params.source = instrument.source;
  if (instrument.account) params.account = instrument.account;
  return params;
}

const INPUT =
  'w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed';

interface Props {
  value: Instrument;
  onChange: (next: Instrument) => void;
  disabled?: boolean;
}

export default function InstrumentFilters({ value, onChange, disabled = false }: Props) {
  const [connections, setConnections] = useState<LiveConnection[]>([]);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/brokers/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!cancelled && Array.isArray(body?.connections)) setConnections(body.connections);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const connection = value.source ? `${value.source}:${value.account}` : '';
  const accountMode =
    findConnection(connections, value.source, value.account)?.account_mode === 'live'
      ? 'live'
      : 'paper';

  return (
    <div className="grid grid-cols-2 gap-3" data-testid="instrument-filters">
      <label className="col-span-2 text-sm text-gray-700">
        Connection
        <select
          className={INPUT}
          value={connection}
          disabled={disabled}
          onChange={(e) => {
            const [source = '', account = ''] = e.target.value.split(':');
            onChange({ ...value, source, account });
          }}
        >
          <option value="">By broker priority</option>
          {connections.map((c) => (
            <option key={c.label} value={`${c.platform}:${c.account}`}>
              {platformName(c.platform)} {c.account}
              {c.account_mode ? ` (${c.account_mode})` : ''}
            </option>
          ))}
        </select>
      </label>
      <SymbolPicker
        source={value.source}
        account={value.account}
        accountMode={accountMode}
        symbol={value.symbol}
        disabled={disabled}
        inputClassName={INPUT}
        onChange={(choice) =>
          onChange({
            ...value,
            symbol: choice.symbol,
            ...(choice.secType
              ? {
                  secType: choice.secType,
                  currency: choice.currency ?? '',
                  exchange: choice.exchange ?? '',
                }
              : {}),
          })
        }
      />
      <label className="text-sm text-gray-700">
        Type
        <select
          className={INPUT}
          value={value.secType}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, secType: e.target.value })}
        >
          {withCurrent(value.secType).map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm text-gray-700">
        Currency
        <input
          className={INPUT}
          value={value.currency}
          disabled={disabled}
          placeholder="USD"
          onChange={(e) => onChange({ ...value, currency: e.target.value.toUpperCase() })}
        />
      </label>
      <label className="col-span-2 text-sm text-gray-700">
        Exchange
        <input
          className={INPUT}
          value={value.exchange}
          disabled={disabled}
          placeholder="SMART"
          onChange={(e) => onChange({ ...value, exchange: e.target.value.toUpperCase() })}
        />
      </label>
    </div>
  );
}
