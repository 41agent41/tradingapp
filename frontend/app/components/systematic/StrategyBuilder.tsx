'use client';

import React, { useState } from 'react';
import { apiFetch } from '../../lib/api';
import {
  OPERATORS,
  OPERAND_SUGGESTIONS,
  SIZING_TYPES,
  TIMEFRAMES,
  buildDefinitionPayload,
  type ConditionForm,
  type Operator,
  type SizingType,
  type StrategyForm,
} from '../../lib/ruleSet';

/**
 * Rule builder (A5 / Phase 4). A form over the A1 rule schema — entry/exit
 * conditions (left · operator · right), sizing and per-run risk — that POSTs a
 * declarative definition to `/api/strategies/definitions`. Serialization lives
 * in `lib/ruleSet.ts` so it stays unit-tested; this component is just the form.
 */

const emptyCondition = (): ConditionForm => ({ left: 'sma_20', op: '>', right: 'sma_50' });

const BROKERS = ['ib', 'mt5', 'alpaca', 'oanda'];

const initialForm: StrategyForm = {
  name: '',
  symbol: 'MSFT',
  timeframe: '5min',
  broker: 'ib',
  secType: 'STK',
  exchange: 'SMART',
  currency: 'USD',
  indicators: 'sma_20, sma_50',
  entry: [{ left: 'sma_20', op: 'crosses_above', right: 'sma_50' }],
  exit: [{ left: 'sma_20', op: 'crosses_below', right: 'sma_50' }],
  sizingType: 'fixed',
  sizingSize: '100',
  maxOrdersPerDay: '4',
  stopLossPct: '',
};

export interface StrategyBuilderProps {
  onCreated?: (definition: { id: number; name: string }) => void;
}

