import { describe, expect, it } from 'vitest';

import {
  type SettingView,
  type SettingsPayload,
  displayValue,
  groupBySection,
  readOnlyReason,
  sourceLabel,
  stepUpHeaders,
} from '../app/lib/settings';

function setting(overrides: Partial<SettingView> = {}): SettingView {
  return {
    key: 'PROMOTION_MIN_TRADES',
    section: 'strategies',
    label: 'Minimum backtest trades',
    type: 'integer',
    default: '30',
    secret: false,
    apply: 'immediate',
    step_up: true,
    editable: true,
    help: '',
    source: 'default',
    value: '30',
    is_set: false,
    locked: false,
    updated_at: null,
    updated_by: null,
    ...overrides,
  };
}

const auth = { trading_auth_required: true, mfa_required: true };

describe('settings helpers', () => {
  it('groups settings by section in API order and drops empty sections', () => {
    const payload: SettingsPayload = {
      sections: [
        { id: 'trading', title: 'Trading' },
        { id: 'strategies', title: 'Strategies' },
        { id: 'network', title: 'Network' },
      ],
      settings: [setting(), setting({ key: 'LIVE_TRADING_ENABLED', section: 'trading' })],
      status: { loaded_at: null, error: null, encryption_key: true },
      auth,
    };
    expect(groupBySection(payload).map((g) => [g.id, g.settings.length])).toEqual([
      ['trading', 1],
      ['strategies', 1],
    ]);
  });

  it('never shows a secret value', () => {
    expect(displayValue(setting({ secret: true, is_set: true, value: null }))).toBe('Set (hidden)');
    expect(displayValue(setting({ secret: true, is_set: false, value: null }))).toBe('Not set');
  });

  it('explains why a setting is read-only', () => {
    expect(readOnlyReason(setting())).toBeNull();
    expect(readOnlyReason(setting({ locked: true, source: 'environment' }))).toMatch(/\.env/);
    expect(readOnlyReason(setting({ editable: false }))).toMatch(/later release/);
    expect(sourceLabel(setting({ source: 'database' }))).toBe('Saved here');
  });

  it('sends step-up headers only for protected settings', () => {
    expect(stepUpHeaders(setting(), auth, ' tok ', '123456')).toEqual({
      'X-Trading-Token': 'tok',
      'X-MFA-Code': '123456',
    });
    expect(stepUpHeaders(setting({ step_up: false }), auth, 'tok', '123456')).toEqual({});
    expect(
      stepUpHeaders(setting(), { trading_auth_required: false, mfa_required: false }, 'tok', '1')
    ).toEqual({});
  });
});
