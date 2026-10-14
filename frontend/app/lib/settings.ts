/**
 * Types and pure helpers for the Settings page (`/settings`), kept out of the
 * component so they can be unit-tested.
 */

export type SettingSource = 'environment' | 'database' | 'default' | 'unset';

export interface SettingView {
  key: string;
  section: string;
  label: string;
  type: 'boolean' | 'integer' | 'number' | 'string' | 'url' | 'enum' | 'json';
  options?: string[];
  min?: number;
  max?: number;
  default: string | null;
  secret: boolean;
  apply: 'immediate' | 'reload' | 'restart';
  step_up: boolean;
  /** The direction that needs no step-up (turning off, a lower cap, ...). */
  safer?: 'off' | 'lower' | 'higher' | 'later-option' | null;
  editable: boolean;
  help: string;
  source: SettingSource;
  value: string | null;
  is_set: boolean;
  locked: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

export interface SettingsPayload {
  sections: { id: string; title: string }[];
  settings: SettingView[];
  status: { loaded_at: string | null; error: string | null; encryption_key: boolean };
  auth: { trading_auth_required: boolean; mfa_required: boolean };
}

export interface AuditEntry {
  id: number;
  key: string;
  action: string;
  old_value: string | null;
  new_value: string | null;
  changed_by: string | null;
  source_ip: string | null;
  reason: string | null;
  changed_at: string;
}

/** Settings grouped by section, in the section order the API gives. */
export function groupBySection(
  payload: SettingsPayload
): { id: string; title: string; settings: SettingView[] }[] {
  return payload.sections
    .map((section) => ({
      ...section,
      settings: payload.settings.filter((s) => s.section === section.id),
    }))
    .filter((group) => group.settings.length > 0);
}

/** A short badge describing where the value in effect comes from. */
export function sourceLabel(setting: SettingView): string {
  switch (setting.source) {
    case 'environment':
      return 'Set in .env';
    case 'database':
      return 'Saved here';
    case 'default':
      return 'Default';
    default:
      return 'Not set';
  }
}

export function applyLabel(apply: SettingView['apply']): string {
  if (apply === 'immediate') return 'Applies immediately';
  if (apply === 'reload') return 'Applies on the next cycle';
  return 'Needs a restart';
}

/** What the value column shows. Secrets show only whether they are set. */
export function displayValue(setting: SettingView): string {
  if (setting.secret) return setting.is_set ? 'Set (hidden)' : 'Not set';
  if (setting.value === null || setting.value === '') return 'Not set';
  return setting.value;
}

/** Why a setting cannot be changed from the page, or null when it can. */
export function readOnlyReason(setting: SettingView): string | null {
  if (setting.locked) return `Set in .env. Remove ${setting.key} there to manage it here.`;
  if (!setting.editable) return 'Still read from .env; editable in a later release.';
  return null;
}

/** Headers for a protected change, mirroring the order ticket. */
export function stepUpHeaders(
  setting: SettingView,
  auth: SettingsPayload['auth'],
  tradingToken: string,
  mfaCode: string
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!setting.step_up) return headers;
  if (auth.trading_auth_required && tradingToken.trim()) {
    headers['X-Trading-Token'] = tradingToken.trim();
  }
  if (auth.mfa_required && mfaCode.trim()) {
    headers['X-MFA-Code'] = mfaCode.trim();
  }
  return headers;
}

/** The badge on a protected setting: which change needs the token and MFA. */
export function protectedLabel(setting: SettingView): string {
  switch (setting.safer) {
    case 'off':
      return 'Protected to turn on';
    case 'lower':
      return 'Protected to raise or remove';
    case 'higher':
      return 'Protected to lower';
    case 'later-option':
      return 'Protected to relax';
    default:
      return 'Protected';
  }
}

/** The word to type before live trading is turned on. */
export const LIVE_CONFIRM_WORD = 'LIVE';

/** Whether saving `value` turns live trading on, so the page asks for LIVE first. */
export function needsLiveConfirm(setting: SettingView, value: string | undefined): boolean {
  return setting.key === 'LIVE_TRADING_ENABLED' && value === 'true' && setting.value !== 'true';
}
