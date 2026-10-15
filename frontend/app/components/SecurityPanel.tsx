'use client';

import QRCode from 'qrcode';
import React, { useCallback, useEffect, useState } from 'react';

import { apiFetch } from '../lib/api';
import {
  type SecurityPayload,
  type TokenKind,
  type TokenView,
  TOKEN_KINDS,
  groupSecret,
  lastUsed,
  mfaSummary,
  passwordProblem,
} from '../lib/security';

/**
 * Settings > Security: the login password, trading and API tokens, and the
 * order MFA secret. Nothing secret is ever read back from the server: a new
 * token is shown once, when it is made, and the MFA secret only while it is
 * being set up.
 *
 * Adding a way in (a token, an MFA secret) or turning MFA off needs the
 * trading token and current MFA code, once those exist. Revoking a token
 * needs only the login.
 */

const BUTTON =
  'px-3 py-1.5 text-sm rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50';
const PRIMARY =
  'px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50';
const INPUT = 'px-2 py-1 text-sm border border-gray-300 rounded-md';

async function readJson(r: Response) {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error || body?.detail || `HTTP ${r.status}`);
  return body;
}

function PasswordSection({
  data,
  onDone,
}: {
  data: SecurityPayload;
  onDone: (text: string, kind: 'ok' | 'error') => void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  if (data.password.source === 'environment') {
    return (
      <p className="text-sm text-gray-600">
        Set in .env (APP_PASSWORD), which takes precedence. Remove it there to manage the password
        here.
      </p>
    );
  }
  const problem = next || confirm ? passwordProblem(next, confirm, data.password.min_length) : null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await readJson(
        await apiFetch('/api/security/password', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ current, password: next }),
        })
      );
      onDone('Password changed. Every browser is signed out; sign in again.', 'ok');
      setTimeout(() => window.location.assign('/login?next=/settings'), 1500);
    } catch (err) {
      onDone(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col sm:flex-row sm:flex-wrap gap-2 items-start">
      {data.password.source === 'database' && (
        <input
          type="password"
          autoComplete="current-password"
          aria-label="Current password"
          placeholder="Current password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className={INPUT}
        />
      )}
      <input
        type="password"
        autoComplete="new-password"
        aria-label="New password"
        placeholder="New password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        className={INPUT}
      />
      <input
        type="password"
        autoComplete="new-password"
        aria-label="Repeat new password"
        placeholder="Repeat new password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        className={INPUT}
      />
      <button type="submit" disabled={busy || !next || !!problem} className={PRIMARY}>
        Change password
      </button>
      {problem && <p className="w-full text-xs text-red-700">{problem}</p>}
    </form>
  );
}