export default function StrategyBuilder({ onCreated }: StrategyBuilderProps) {
  const [form, setForm] = useState<StrategyForm>(initialForm);
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const set = <K extends keyof StrategyForm>(key: K, value: StrategyForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const setCondition = (kind: 'entry' | 'exit', idx: number, patch: Partial<ConditionForm>) =>
    setForm((f) => {
      const rows = f[kind].slice();
      rows[idx] = { ...rows[idx], ...patch };
      return { ...f, [kind]: rows };
    });

  const addCondition = (kind: 'entry' | 'exit') =>
    setForm((f) => ({ ...f, [kind]: [...f[kind], emptyCondition()] }));

  const removeCondition = (kind: 'entry' | 'exit', idx: number) =>
    setForm((f) => ({ ...f, [kind]: f[kind].filter((_, i) => i !== idx) }));

  const submit = async () => {
    const built = buildDefinitionPayload(form);
    if (!built.ok || !built.payload) {
      setErrors(built.errors);
      return;
    }
    setErrors([]);
    setSubmitting(true);
    setNotice(null);
    try {
      const res = await apiFetch('/api/strategies/definitions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(built.payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail || body.error || `HTTP ${res.status}`);
      setNotice(`Created definition #${body.id} — “${body.name}”`);
      onCreated?.({ id: body.id, name: body.name });
    } catch (e) {
      setErrors([e instanceof Error ? e.message : 'Failed to create definition']);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-white p-6 rounded-lg shadow">
      <h2 className="text-lg font-semibold mb-4">Rule Builder</h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Name</span>
          <input
            type="text"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="MA crossover"
            className="mt-1 w-full border border-gray-300 rounded px-3 py-2"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Symbol</span>
          <input
            type="text"
            value={form.symbol}
            onChange={(e) => set('symbol', e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded px-3 py-2 uppercase"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Timeframe</span>
          <select
            value={form.timeframe}
            onChange={(e) => set('timeframe', e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded px-3 py-2 bg-white"
          >
            {TIMEFRAMES.map((tf) => (
              <option key={tf} value={tf}>
                {tf}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Indicators (CSV)</span>
          <input
            type="text"
            value={form.indicators}
            onChange={(e) => set('indicators', e.target.value)}
            placeholder="sma_20, sma_50, rsi"
            className="mt-1 w-full border border-gray-300 rounded px-3 py-2"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Broker</span>
          <select
            value={form.broker}
            onChange={(e) => set('broker', e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded px-3 py-2 bg-white"
          >
            {BROKERS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Security type</span>
          <input
            type="text"
            value={form.secType ?? 'STK'}
            onChange={(e) => set('secType', e.target.value)}
            placeholder="STK / FUT / CASH…"
            className="mt-1 w-full border border-gray-300 rounded px-3 py-2 uppercase"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Exchange</span>
          <input
            type="text"
            value={form.exchange ?? 'SMART'}
            onChange={(e) => set('exchange', e.target.value)}
            placeholder="SMART"
            className="mt-1 w-full border border-gray-300 rounded px-3 py-2 uppercase"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Currency</span>
          <input
            type="text"
            value={form.currency ?? 'USD'}
            onChange={(e) => set('currency', e.target.value)}
            placeholder="USD"
            className="mt-1 w-full border border-gray-300 rounded px-3 py-2 uppercase"
          />
        </label>
      </div>

      <ConditionGroup
        title="Entry (all must hold)"
        rows={form.entry}
        onChange={(i, patch) => setCondition('entry', i, patch)}
        onAdd={() => addCondition('entry')}
        onRemove={(i) => removeCondition('entry', i)}
      />
      <ConditionGroup
        title="Exit (any triggers)"
        rows={form.exit}
        onChange={(i, patch) => setCondition('exit', i, patch)}
        onAdd={() => addCondition('exit')}
        onRemove={(i) => removeCondition('exit', i)}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-5">
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Sizing type</span>
          <select
            value={form.sizingType}
            onChange={(e) => set('sizingType', e.target.value as SizingType)}
            className="mt-1 w-full border border-gray-300 rounded px-3 py-2 bg-white"
          >
            {SIZING_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">
            Size{' '}
            <span className="text-gray-400">
              (
              {form.sizingType === 'fixed'
                ? 'shares'
                : form.sizingType === 'notional'
                  ? '$ notional'
                  : '% equity'}
              )
            </span>
          </span>
          <input
            type="number"
            min="0"
            step="1"
            value={form.sizingSize}
            onChange={(e) => set('sizingSize', e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded px-3 py-2"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Max orders / day</span>
          <input
            type="number"
            min="0"
            step="1"
            value={form.maxOrdersPerDay}
            onChange={(e) => set('maxOrdersPerDay', e.target.value)}
            placeholder="0 = unlimited"
            className="mt-1 w-full border border-gray-300 rounded px-3 py-2"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Stop loss % (optional)</span>
          <input
            type="number"
            min="0"
            step="0.1"
            value={form.stopLossPct}
            onChange={(e) => set('stopLossPct', e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded px-3 py-2"
          />
        </label>
      </div>

      {errors.length > 0 && (
        <ul className="mt-4 text-sm text-red-700 bg-red-50 p-3 rounded border border-red-200 list-disc pl-5">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {notice && (
        <div className="mt-4 text-sm text-green-700 bg-green-50 p-3 rounded border border-green-200">
          {notice}
        </div>
      )}

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          className="px-5 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400"
        >
          {submitting ? 'Saving…' : 'Create definition'}
        </button>
        <a href="/backtest" className="text-sm text-blue-600 hover:text-blue-800">
          Backtest a strategy →
        </a>
      </div>
    </div>
  );
}

function ConditionGroup({
  title,
  rows,
  onChange,
  onAdd,
  onRemove,
}: {
  title: string;
  rows: ConditionForm[];
  onChange: (idx: number, patch: Partial<ConditionForm>) => void;
  onAdd: () => void;
  onRemove: (idx: number) => void;
}) {
  return (
    <div className="mt-5">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
        <button type="button" onClick={onAdd} className="text-xs text-blue-600 hover:text-blue-800">
          + Add condition
        </button>
      </div>
      {rows.length === 0 && <p className="text-xs text-gray-500">No conditions.</p>}
      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <input
              list="operand-suggestions"
              value={row.left}
              onChange={(e) => onChange(i, { left: e.target.value })}
              className="border border-gray-300 rounded px-2 py-1.5 text-sm w-40"
              placeholder="left"
              aria-label={`${title} condition ${i + 1} left`}
            />
            <select
              value={row.op}
              onChange={(e) => onChange(i, { op: e.target.value as Operator })}
              className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
              aria-label={`${title} condition ${i + 1} operator`}
            >
              {OPERATORS.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
            <input
              list="operand-suggestions"
              value={row.right}
              onChange={(e) => onChange(i, { right: e.target.value })}
              className="border border-gray-300 rounded px-2 py-1.5 text-sm w-40"
              placeholder="right (operand or number)"
              aria-label={`${title} condition ${i + 1} right`}
            />
            <button
              type="button"
              onClick={() => onRemove(i)}
              className="text-xs text-red-600 hover:text-red-800"
              aria-label={`Remove ${title} condition ${i + 1}`}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <datalist id="operand-suggestions">
        {OPERAND_SUGGESTIONS.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
  );
}
