'use client';

import React, { useEffect, useState } from 'react';

import { apiFetch } from '../lib/api';

/**
 * Settings: the "Getting started" checklist. What a new install still needs
 * before paper trading, computed by the backend from state, so each step
 * ticks itself once done. Hidden once everything is done.
 */

export type ChecklistItem = {
  id: string;
  title: string;
  done: boolean;
  detail: string;
  tab: string;
};

type Props = {
  /** Opens a Settings tab. */
  onOpen: (tab: string) => void;
  /** Re-read when this changes (the open tab), so a step done there ticks. */
  refreshKey?: string;
};

export default function GettingStarted({ onOpen, refreshKey }: Props) {
  const [items, setItems] = useState<ChecklistItem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiFetch('/api/settings/checklist');
        if (!r.ok) return;
        const body = await r.json();
        if (!cancelled) setItems(Array.isArray(body?.items) ? body.items : null);
      } catch {
        // The checklist is a convenience; the page works without it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (!items || items.every((i) => i.done)) return null;
  const left = items.filter((i) => !i.done).length;

  return (
    <section
      aria-label="Getting started"
      className="p-3 border border-blue-200 rounded-md bg-blue-50"
    >
      <h2 className="text-sm font-semibold text-gray-900">
        Getting started: {left} of {items.length} steps left
      </h2>
      <ul className="mt-2 space-y-1">
        {items.map((item) => (
          <li key={item.id} className="flex items-start gap-2 text-sm">
            <span aria-hidden="true" className={item.done ? 'text-green-700' : 'text-gray-400'}>
              {item.done ? '✓' : '○'}
            </span>
            <span className="flex-1">
              {item.done ? (
                <span className="text-gray-500">{item.title}</span>
              ) : (
                <button
                  type="button"
                  className="text-blue-700 underline hover:text-blue-900"
                  onClick={() => onOpen(item.tab)}
                >
                  {item.title}
                </button>
              )}
              {!item.done && <span className="block text-gray-600">{item.detail}</span>}
            </span>
            <span className="sr-only">{item.done ? 'done' : 'not done'}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
