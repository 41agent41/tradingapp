'use client';

import React, { useState } from 'react';

import { apiFetch } from '../lib/api';

/** Only same-site paths are followed after login, never another origin. */
function safeNext(): string {
  if (typeof window === 'undefined') return '/';
  const next = new URLSearchParams(window.location.search).get('next') || '/';
  return next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login') ? next : '/';
}

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        skipAuthRedirect: true,
      });
      if (res.ok) {
        window.location.assign(safeNext());
        return;
      }
      const body = await res.json().catch(() => ({}));
      setError(body?.message || `Login failed (${res.status})`);
    } catch {
      setError('Could not reach the backend.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <form
        onSubmit={onSubmit}
        className="max-w-sm w-full bg-white rounded-lg shadow-sm border border-gray-200 p-6 space-y-4"
      >
        <h1 className="text-lg font-semibold text-gray-900">TradingApp</h1>
        <label className="block">
          <span className="text-sm text-gray-700">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting || password.length === 0}
          className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
