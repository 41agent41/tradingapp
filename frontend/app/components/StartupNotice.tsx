'use client';

import React, { useEffect, useState } from 'react';
import { apiUrl } from '../lib/api';

const POLL_INTERVAL_MS = 5_000;

export interface StartupStatus {
  state: string;
  ready: boolean;
  detail: string | null;
  database?: string;
}

const TITLES: Record<string, string> = {
  waiting_for_database: 'Waiting for the database',
  migrating: 'Updating the database',
  migration_failed: 'The database could not be updated',
  key_mismatch: 'The encryption key does not match this database',
};

/** Title for a not-ready state; unknown states read as starting. */
function titleFor(state: string): string {
  return TITLES[state] ?? 'Starting';
}

/**
 * Covers the page while the backend is not ready (database unreachable, being
 * migrated, or refused). The backend answers every other API call with 503
 * until then, so the page underneath could only show errors. Polls until
 * ready, then gets out of the way and stops polling.
 */
export default function StartupNotice() {
  const [status, setStatus] = useState<StartupStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const res = await fetch(apiUrl('/api/health/ready'), { cache: 'no-store' });
        const body = (await res.json().catch(() => null)) as StartupStatus | null;
        if (cancelled) return;
        if (res.ok) {
          setStatus(null);
          return; // ready: stop polling
        }
        setStatus(body && typeof body.state === 'string' ? body : null);
      } catch {
        // Backend unreachable: the header's health badge reports that.
        if (!cancelled) setStatus(null);
      }
      if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!status || status.ready) return null;
  const waiting = status.state === 'waiting_for_database' || status.state === 'migrating';
  return (
    <div
      role="alert"
      className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/80 p-4"
    >
      <div className="max-w-lg rounded-lg bg-white p-6 shadow-xl">
        <h2 className={`text-lg font-semibold ${waiting ? 'text-gray-900' : 'text-red-700'}`}>
          {titleFor(status.state)}
        </h2>
        {status.detail && <p className="mt-2 text-sm text-gray-700">{status.detail}</p>}
        <p className="mt-4 text-xs text-gray-500">
          {waiting
            ? 'The app starts by itself once this is done. This page checks every few seconds.'
            : 'The app will not start until this is fixed. See ./tradingapp.sh logs on the server.'}
        </p>
      </div>
    </div>
  );
}

export const __test = { titleFor };
