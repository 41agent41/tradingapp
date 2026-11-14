'use client';

import React, { useEffect, useState } from 'react';
import { THEME_CHOICES, applyTheme, storedChoice, type ThemeChoice } from '../lib/theme';

const LABEL: Record<ThemeChoice, string> = { light: 'Light', dark: 'Dark', system: 'Auto' };

/**
 * A small control in the corner of every page: light, dark, or whatever the
 * device prefers. The choice is kept in the browser.
 */
export default function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>('system');

  useEffect(() => {
    const read = () => setChoice(storedChoice());
    read();
    // With "Auto", follow the device when it changes.
    const media =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null;
    const follow = () => {
      if (storedChoice() === 'system') applyTheme('system');
    };
    media?.addEventListener?.('change', follow);
    return () => media?.removeEventListener?.('change', follow);
  }, []);

  const pick = (next: ThemeChoice) => {
    setChoice(next);
    applyTheme(next);
  };

  return (
    <div
      role="group"
      aria-label="Theme"
      className="fixed bottom-2 right-2 z-40 flex overflow-hidden rounded border border-gray-300 bg-white text-xs shadow-sm print:hidden"
    >
      {THEME_CHOICES.map((c) => (
        <button
          key={c}
          type="button"
          aria-pressed={choice === c}
          onClick={() => pick(c)}
          className={
            choice === c
              ? 'px-2 py-1 bg-blue-600 text-white'
              : 'px-2 py-1 text-gray-700 hover:bg-gray-100'
          }
        >
          {LABEL[c]}
        </button>
      ))}
    </div>
  );
}
