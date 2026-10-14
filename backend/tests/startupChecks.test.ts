import { checkStartupConfig, heartbeatWarnings } from '../src/services/startupChecks.js';

const GOOD_PRODUCTION = {
  NODE_ENV: 'production',
  APP_PASSWORD: 'a-long-enough-password',
  SESSION_SECRET: 'x'.repeat(64),
  API_TOKEN: 'y'.repeat(64),
  BROKER_SERVICE_TOKEN: 'z'.repeat(64),
  POSTGRES_PASSWORD: 'p'.repeat(32),
  REDIS_PASSWORD: 'r'.repeat(32),
  SETTINGS_ENCRYPTION_KEY: 'e'.repeat(64),
};

describe('checkStartupConfig', () => {
  it('passes a complete production configuration', () => {
    expect(checkStartupConfig(GOOD_PRODUCTION)).toEqual({ errors: [], warnings: [] });
  });

  it('checks the settings encryption key', () => {
    const missing = checkStartupConfig({ ...GOOD_PRODUCTION, SETTINGS_ENCRYPTION_KEY: '' });
    expect(missing.errors).toEqual([]);
    expect(missing.warnings.join(' ')).toMatch(/SETTINGS_ENCRYPTION_KEY/);
    const malformed = { ...GOOD_PRODUCTION, SETTINGS_ENCRYPTION_KEY: 'CHANGE_ME' };
    expect(checkStartupConfig(malformed).errors.join(' ')).toMatch(/SETTINGS_ENCRYPTION_KEY/);
    const devMalformed = checkStartupConfig({ SETTINGS_ENCRYPTION_KEY: 'CHANGE_ME' });
    expect(devMalformed.errors).toEqual([]);
    expect(devMalformed.warnings.join(' ')).toMatch(/SETTINGS_ENCRYPTION_KEY/);
  });

  it('lets development run with an empty environment', () => {
    expect(checkStartupConfig({}).errors).toEqual([]);
  });

  it('starts production with no password or token in .env (they are set in the app)', () => {
    const { errors } = checkStartupConfig({
      ...GOOD_PRODUCTION,
      APP_PASSWORD: '',
      API_TOKEN: '',
      SESSION_SECRET: '',
    });
    expect(errors).toEqual([]);
  });

  it.each([
    ['API_TOKEN', 'CHANGE_ME'],
    ['SESSION_SECRET', 'changeme_session_secret'],
    ['BROKER_SERVICE_TOKEN', ''],
    ['POSTGRES_PASSWORD', 'tradingapp123'],
    ['APP_PASSWORD', 'short'],
  ])('refuses production when %s is %p', (key, value) => {
    const { errors } = checkStartupConfig({ ...GOOD_PRODUCTION, [key]: value });
    expect(errors.some((e) => e.includes(key))).toBe(true);
  });

  it('warns but starts when Redis has no password', () => {
    const { errors, warnings } = checkStartupConfig({ ...GOOD_PRODUCTION, REDIS_PASSWORD: '' });
    expect(errors).toEqual([]);
    expect(warnings.join(' ')).toMatch(/REDIS_PASSWORD/);
  });

  it('leaves live trading without safeguards to the gate, which stays closed', () => {
    // The trader role and MFA can be set up in the app after startup, so this
    // is checked per order (orderTypes.isLiveTradingEnabled), not here.
    expect(checkStartupConfig({ LIVE_TRADING_ENABLED: 'true' }).errors).toEqual([]);
  });

  it('refuses a KILL_SWITCH_ACTION that is not an action', () => {
    const { errors } = checkStartupConfig({ KILL_SWITCH_ACTION: 'bogus' });
    expect(errors.join(' ')).toMatch(/KILL_SWITCH_ACTION/);
  });

  it.each(['notify', 'halt', 'flatten'])('accepts KILL_SWITCH_ACTION=%s', (action) => {
    expect(checkStartupConfig({ KILL_SWITCH_ACTION: action }).errors).toEqual([]);
  });

  it('warns when orders run unattended with no heartbeat, and checks heartbeat URLs', () => {
    expect(heartbeatWarnings({ SYSTEMATIC_EXECUTION_ENABLED: 'true' }).join(' ')).toMatch(
      /no heartbeat URL/
    );
    expect(
      heartbeatWarnings({
        SYSTEMATIC_EXECUTION_ENABLED: 'true',
        HEARTBEAT_URL: 'https://hc-ping.com/abc',
      })
    ).toEqual([]);
    expect(heartbeatWarnings({})).toEqual([]);
    expect(checkStartupConfig({ HEARTBEAT_URL: 'hc-ping.com/abc' }).errors.join(' ')).toMatch(
      /HEARTBEAT_URL must be an http\(s\) URL/
    );
  });

  it('refuses an invalid TRADING_DAY_TIMEZONE and accepts a real one', () => {
    expect(checkStartupConfig({ TRADING_DAY_TIMEZONE: 'Mars/Olympus' }).errors.join(' ')).toMatch(
      /TRADING_DAY_TIMEZONE/
    );
    expect(checkStartupConfig({ TRADING_DAY_TIMEZONE: 'Europe/Athens' }).errors).toEqual([]);
  });

  it('refuses unreadable prop rules and accepts valid ones', () => {
    expect(
      checkStartupConfig({ PROP_RULES__MT5_FTMO: '{"initial_balance":0}' }).errors.join(' ')
    ).toMatch(/PROP_RULES__MT5_FTMO needs initial_balance/);
    expect(
      checkStartupConfig({
        PROP_RULES__MT5_FTMO: '{"initial_balance":100000,"daily_loss":{"pct":5}}',
      }).errors
    ).toEqual([]);
  });

  it('warns about a leftover NEXT_PUBLIC_API_TOKEN', () => {
    const { warnings } = checkStartupConfig({ NEXT_PUBLIC_API_TOKEN: 'old' });
    expect(warnings.join(' ')).toMatch(/rotate API_TOKEN/);
  });
});
