'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';

import BackToHome from '../components/BackToHome';
import BrokerConnections from '../components/BrokerConnections';
import { apiFetch } from '../lib/api';
import {
  type AuditEntry,
  type SettingView,
  type SettingsPayload,
  applyLabel,
  displayValue,
  groupBySection,
  readOnlyReason,
  sourceLabel,
  stepUpHeaders,
} from '../lib/settings';

const HISTORY_TAB = 'history';
const CONNECTIONS_TAB = 'connections';

const SOURCE_STYLES: Record<string, string> = {
  environment: 'bg-amber-100 text-amber-800',
  database: 'bg-blue-100 text-blue-800',
  default: 'bg-gray-100 text-gray-700',
  unset: 'bg-gray-100 text-gray-500',
};

function SettingEditor({
  setting,
  onSave,
  onReset,
  busy,
}: {
  setting: SettingView;
  onSave: (value: string) => void;
  onReset: () => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState(setting.secret ? '' : (setting.value ?? ''));
  useEffect(() => {
    setDraft(setting.secret ? '' : (setting.value ?? ''));
  }, [setting.value, setting.secret]);

  const inputClass =
    'w-full sm:w-56 px-2 py-1 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500';

  let input: React.ReactNode;
  if (setting.type === 'boolean' || setting.type === 'enum') {
    const options = setting.type === 'boolean' ? ['true', 'false'] : (setting.options ?? []);
    input = (
      <select
        aria-label={setting.label}
        className={inputClass}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o === '' ? '(none)' : o}
          </option>
        ))}
      </select>
    );
  } else {
    input = (
      <input
        aria-label={setting.label}
        className={inputClass}
        type={setting.secret ? 'password' : 'text'}
        inputMode={
          setting.type === 'integer' || setting.type === 'number'
            ? 'decimal'
            : setting.type === 'url'
              ? 'url'
              : undefined
        }
        placeholder={setting.secret ? 'New value' : (setting.default ?? '')}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
    );
  }

  const unchanged = !setting.secret && draft === (setting.value ?? '');
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2">
      {input}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || unchanged || draft.trim() === ''}
          onClick={() => onSave(draft)}
          className="px-3 py-1 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-40"
        >
          Save
        </button>
        {setting.source === 'database' && (
          <button
            type="button"
            disabled={busy}
            onClick={onReset}
            className="px-3 py-1 text-sm text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-40"
          >
            Reset to default
          </button>
        )}
      </div>
    </div>
  );
}

function SettingRow({
  setting,
  onSave,
  onReset,
  busy,
}: {
  setting: SettingView;
  onSave: (value: string) => void;
  onReset: () => void;
  busy: boolean;
}) {
  const reason = readOnlyReason(setting);
  return (
    <li className="py-4 flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
      <div className="min-w-0 lg:max-w-xl">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-gray-900">{setting.label}</span>
          <span
            className={`px-2 py-0.5 text-xs rounded-full ${SOURCE_STYLES[setting.source] ?? ''}`}
          >
            {sourceLabel(setting)}
          </span>
          {setting.step_up && (
            <span className="px-2 py-0.5 text-xs rounded-full bg-red-50 text-red-700">
              Protected
            </span>
          )}
        </div>
        <p className="text-xs font-mono text-gray-500 mt-1">{setting.key}</p>
        <p className="text-sm text-gray-600 mt-1">{setting.help}</p>
        <p className="text-xs text-gray-500 mt-1">
          {applyLabel(setting.apply)}
          {setting.updated_at &&
            ` · changed ${new Date(setting.updated_at).toLocaleString()}${
              setting.updated_by ? ` by ${setting.updated_by}` : ''
            }`}
        </p>
      </div>
      <div className="lg:text-right shrink-0">
        {reason ? (
          <>
            <p className="text-sm font-mono text-gray-900 break-all">{displayValue(setting)}</p>
            <p className="text-xs text-gray-500 mt-1 lg:max-w-xs">{reason}</p>
          </>
        ) : (
          <SettingEditor setting={setting} onSave={onSave} onReset={onReset} busy={busy} />
        )}
      </div>
    </li>
  );
}

