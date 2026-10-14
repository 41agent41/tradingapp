'use client';

import React, { useEffect, useState } from 'react';

import { apiFetch } from '../lib/api';
import { passwordProblem } from '../lib/security';

/** Only same-site paths are followed after login, never another origin. */
function safeNext(): string {
  if (typeof window === 'undefined') return '/';
  const next = new URLSearchParams(window.location.search).get('next') || '/';
  return next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login') ? next : '/';
}

const MIN_PASSWORD = 12;
const FIELD =
  'mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';
const SUBMIT =
  'w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-blue-500';

/**
 * Sign in, or, on a fresh install with no password yet, choose one. The
 * first-run form asks for the setup code the backend printed at startup
 * (`./tradingapp.sh setup-code`), so nobody else on the network can claim
 * the app first.
 */
export default function LoginPage() {
  const [setup, setSetup] = useState(false);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    apiFetch('/api/auth/session', { skipAuthRedirect: true })
      .then((r) => r.json())
      .then((body) => setSetup(!!body?.setup_required))
      .catch(() => undefined);
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch(setup ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(setup ? { code, password } : { password }),
        skipAuthRedirect: true,
      });
      if (res.ok) {
        window.location.assign(setup ? '/settings' : safeNext());
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (body?.setup_required) setSetup(true);
      setError(body?.message || `${setup ? 'Setup' : 'Login'} failed (${res.status})`);
    } catch {
      setError('Could not reach the backend.');
    } finally {
      setSubmitting(false);
    }
  }

  const problem =
    setup && (password || confirm) ? passwordProblem(password, confirm, MIN_PASSWORD) : null;
  const ready = setup ? !!code.trim() && !!password && !problem : password.length > 0;

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <form
        onSubmit={onSubmit}
        className="max-w-sm w-full bg-white rounded-lg shadow-sm border border-gray-200 p-6 space-y-4"
      >
        <h1 className="text-lg font-semibold text-gray-900">TradingApp</h1>
        {setup && (
          <p className="text-sm text-gray-600">
            Choose the login password. The setup code is in the backend log: run{' '}
            <code className="text-xs">./tradingapp.sh setup-code</code> on the server.
          </p>
        )}
        {setup && (
          <label className="block">
            <span className="text-sm text-gray-700">Setup code</span>
            <input
              autoComplete="one-time-code"
              autoFocus
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className={`${FIELD} font-mono uppercase`}
            />
          </label>
        )}
        <label className="block">
          <span className="text-sm text-gray-700">{setup ? 'New password' : 'Password'}</span>
          <input
            type="password"
            autoComplete={setup ? 'new-password' : 'current-password'}
            autoFocus={!setup}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={FIELD}
          />
        </label>
        {setup && (
          <label className="block">
            <span className="text-sm text-gray-700">Repeat password</span>
            <input
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className={FIELD}
            />
          </label>
        )}
        {problem && <p className="text-xs text-gray-600">{problem}</p>}
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <button type="submit" disabled={submitting || !ready} className={SUBMIT}>
          {submitting
            ? setup
              ? 'Saving…'
              : 'Signing in…'
            : setup
              ? 'Set password and sign in'
              : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
