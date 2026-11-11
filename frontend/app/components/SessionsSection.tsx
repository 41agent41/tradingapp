'use client';

import React, { useEffect, useState } from 'react';

import { apiFetch, redirectToLogin } from '../lib/api';
import { type SessionView, describeBrowser, signedIn } from '../lib/security';

/**
 * Settings > Security: the browsers that are signed in. A session ends at
 * once on the server, so a copy of its cookie stops working too.
 */

const BUTTON =
  'px-3 py-1.5 text-sm rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50';

async function readJson(r: Response) {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.message || body?.error || `HTTP ${r.status}`);
  return body;
}

export default function SessionsSection({
  onDone,
  leave = redirectToLogin,
}: {
  onDone: (text: string, kind: 'ok' | 'error') => void;
  /** Called once this browser is signed out. */
  leave?: () => void;
}) {
  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Bumped to read the list again.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    apiFetch('/api/auth/sessions')
      .then(readJson)
      .then((body) => {
        if (!live) return;
        setSessions(Array.isArray(body.sessions) ? body.sessions : []);
        setError(null);
      })
      .catch((err) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [version]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      onDone(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  const signOut = () =>
    run(async () => {
      await readJson(await apiFetch('/api/auth/logout', { method: 'POST' }));
      leave();
    });

  const end = (s: SessionView) =>
    run(async () => {
      await readJson(await apiFetch(`/api/auth/sessions/${s.id}`, { method: 'DELETE' }));
      onDone(`${describeBrowser(s.user_agent)} signed out.`, 'ok');
      setVersion((v) => v + 1);
    });

  const signOutEverywhere = () =>
    run(async () => {
      if (!window.confirm('Sign out every browser, including this one?')) return;
      await readJson(await apiFetch('/api/auth/logout-all', { method: 'POST' }));
      leave();
    });

  if (error) return <p className="text-sm text-red-700">{error}</p>;
  if (!sessions) return <p className="text-sm text-gray-500">Loading…</p>;

  return (
    <div className="space-y-2">
      <p className="text-sm text-gray-600">
        Signing out ends the session on the server at once. API tokens are not affected.
      </p>
      {sessions.length === 0 ? (
        <p className="text-sm text-gray-500">
          No browser is signed in. This page was opened with an API token or with login off.
        </p>
      ) : (
        <ul className="divide-y border rounded-md">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm text-gray-900 truncate">
                  {describeBrowser(s.user_agent)}
                  {s.current && <span className="ml-2 text-xs text-green-700">this browser</span>}
                </p>
                <p className="text-xs text-gray-500">
                  {s.ip ?? 'unknown address'} · {signedIn(s.created_at)}
                </p>
              </div>
              <button
                type="button"
                className={BUTTON}
                disabled={busy}
                aria-label={
                  s.current ? 'Sign out this browser' : `Sign out ${describeBrowser(s.user_agent)}`
                }
                onClick={() => void (s.current ? signOut() : end(s))}
              >
                Sign out
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className={BUTTON}
        disabled={busy || sessions.length === 0}
        onClick={() => void signOutEverywhere()}
      >
        Sign out everywhere
      </button>
    </div>
  );
}
