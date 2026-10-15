'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';
import {
  type FormState,
  type LiveConnection,
  type StatusPayload,
  type StoredConnection,
  type StoredPayload,
  BROKERS_BY_PRIORITY,
  LIMIT_FORM,
  PLATFORM_FORM,
  checkSummary,
  saveMessage,
  emptyForm,
  formFromStored,
  movePlatform,
  platformName,
  requestBody,
} from '../lib/brokerConnections';

/**
 * Settings > Connections: every broker in priority order, each connection
 * with its last connectivity check and a Test button, and the controls to
 * add, edit, remove and rerank brokers.
 *
 * Connections come from two places. Those in `.env` are shown with a ".env"
 * badge and can only be changed there; `.env` wins per broker, so a
 * connection added here for a broker `.env` already configures is listed as
 * ignored. Changing anything needs the same trading token and MFA code as an
 * order, when those are turned on.
 */

export { checkSummary, platformName };

const DEFAULT_ORDER = BROKERS_BY_PRIORITY;

const TONE_STYLES = {
  ok: 'bg-emerald-100 text-emerald-800',
  bad: 'bg-red-100 text-red-800',
  none: 'bg-gray-100 text-gray-600',
};

const BUTTON =
  'px-3 py-1.5 text-sm rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50';
const INPUT = 'w-full px-2 py-1 text-sm border border-gray-300 rounded-md';

type Editing = { id: number | null; form: FormState; stored?: StoredConnection };

async function readJson(r: Response) {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error || body?.detail || `HTTP ${r.status}`);
  return body;
}

