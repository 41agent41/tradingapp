'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Drop-in replacement for `useState<string>` that mirrors the value into
 * `localStorage` under the given key. SSR-safe: on the server (or when
 * `window` is unavailable) it simply returns the initial value and skips
 * any storage I/O.
 *
 * If the persisted value fails validation (e.g. an old timeframe slug we
 * no longer recognise), `validate` returns `false` and the initial value
 * wins. Pass `validate` whenever the set of legal values is bounded.
 */
export function usePersistentState(
  key: string,
  initialValue: string,
  validate?: (v: string) => boolean
): [string, (next: string) => void] {
  const [value, setValue] = useState<string>(initialValue);
  const hydrated = useRef(false);

  // Hydrate from localStorage exactly once on mount.
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    if (typeof window === 'undefined') return;
    try {
      const stored = window.localStorage.getItem(key);
      if (stored !== null && stored !== '' && (!validate || validate(stored))) {
        setValue(stored);
      }
    } catch {
      // Storage disabled (e.g. privacy mode); silently fall back to initial.
    }
  }, [key, validate]);

  // Persist on change.
  useEffect(() => {
    if (!hydrated.current) return;
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Quota or disabled storage — ignore.
    }
  }, [key, value]);

  return [value, setValue];
}

export const STORAGE_KEYS = {
  lastSymbol: 'tradingapp.lastSymbol',
  lastTimeframe: 'tradingapp.lastTimeframe',
} as const;
