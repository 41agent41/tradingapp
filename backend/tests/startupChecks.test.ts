import { checkStartupConfig } from '../src/services/startupChecks.js';

const GOOD_PRODUCTION = {
  NODE_ENV: 'production',
  APP_PASSWORD: 'a-long-enough-password',
  SESSION_SECRET: 'x'.repeat(64),
  API_TOKEN: 'y'.repeat(64),
  BROKER_SERVICE_TOKEN: 'z'.repeat(64),
  POSTGRES_PASSWORD: 'p'.repeat(32),
  REDIS_PASSWORD: 'r'.repeat(32),
};

describe('checkStartupConfig', () => {
  it('passes a complete production configuration', () => {
    expect(checkStartupConfig(GOOD_PRODUCTION)).toEqual({ errors: [], warnings: [] });
  });

  it('lets development run with an empty environment', () => {
    expect(checkStartupConfig({}).errors).toEqual([]);
  });

  it('refuses production with no authentication', () => {
    const { errors } = checkStartupConfig({
      ...GOOD_PRODUCTION,
      APP_PASSWORD: '',
      API_TOKEN: '',
    });
    expect(errors.join(' ')).toMatch(/APP_PASSWORD .*API_TOKEN/);
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

  it('refuses live trading without the trader role and MFA, in any environment', () => {
    const { errors } = checkStartupConfig({ LIVE_TRADING_ENABLED: 'true' });
    expect(errors.join(' ')).toMatch(/TRADING_TOKENS/);
    expect(errors.join(' ')).toMatch(/ORDER_MFA_SECRET/);

    const ok = checkStartupConfig({
      LIVE_TRADING_ENABLED: 'true',
      TRADING_TOKENS: 'abc',
      ORDER_MFA_SECRET: 'JBSWY3DPEHPK3PXP',
    });
    expect(ok.errors).toEqual([]);
  });

  it.each(['flatten', 'bogus'])(
    'refuses KILL_SWITCH_ACTION=%s because it is not implemented',
    (action) => {
      const { errors } = checkStartupConfig({ KILL_SWITCH_ACTION: action });
      expect(errors.join(' ')).toMatch(/KILL_SWITCH_ACTION/);
    }
  );

  it.each(['notify', 'halt'])('accepts KILL_SWITCH_ACTION=%s', (action) => {
    expect(checkStartupConfig({ KILL_SWITCH_ACTION: action }).errors).toEqual([]);
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
