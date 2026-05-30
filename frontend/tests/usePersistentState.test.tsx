import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { usePersistentState } from '../app/lib/usePersistentState';

describe('usePersistentState', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it('starts from the initial value when nothing is persisted', () => {
    const { result } = renderHook(() => usePersistentState('k', 'initial'));
    expect(result.current[0]).toBe('initial');
  });

  it('hydrates from localStorage when a persisted value exists', () => {
    window.localStorage.setItem('k', 'persisted');
    const { result } = renderHook(() => usePersistentState('k', 'initial'));
    expect(result.current[0]).toBe('persisted');
  });

  it('writes through to localStorage on update', () => {
    const { result } = renderHook(() => usePersistentState('k', 'initial'));
    act(() => result.current[1]('updated'));
    expect(result.current[0]).toBe('updated');
    expect(window.localStorage.getItem('k')).toBe('updated');
  });

  it('falls back to initial when the persisted value fails validation', () => {
    window.localStorage.setItem('tf', '17min');
    const allowed = (v: string) => ['1hour', '1day'].includes(v);
    const { result } = renderHook(() => usePersistentState('tf', '1hour', allowed));
    expect(result.current[0]).toBe('1hour');
  });
});