function History() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch('/api/settings/audit?limit=200')
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
        setEntries(body.entries);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <p className="text-sm text-red-700">{error}</p>;
  if (!entries) return <p className="text-sm text-gray-500">Loading…</p>;
  if (entries.length === 0) {
    return <p className="text-sm text-gray-500">No settings have been changed here yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 border-b">
            <th className="py-2 pr-4 font-medium">When</th>
            <th className="py-2 pr-4 font-medium">Setting</th>
            <th className="py-2 pr-4 font-medium">Change</th>
            <th className="py-2 pr-4 font-medium">By</th>
            <th className="py-2 font-medium">Reason</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className="border-b last:border-0 align-top">
              <td className="py-2 pr-4 whitespace-nowrap text-gray-600">
                {new Date(e.changed_at).toLocaleString()}
              </td>
              <td className="py-2 pr-4 font-mono text-xs">{e.key}</td>
              <td className="py-2 pr-4 font-mono text-xs break-all">
                {e.action === 'clear'
                  ? 'reset to default'
                  : `${e.old_value ?? '(unset)'} → ${e.new_value}`}
              </td>
              <td className="py-2 pr-4 text-gray-600">{e.changed_by ?? ''}</td>
              <td className="py-2 text-gray-600">{e.reason ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function SettingsPage() {
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<string>('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [tradingToken, setTradingToken] = useState('');
  const [mfaCode, setMfaCode] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await apiFetch('/api/settings');
      const body = await r.json();
      if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
      setPayload(body);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => (payload ? groupBySection(payload) : []), [payload]);
  const activeTab = tab || groups[0]?.id || HISTORY_TAB;
  const active = groups.find((g) => g.id === activeTab);
  // Broker priority is set with the arrows on the Connections tab.
  const envConnectionSettings =
    groups
      .find((g) => g.id === CONNECTIONS_TAB)
      ?.settings.filter((s) => s.key !== 'BROKER_PRIORITY') ?? [];
  const needsStepUp =
    !!payload &&
    !!active?.settings.some((s) => s.step_up && !readOnlyReason(s)) &&
    (payload.auth.trading_auth_required || payload.auth.mfa_required);

  const write = async (setting: SettingView, method: 'PUT' | 'DELETE', value?: string) => {
    if (!payload) return;
    setBusyKey(setting.key);
    setMessage(null);
    try {
      const r = await apiFetch(`/api/settings/${encodeURIComponent(setting.key)}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...stepUpHeaders(setting, payload.auth, tradingToken, mfaCode),
        },
        body: JSON.stringify(method === 'PUT' ? { value } : {}),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || body?.detail || `HTTP ${r.status}`);
      setMessage({
        kind: 'ok',
        text: method === 'PUT' ? `${setting.label} saved.` : `${setting.label} reset to default.`,
      });
      if (setting.step_up) setMfaCode('');
      await load();
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center space-x-4 py-4 sm:py-6">
            <BackToHome />
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Settings</h1>
              <p className="text-xs sm:text-sm text-gray-600 mt-1">
                Values set in .env take precedence and are shown locked
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-4">
        {loadError && (
          <div className="p-3 text-sm text-red-800 bg-red-50 border border-red-200 rounded-md">
            Settings could not be loaded: {loadError}
          </div>
        )}
        {payload?.status.error && (
          <div className="p-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md">
            The settings store could not be read ({payload.status.error}). Values from .env and
            defaults still apply.
          </div>
        )}
        {message && (
          <div
            role="status"
            className={`p-3 text-sm rounded-md border ${
              message.kind === 'ok'
                ? 'text-green-800 bg-green-50 border-green-200'
                : 'text-red-800 bg-red-50 border-red-200'
            }`}
          >
            {message.text}
          </div>
        )}

        {payload && (
          <>
            <nav className="flex flex-wrap gap-2" aria-label="Settings sections">
              {[
                { id: CONNECTIONS_TAB, title: 'Connections' },
                // The registry's own connections section is shown inside the
                // Connections tab, below the brokers.
                ...groups.filter((g) => g.id !== CONNECTIONS_TAB),
                { id: HISTORY_TAB, title: 'History' },
              ].map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setTab(g.id)}
                  className={`px-3 py-1.5 text-sm rounded-md border ${
                    g.id === activeTab
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  {g.title}
                </button>
              ))}
            </nav>

            <section className="bg-white rounded-lg shadow-sm border p-4 sm:p-6">
              {activeTab === CONNECTIONS_TAB ? (
                <>
                  <BrokerConnections />
                  {envConnectionSettings.length > 0 && (
                    <details className="mt-6">
                      <summary className="cursor-pointer text-sm font-medium text-gray-700">
                        Connection settings from .env
                      </summary>
                      <ul className="divide-y">
                        {envConnectionSettings.map((s) => (
                          <SettingRow
                            key={s.key}
                            setting={s}
                            busy={busyKey === s.key}
                            onSave={(value) => void write(s, 'PUT', value)}
                            onReset={() => void write(s, 'DELETE')}
                          />
                        ))}
                      </ul>
                    </details>
                  )}
                </>
              ) : activeTab === HISTORY_TAB ? (
                <History />
              ) : (
                <>
                  {needsStepUp && (
                    <div className="mb-4 p-3 bg-gray-50 border rounded-md">
                      <p className="text-sm text-gray-700 mb-2">
                        Protected settings need the same credentials as placing an order.
                      </p>
                      <div className="flex flex-col sm:flex-row gap-2">
                        {payload.auth.trading_auth_required && (
                          <input
                            type="password"
                            aria-label="Trading token"
                            placeholder="Trading token"
                            value={tradingToken}
                            onChange={(e) => setTradingToken(e.target.value)}
                            className="px-2 py-1 text-sm border border-gray-300 rounded-md"
                          />
                        )}
                        {payload.auth.mfa_required && (
                          <input
                            inputMode="numeric"
                            aria-label="MFA code"
                            placeholder="MFA code"
                            maxLength={6}
                            value={mfaCode}
                            onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))}
                            className="px-2 py-1 text-sm border border-gray-300 rounded-md"
                          />
                        )}
                      </div>
                    </div>
                  )}
                  <ul className="divide-y">
                    {active?.settings.map((s) => (
                      <SettingRow
                        key={s.key}
                        setting={s}
                        busy={busyKey === s.key}
                        onSave={(value) => void write(s, 'PUT', value)}
                        onReset={() => void write(s, 'DELETE')}
                      />
                    ))}
                  </ul>
                </>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