function ConnectionForm({
  editing,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  editing: Editing;
  busy: boolean;
  onChange: (form: FormState) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { form, id, stored } = editing;
  const set = (patch: Partial<FormState>) => onChange({ ...form, ...patch });
  const setValue = (name: string, value: string) =>
    onChange({ ...form, values: { ...form.values, [name]: value } });

  return (
    <form
      aria-label={id ? `Edit ${form.platform}:${form.account}` : 'Add a broker connection'}
      className="mt-3 p-3 border rounded-md bg-gray-50 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="text-sm text-gray-700">
          Broker
          <select
            className={INPUT}
            value={form.platform}
            disabled={id !== null}
            onChange={(e) => onChange({ ...emptyForm(e.target.value) })}
          >
            {DEFAULT_ORDER.map((p) => (
              <option key={p} value={p}>
                {platformName(p)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-gray-700">
          Name
          <input
            className={INPUT}
            value={form.account}
            disabled={id !== null}
            onChange={(e) => set({ account: e.target.value })}
          />
        </label>
        <label className="text-sm text-gray-700">
          Mode
          <select
            className={INPUT}
            value={form.account_mode}
            onChange={(e) => set({ account_mode: e.target.value as 'paper' | 'live' })}
          >
            <option value="paper">Paper / practice</option>
            <option value="live">Live</option>
          </select>
        </label>
        <label className="text-sm text-gray-700">
          Currency
          <input
            className={INPUT}
            value={form.currency}
            maxLength={3}
            onChange={(e) => set({ currency: e.target.value })}
          />
        </label>
        {(PLATFORM_FORM[form.platform] ?? []).map((field) => (
          <label key={field.name} className="text-sm text-gray-700">
            {field.label}
            {field.required ? ' *' : ''}
            <input
              className={INPUT}
              type={field.secret ? 'password' : 'text'}
              autoComplete="off"
              value={form.values[field.name] ?? ''}
              placeholder={
                field.secret && stored?.secrets_set[field.name]
                  ? 'Stored; leave blank to keep'
                  : field.placeholder
              }
              onChange={(e) => setValue(field.name, e.target.value)}
            />
          </label>
        ))}
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-gray-700">Risk limits</legend>
        <p className="text-xs text-gray-500">
          In {form.currency || 'the account currency'}. Empty uses the cap on the Risk tab. New
          entries stop once one is reached; exits always go through.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {LIMIT_FORM.map((limit) => (
            <label key={limit.name} className="text-sm text-gray-700">
              {limit.label}
              <input
                className={INPUT}
                type="number"
                min={0}
                step={limit.name === 'max_orders_per_day' ? 1 : 'any'}
                value={form.limits[limit.name] ?? ''}
                onChange={(e) => set({ limits: { ...form.limits, [limit.name]: e.target.value } })}
              />
            </label>
          ))}
        </div>
        <label className="block text-sm text-gray-700">
          Prop firm rules (JSON, funded accounts only)
          <textarea
            className={`${INPUT} font-mono`}
            rows={form.prop_rules ? 6 : 2}
            value={form.prop_rules}
            placeholder='{"firm": "FTMO 100k", "initial_balance": 100000, "daily_loss": {"pct": 5}, "max_loss": {"pct": 10}}'
            onChange={(e) => set({ prop_rules: e.target.value })}
          />
        </label>
      </fieldset>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input
          type="checkbox"
          checked={form.is_default}
          onChange={(e) => set({ is_default: e.target.checked })}
        />
        Default account for {platformName(form.platform)}
      </label>
      {form.account_mode === 'live' && (
        <p className="text-xs text-amber-800">
          Live connections only take orders while live trading is on.
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={BUTTON}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel} className={BUTTON}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function BrokerConnections() {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [stored, setStored] = useState<StoredPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [tradingToken, setTradingToken] = useState('');
  const [mfaCode, setMfaCode] = useState('');

  const load = useCallback(async () => {
    const [s, c] = await Promise.allSettled([
      apiFetch('/api/brokers/status').then(readJson),
      apiFetch('/api/brokers/connections').then(readJson),
    ]);
    if (s.status === 'fulfilled') {
      setStatus(s.value);
      setError(null);
    } else {
      setError(s.reason instanceof Error ? s.reason.message : String(s.reason));
    }
    if (c.status === 'fulfilled') setStored(c.value);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const auth = stored?.auth;
  const writeHeaders = (): Record<string, string> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth?.trading_auth_required && tradingToken.trim())
      h['X-Trading-Token'] = tradingToken.trim();
    if (auth?.mfa_required && mfaCode.trim()) h['X-MFA-Code'] = mfaCode.trim();
    return h;
  };

  const write = async (path: string, method: string, body: unknown, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await readJson(
        await apiFetch(path, {
          method,
          headers: writeHeaders(),
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      );
      setMessage(saveMessage(done, res));
      if (auth?.mfa_required) setMfaCode('');
      await load();
      return true;
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const test = async (label: string) => {
    setTesting(label);
    try {
      const body = await readJson(
        await apiFetch(`/api/brokers/${encodeURIComponent(label)}/test`, { method: 'POST' })
      );
      setStatus((d) =>
        d
          ? {
              ...d,
              connections: d.connections.map((c) =>
                c.label === label ? { ...c, check: body.check } : c
              ),
            }
          : d
      );
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(null);
    }
  };

  const save = async () => {
    if (!editing) return;
    const body = requestBody(editing.form);
    const ok =
      editing.id === null
        ? await write('/api/brokers/connections', 'POST', body, 'Connection added.')
        : await write(`/api/brokers/connections/${editing.id}`, 'PUT', body, 'Connection saved.');
    if (ok) setEditing(null);
  };

  const remove = async (c: StoredConnection) => {
    if (!window.confirm(`Remove ${platformName(c.platform)} ${c.account}?`)) return;
    await write(`/api/brokers/connections/${c.id}`, 'DELETE', undefined, 'Connection removed.');
  };

  const order = status?.priority?.length ? status.priority : DEFAULT_ORDER;
  const priorityLocked = Boolean(status?.priority_from_env || stored?.priority_locked);
  const rerank = (platform: string, by: -1 | 1) =>
    write(
      '/api/brokers/priority',
      'PUT',
      { priority: movePlatform(order, platform, by) },
      'Broker priority saved.'
    );

  if (!status && error) {
    return <p className="text-sm text-red-700">Broker status could not be loaded: {error}</p>;
  }
  if (!status) return <p className="text-sm text-gray-500">Loading…</p>;

  const storedByLabel = new Map((stored?.connections ?? []).map((c) => [c.label, c]));
  const liveLabels = new Set(status.connections.map((c) => c.label));
  const overridden = new Set(status.overridden ?? []);

  const liveRow = (c: LiveConnection) => {
    const s = checkSummary(c.check);
    const mine = c.source === 'app' ? storedByLabel.get(c.label) : undefined;
    return (
      <li
        key={c.label}
        className="py-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-gray-900">{c.account}</span>
            {c.is_default && (
              <span className="px-1.5 py-0.5 text-xs rounded bg-blue-100 text-blue-800">
                default
              </span>
            )}
            {c.account_mode && (
              <span className="px-1.5 py-0.5 text-xs rounded bg-gray-100 text-gray-700">
                {c.account_mode}
              </span>
            )}
            {c.source === 'env' && (
              <span className="px-1.5 py-0.5 text-xs rounded bg-amber-100 text-amber-800">
                .env
              </span>
            )}
          </div>
          <span
            className={`inline-block mt-1 px-1.5 py-0.5 text-xs rounded break-all ${TONE_STYLES[s.tone]}`}
            title={c.check?.checked_at ?? undefined}
          >
            {s.text}
          </span>
        </div>
        <div className="flex gap-2 self-start sm:self-auto">
          <button
            type="button"
            onClick={() => void test(c.label)}
            disabled={testing !== null}
            aria-label={`Test ${platformName(c.platform)} ${c.account}`}
            className={BUTTON}
          >
            {testing === c.label ? 'Testing…' : 'Test'}
          </button>
          {mine && (
            <>
              <button
                type="button"
                className={BUTTON}
                aria-label={`Edit ${platformName(c.platform)} ${c.account}`}
                onClick={() =>
                  setEditing({ id: mine.id, form: formFromStored(mine), stored: mine })
                }
              >
                Edit
              </button>
              <button
                type="button"
                className={BUTTON}
                disabled={busy}
                aria-label={`Remove ${platformName(c.platform)} ${c.account}`}
                onClick={() => void remove(mine)}
              >
                Remove
              </button>
            </>
          )}
        </div>
      </li>
    );
  };

  const inactiveRow = (c: StoredConnection) => (
    <li
      key={c.label}
      className="py-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
    >
      <div className="text-sm text-gray-500">
        {c.account}{' '}
        <span className="text-xs">
          {overridden.has(c.label)
            ? `(ignored: .env configures ${platformName(c.platform)})`
            : c.secret_error
              ? `(credentials unreadable: ${c.secret_error})`
              : '(not active yet)'}
        </span>
      </div>
      <div className="flex gap-2 self-start sm:self-auto">
        <button
          type="button"
          className={BUTTON}
          aria-label={`Edit ${platformName(c.platform)} ${c.account}`}
          onClick={() => setEditing({ id: c.id, form: formFromStored(c), stored: c })}
        >
          Edit
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={busy}
          aria-label={`Remove ${platformName(c.platform)} ${c.account}`}
          onClick={() => void remove(c)}
        >
          Remove
        </button>
      </div>
    </li>
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        Brokers in priority order. The highest-ranked broker with a connection is the default for
        orders that name none. Credentials are entered here, never in .env, and each connection is
        checked when it is saved and again in the background.
      </p>

      {stored && !stored.encryption_ready && (
        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-3">
          SETTINGS_ENCRYPTION_KEY in .env is not set or not valid, so broker credentials cannot be
          saved here. Add it (openssl rand -hex 32) and redeploy.
        </p>
      )}
      {(auth?.trading_auth_required || auth?.mfa_required) && (
        <div className="p-3 bg-gray-50 border rounded-md">
          <p className="text-sm text-gray-700 mb-2">
            Changing brokers needs the same credentials as placing an order.
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            {auth?.trading_auth_required && (
              <input
                type="password"
                aria-label="Trading token"
                placeholder="Trading token"
                value={tradingToken}
                onChange={(e) => setTradingToken(e.target.value)}
                className="px-2 py-1 text-sm border border-gray-300 rounded-md"
              />
            )}
            {auth?.mfa_required && (
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
      {message && (
        <p
          role="status"
          className={`text-sm p-2 rounded-md border ${
            message.kind === 'ok'
              ? 'text-green-800 bg-green-50 border-green-200'
              : 'text-red-800 bg-red-50 border-red-200'
          }`}
        >
          {message.text}
        </p>
      )}
      {error && <p className="text-sm text-red-700">{error}</p>}
      {status.connections.length === 0 && (
        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-3">
          No broker connected. Add one below.
        </p>
      )}

      <ol className="space-y-3">
        {order.map((platform, i) => {
          const live = status.connections.filter((c) => c.platform === platform);
          const inactive = (stored?.connections ?? []).filter(
            (c) => c.platform === platform && !liveLabels.has(c.label)
          );
          return (
            <li key={platform} className="border rounded-md p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 w-4">{i + 1}</span>
                  <span className="font-medium text-gray-900">{platformName(platform)}</span>
                  {status.default === platform && live.length > 0 && (
                    <span className="px-1.5 py-0.5 text-xs rounded bg-blue-600 text-white">
                      default broker
                    </span>
                  )}
                </div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    className={BUTTON}
                    disabled={busy || priorityLocked || i === 0}
                    aria-label={`Move ${platformName(platform)} up`}
                    onClick={() => void rerank(platform, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className={BUTTON}
                    disabled={busy || priorityLocked || i === order.length - 1}
                    aria-label={`Move ${platformName(platform)} down`}
                    onClick={() => void rerank(platform, 1)}
                  >
                    ↓
                  </button>
                </div>
              </div>
              {live.length === 0 && inactive.length === 0 ? (
                <p className="mt-1 text-sm text-gray-500">Not connected</p>
              ) : (
                <ul className="mt-1 divide-y">
                  {live.map(liveRow)}
                  {inactive.map(inactiveRow)}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
      {priorityLocked && (
        <p className="text-xs text-gray-500">
          The order is set by BROKER_PRIORITY in .env. Remove it there to change it here.
        </p>
      )}

      {editing ? (
        <ConnectionForm
          editing={editing}
          busy={busy}
          onChange={(form) => setEditing({ ...editing, form })}
          onSave={() => void save()}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <button
          type="button"
          className={BUTTON}
          disabled={!stored}
          onClick={() => setEditing({ id: null, form: emptyForm() })}
        >
          Add connection
        </button>
      )}
    </div>
  );
}
