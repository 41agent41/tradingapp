import { describe, expect, it } from 'vitest';

import {
  describeBrowser,
  groupSecret,
  lastUsed,
  mfaSummary,
  passwordProblem,
  signedIn,
} from '../app/lib/security';

describe('security helpers', () => {
  it('checks a new password', () => {
    expect(passwordProblem('short', 'short', 12)).toMatch(/12 characters/);
    expect(passwordProblem('long enough pass', 'long enough pas', 12)).toMatch(/match/);
    expect(passwordProblem('long enough pass', 'long enough pass', 12)).toBeNull();
  });

  it('says when a token was last used', () => {
    const now = Date.parse('2026-10-14T12:00:00Z');
    expect(lastUsed(null, now)).toBe('never used');
    expect(lastUsed('2026-10-14T11:59:30Z', now)).toBe('used just now');
    expect(lastUsed('2026-10-14T11:00:00Z', now)).toBe('used 60 minutes ago');
    expect(lastUsed('2026-10-13T12:00:00Z', now)).toBe('used 24 hours ago');
    expect(lastUsed('2026-10-01T12:00:00Z', now)).toBe('used 13 days ago');
  });

  it('groups an MFA key for typing by hand', () => {
    expect(groupSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
  });

  it('describes where MFA comes from', () => {
    expect(mfaSummary('environment')).toMatch(/\.env/);
    expect(mfaSummary('database')).toBe('On');
    expect(mfaSummary('unset')).toBe('Off');
  });

  it('names a browser from its User-Agent', () => {
    expect(
      describeBrowser(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0'
      )
    ).toBe('Edge on Windows');
    expect(
      describeBrowser(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'
      )
    ).toBe('Chrome on Linux');
    expect(
      describeBrowser(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
      )
    ).toBe('Safari on macOS');
    expect(
      describeBrowser('Mozilla/5.0 (Android 15; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0')
    ).toBe('Firefox on Android');
    expect(describeBrowser('curl/8.5.0')).toBe('curl');
    expect(describeBrowser(null)).toBe('Unknown browser');
  });

  it('says when a session was started', () => {
    const now = Date.parse('2026-10-14T12:00:00Z');
    expect(signedIn('2026-10-14T11:59:30Z', now)).toBe('signed in just now');
    expect(signedIn('2026-10-14T09:00:00Z', now)).toBe('signed in 3 hours ago');
    expect(signedIn('2026-10-10T12:00:00Z', now)).toBe('signed in 4 days ago');
  });
});
