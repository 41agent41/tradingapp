/**
 * The theme: what is shown for each choice, that the choice is kept, and
 * that the control and the charts follow it.
 */
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ThemeToggle from '../app/components/ThemeToggle';
import {
  THEME_SCRIPT,
  applyTheme,
  chartThemeOptions,
  resolveTheme,
  storedChoice,
  useTheme,
} from '../app/lib/theme';

function deviceIsDark(dark: boolean) {
  window.matchMedia = vi.fn(() => ({
    matches: dark,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as any;
}

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  deviceIsDark(false);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('theme', () => {
  it('follows the device only when asked to', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('shows a choice and keeps it', () => {
    expect(storedChoice()).toBe('system');
    expect(applyTheme('dark')).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(storedChoice()).toBe('dark');
    deviceIsDark(true);
    expect(applyTheme('system')).toBe('dark');
    expect(applyTheme('light')).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('ignores a stored value it does not know', () => {
    window.localStorage.setItem('theme', 'sepia');
    expect(storedChoice()).toBe('system');
  });

  it('the script that runs before the page agrees with the rest', () => {
    const run = () => new Function(THEME_SCRIPT)();
    run();
    expect(document.documentElement.dataset.theme).toBe('light');
    deviceIsDark(true);
    run();
    expect(document.documentElement.dataset.theme).toBe('dark');
    window.localStorage.setItem('theme', 'light');
    run();
    expect(document.documentElement.dataset.theme).toBe('light');
    window.localStorage.setItem('theme', 'dark');
    deviceIsDark(false);
    run();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('gives charts a dark background only in the dark theme', () => {
    expect(chartThemeOptions('light').layout.background.color).toBe('#ffffff');
    expect(chartThemeOptions('dark').layout.background.color).toBe('#111827');
  });

  it('useTheme follows a change made elsewhere on the page', async () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current).toBe('light');
    act(() => {
      applyTheme('dark');
    });
    await waitFor(() => expect(result.current).toBe('dark'));
  });
});

describe('ThemeToggle', () => {
  it('shows the kept choice and changes the page when another is picked', async () => {
    window.localStorage.setItem('theme', 'light');
    render(<ThemeToggle />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('theme')).toBe('dark');
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');

    deviceIsDark(false);
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