function TokenList({
  kind,
  title,
  help,
  tokens,
  envCount,
  busy,
  onCreate,
  onRevoke,
}: {
  kind: TokenKind;
  title: string;
  help: string;
  tokens: TokenView[];
  envCount: number;
  busy: boolean;
  onCreate: (kind: TokenKind, label: string) => void;
  onRevoke: (token: TokenView) => void;
}) {
  const [label, setLabel] = useState('');
  return (
    <div className="space-y-2">
      <h4 className="font-medium text-gray-900">{title}</h4>
      <p className="text-sm text-gray-600">{help}</p>
      {envCount > 0 && (
        <p className="text-xs text-amber-800">
          {envCount} more set in .env ({kind === 'api' ? 'API_TOKEN' : 'TRADING_TOKENS'}); they can
          only be removed there.
        </p>
      )}
      {tokens.length === 0 ? (
        <p className="text-sm text-gray-500">None made here yet.</p>
      ) : (
        <ul className="divide-y border rounded-md">
          {tokens.map((t) => (
            <li key={t.id} className="px-3 py-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="text-sm font-medium text-gray-900">{t.label}</span>
                <span className="ml-2 text-xs font-mono text-gray-500">{t.prefix}…</span>
                <p className="text-xs text-gray-500">
                  Made {new Date(t.created_at).toLocaleDateString()}, {lastUsed(t.last_used_at)}
                </p>
              </div>
              <button type="button" className={BUTTON} disabled={busy} onClick={() => onRevoke(t)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onCreate(kind, label);
          setLabel('');
        }}
      >
        <input
          aria-label={`New ${title.toLowerCase()} name`}
          placeholder="Name, e.g. phone or backup script"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={64}
          className={`${INPUT} w-64`}
        />
        <button type="submit" className={BUTTON} disabled={busy || !label.trim()}>
          Make token
        </button>
      </form>
    </div>
  );
}

function MfaSection({
  data,
  busy,
  stepUp,
  onChanged,
  onError,
}: {
  data: SecurityPayload;
  busy: boolean;
  stepUp: () => Record<string, string>;
  onChanged: (text: string) => void;
  onError: (text: string) => void;
}) {
  const [enrolling, setEnrolling] = useState<{ secret: string; svg: string } | null>(null);
  const [code, setCode] = useState('');

  async function begin() {
    try {
      const body = await readJson(
        await apiFetch('/api/security/mfa', { method: 'POST', headers: stepUp() })
      );
      // Drawn here, in the browser: the secret never goes to a QR service.
      const svg = await QRCode.toString(body.otpauth_uri, { type: 'svg', margin: 1, width: 180 });
      setEnrolling({ secret: body.secret, svg });
      setCode('');
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    try {
      await readJson(
        await apiFetch('/api/security/mfa/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        })
      );
      setEnrolling(null);
      onChanged('MFA is on. Orders and protected changes now ask for a code.');
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  async function remove() {
    if (!window.confirm('Turn MFA off? Live trading closes until it is set up again.')) return;
    try {
      await readJson(await apiFetch('/api/security/mfa', { method: 'DELETE', headers: stepUp() }));
      onChanged('MFA is off. Live trading is closed until it is set up again.');
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }

  const source = data.mfa.source;
  return (
    <div className="space-y-2">
      <p className="text-sm text-gray-700">{mfaSummary(source)}</p>
      {source !== 'environment' && !enrolling && (
        <div className="flex gap-2">
          <button type="button" className={BUTTON} disabled={busy} onClick={() => void begin()}>
            {source === 'database' ? 'Replace with a new phone' : 'Set up MFA'}
          </button>
          {source === 'database' && (
            <button type="button" className={BUTTON} disabled={busy} onClick={() => void remove()}>
              Turn off
            </button>
          )}
        </div>
      )}
      {enrolling && (
        <form onSubmit={confirm} className="space-y-2">
          <p className="text-sm text-gray-600">
            Scan this with an authenticator app (Google Authenticator, 1Password, Authy), or type
            the key in by hand. Then enter the code it shows.
          </p>
          <div
            className="w-[180px] h-[180px] bg-white"
            aria-label="MFA QR code"
            dangerouslySetInnerHTML={{ __html: enrolling.svg }}
          />
          <p className="text-sm font-mono text-gray-900 break-all">
            {groupSecret(enrolling.secret)}
          </p>
          <div className="flex gap-2">
            <input
              inputMode="numeric"
              aria-label="Code from the app"
              placeholder="123456"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              className={`${INPUT} w-28`}
            />
            <button type="submit" className={PRIMARY} disabled={code.length !== 6}>
              Confirm
            </button>
            <button type="button" className={BUTTON} onClick={() => setEnrolling(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export default function SecurityPanel() {
  const [data, setData] = useState<SecurityPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [created, setCreated] = useState<{ token: string; view: TokenView } | null>(null);
  const [tradingToken, setTradingToken] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await readJson(await apiFetch('/api/security')));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const stepUp = useCallback((): Record<string, string> => {
    const h: Record<string, string> = {};
    if (data?.auth.trading_auth_required && tradingToken.trim()) {
      h['X-Trading-Token'] = tradingToken.trim();
    }
    if (data?.auth.mfa_required && mfaCode.trim()) h['X-MFA-Code'] = mfaCode.trim();
    return h;
  }, [data, tradingToken, mfaCode]);

  const done = async (text: string, kind: 'ok' | 'error' = 'ok') => {
    setMessage({ kind, text });
    if (kind === 'ok') {
      setMfaCode('');
      await load();
    }
  };

  async function createToken(kind: TokenKind, label: string) {
    setBusy(true);
    setCreated(null);
    try {
      const body = await readJson(
        await apiFetch('/api/security/tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...stepUp() },
          body: JSON.stringify({ kind, label }),
        })
      );
      setCreated(body);
      await done(`Token "${body.view.label}" made. Copy it now; it is not shown again.`);
    } catch (err) {
      await done(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(t: TokenView) {
    if (!window.confirm(`Revoke "${t.label}"? Anything using it stops working.`)) return;
    setBusy(true);
    try {
      await readJson(await apiFetch(`/api/security/tokens/${t.id}`, { method: 'DELETE' }));
      if (created?.view.id === t.id) setCreated(null);
      await done(`Token "${t.label}" revoked.`);
    } catch (err) {
      await done(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="text-sm text-red-700">{error}</p>;
  if (!data) return <p className="text-sm text-gray-500">Loading…</p>;

  const needsStepUp = data.auth.trading_auth_required || data.auth.mfa_required;
  return (
    <div className="space-y-6">
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
      {!data.status.encryption_key && (
        <div className="p-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md">
          SETTINGS_ENCRYPTION_KEY is not set in .env, so the MFA secret cannot be stored. Run
          ./tradingapp.sh config to generate one.
        </div>
      )}

      {needsStepUp && (
        <div className="p-3 bg-gray-50 border rounded-md">
          <p className="text-sm text-gray-700 mb-2">
            Making a token or changing MFA needs a trading token and a current MFA code. Revoking a
            token does not.
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            {data.auth.trading_auth_required && (
              <input
                type="password"
                aria-label="Trading token"
                placeholder="Trading token"
                value={tradingToken}
                onChange={(e) => setTradingToken(e.target.value)}
                className={INPUT}
              />
            )}
            {data.auth.mfa_required && (
              <input
                inputMode="numeric"
                aria-label="MFA code"
                placeholder="MFA code"
                maxLength={6}
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))}
                className={INPUT}
              />
            )}
          </div>
        </div>
      )}

      <section className="space-y-2">
        <h3 className="text-base font-semibold text-gray-900">Login password</h3>
        <PasswordSection data={data} onDone={(text, kind) => void done(text, kind)} />
      </section>

      <section className="space-y-2">
        <h3 className="text-base font-semibold text-gray-900">Order MFA</h3>
        <MfaSection
          data={data}
          busy={busy}
          stepUp={stepUp}
          onChanged={(text) => void done(text)}
          onError={(text) => void done(text, 'error')}
        />
      </section>

      {created && (
        <div className="p-3 border border-blue-200 bg-blue-50 rounded-md space-y-2">
          <p className="text-sm text-blue-900">
            New {created.view.kind === 'api' ? 'API' : 'trading'} token &quot;
            {created.view.label}&quot;. Copy it now; it is not shown again.
          </p>
          <div className="flex gap-2 items-center">
            <code className="text-xs break-all bg-white border rounded px-2 py-1">
              {created.token}
            </code>
            <button
              type="button"
              className={BUTTON}
              onClick={() => void navigator.clipboard?.writeText(created.token)}
            >
              Copy
            </button>
          </div>
        </div>
      )}

      {TOKEN_KINDS.map(({ kind, title, help }) => (
        <section key={kind}>
          <TokenList
            kind={kind}
            title={title}
            help={help}
            tokens={data.tokens[kind]}
            envCount={data.tokens.env[kind]}
            busy={busy}
            onCreate={(k, label) => void createToken(k, label)}
            onRevoke={(t) => void revoke(t)}
          />
        </section>
      ))}
    </div>
  );
}
