'use client';

import { useEffect, useState } from 'react';

/** What the user chose: a fixed theme, or whatever the device prefers. */
export type ThemeChoice = 'light' | 'dark' | 'system';
/** What is shown. */
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'theme';
export const THEME_CHOICES: ThemeChoice[] = ['light', 'dark', 'system'];

export const isThemeChoice = (v: unknown): v is ThemeChoice =>
  v === 'light' || v === 'dark' || v === 'system';

export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): Theme {
  if (choice === 'system') return prefersDark ? 'dark' : 'light';
  return choice;
}

const prefersDark = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches;

export function storedChoice(): ThemeChoice {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    return isThemeChoice(saved) ? saved : 'system';
  } catch {
    return 'system';
  }
}

/** Show `choice` now and keep it for the next visit. */
export function applyTheme(choice: ThemeChoice): Theme {
  const theme = resolveTheme(choice, prefersDark());
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Storage is off: the choice lasts for this page only.
  }
  return theme;
}

/**
 * Runs before the page is drawn (app/layout.tsx), so a dark page never
 * flashes light first. Kept in step with `storedChoice` and `resolveTheme`.
 */
export const THEME_SCRIPT = `(function(){try{var c=localStorage.getItem('${THEME_KEY}');var d=c==='dark'||(c!=='light'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';}catch(e){}})();`;

const shownTheme = (): Theme =>
  typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark'
    ? 'dark'
    : 'light';

/** The theme on screen, following every change to it. */
export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>('light');
  useEffect(() => {
    const read = () => setTheme(shownTheme());
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** The colours lightweight-charts is given for each theme. */
export function chartColors(theme: Theme) {
  return theme === 'dark'
    ? { background: '#111827', text: '#d1d5db', grid: '#1f2937', border: '#374151' }
    : { background: '#ffffff', text: '#333333', grid: '#f0f0f0', border: '#cccccc' };
}

/** The part of a chart's options that depends on the theme. */
export function chartThemeOptions(theme: Theme) {
  const c = chartColors(theme);
  return {
    layout: { background: { color: c.background }, textColor: c.text },
    grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
    rightPriceScale: { borderColor: c.border },
    timeScale: { borderColor: c.border },
  };
}
