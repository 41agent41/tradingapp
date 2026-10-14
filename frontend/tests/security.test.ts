import { describe, expect, it } from 'vitest';

import { groupSecret, lastUsed, mfaSummary, passwordProblem } from '../app/lib/security';

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
});
