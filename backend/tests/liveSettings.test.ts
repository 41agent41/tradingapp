/**
 * Settings the Settings page can change without a restart: how each consumer
 * reads them, and how the loops that read them once take a new value.
 */
import { definedOnly, readBool, readInt } from '../src/config/read.js';
import { normalizeValue, settingDef } from '../src/config/registry.js';
import { BackfillScheduler, backfillSettings } from '../src/services/backfillScheduler.js';
import {
  ExecutionsPoller,
  defaultAccountMode,
  executionsSettings,
} from '../src/services/executionsPoller.js';
import { StrategyRunner, runnerSettings } from '../src/services/strategyRunner.js';
import { Heartbeat, heartbeatOptionsFromEnv } from '../src/services/heartbeat.js';
import { Notifier, TelegramChannel } from '../src/services/notifier.js';

describe('read helpers', () => {
  it('falls back on unset or unparsable values and clamps, keeping an explicit 0', () => {
    expect(readInt({}, 'K', 15, 1)).toBe(15);
    expect(readInt({ K: 'abc' }, 'K', 15, 1)).toBe(15);
    expect(readInt({ K: '0' }, 'K', 30000, 0)).toBe(0);
    expect(readInt({ K: '0' }, 'K', 15, 1)).toBe(1);
    expect(readInt({ K: '90' }, 'K', 2, 1, 30)).toBe(30);
  });

  it('reads booleans the way the services always have', () => {
    expect(readBool({}, 'K', false)).toBe(false);
    expect(readBool({ K: 'TRUE' }, 'K', false)).toBe(true);
    expect(readBool({ K: 'yes' }, 'K', false)).toBe(false);
    expect(readBool({}, 'K', true)).toBe(true);
    expect(readBool({ K: 'false' }, 'K', true)).toBe(false);
    expect(readBool({ K: 'anything' }, 'K', true)).toBe(true);
  });

  it('keeps only the setting values a caller passed', () => {
    expect(definedOnly({ enabled: true, period: undefined, deps: {}, emit: () => 1 })).toEqual({
      enabled: true,
    });
  });
});

describe('settings readers', () => {
  it('backfill', () => {
    expect(backfillSettings({})).toEqual({
      enabled: false,
      intervalMinutes: 15,
      period: '5D',
      initialDelayMs: 30000,
    });
    expect(backfillSettings({ BACKFILL_ENABLED: 'true', BACKFILL_PERIOD: '1D' })).toMatchObject({
      enabled: true,
      period: '1D',
    });
  });

  it('executions, with the unmatched-fill mode read per pass', () => {
    expect(executionsSettings({ EXECUTIONS_SYNC_LOOKBACK_DAYS: '99' })).toMatchObject({
      enabled: false,
      intervalSeconds: 120,
      lookbackDays: 30,
    });
    expect(defaultAccountMode({})).toBe('paper');
    expect(defaultAccountMode({ EXECUTIONS_DEFAULT_ACCOUNT_MODE: 'LIVE' })).toBe('live');
  });

  it('strategy runner, with its minimums', () => {
    expect(
      runnerSettings({
        SYSTEMATIC_INTERVAL_SECONDS: '1',
        SYSTEMATIC_CONNECTION_BREAKER_COOLDOWN_SECONDS: '2',
      })
    ).toEqual({
      enabled: false,
      intervalSeconds: 5,
      initialDelayMs: 15000,
      maxConnectionConcurrency: 4,
      breakerThreshold: 3,
      breakerCooldownSeconds: 10,
    });
  });
});

describe('reconfigure', () => {
  it('backfill: stops, takes the new values, and starts again only when asked', () => {
    const listConfigs = jest.fn(async () => []);
    const scheduler = new BackfillScheduler({ enabled: false, deps: { listConfigs } as any });
    scheduler.reconfigure({ enabled: true, intervalMinutes: 5, period: '1D' });
    expect(scheduler.status()).toMatchObject({ enabled: true, interval_minutes: 5, period: '1D' });
    scheduler.start();
    scheduler.reconfigure({ enabled: false });
    expect(scheduler.status().enabled).toBe(false);
    scheduler.stop();
  });

  it('executions poller', () => {
    const poller = new ExecutionsPoller({ enabled: false, deps: {} as any });
    poller.reconfigure({ enabled: true, intervalSeconds: 60, lookbackDays: 3 });
    expect(poller.status()).toMatchObject({
      enabled: true,
      interval_seconds: 60,
      lookback_days: 3,
    });
    poller.stop();
  });

  it('strategy runner', () => {
    const runner = new StrategyRunner({ enabled: false, deps: {} as any });
    runner.reconfigure({ enabled: true, intervalSeconds: 30 });
    expect(runner.status()).toMatchObject({ enabled: true, interval_seconds: 30 });
    runner.stop();
  });

  it('heartbeat: a URL set later turns it on', () => {
    const probe = {
      database: async () => true,
      brokerService: async () => true,
      runner: () => null,
    };
    const ping = jest.fn(async () => undefined);
    const hb = new Heartbeat(probe, { ...heartbeatOptionsFromEnv({}), ping });
    expect(hb.enabled).toBe(false);
    hb.reconfigure(
      heartbeatOptionsFromEnv({
        HEARTBEAT_URL: 'https://hc-ping.com/abc',
        HEARTBEAT_INTERVAL_SECONDS: '30',
      })
    );
    expect(hb.status()).toMatchObject({ enabled: true, interval_seconds: 30 });
  });
});

describe('alerts read their settings on every use', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'ALERT_MAX_PER_HOUR']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('picks up Telegram credentials set after the notifier was built', () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    const notifier = new Notifier();
    expect(notifier.enabled).toBe(false);
    process.env.TELEGRAM_BOT_TOKEN = '123:abc';
    process.env.TELEGRAM_CHAT_ID = '42';
    expect(notifier.enabled).toBe(true);
    expect(notifier.status()).toMatchObject({ channels: ['telegram'] });
  });

  it('reads the rate limit per alert', () => {
    process.env.ALERT_MAX_PER_HOUR = '7';
    expect(new Notifier({ channels: [] }).status()).toMatchObject({ max_per_hour: 7 });
  });

  it('builds a channel only when both values are set', () => {
    expect(TelegramChannel.fromEnv({ TELEGRAM_BOT_TOKEN: 'x' })).toBeNull();
    expect(
      TelegramChannel.fromEnv({ TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: '1' })
    ).not.toBeNull();
  });
});

describe('url settings', () => {
  it('accept http(s) only', () => {
    const def = settingDef('HEARTBEAT_URL')!;
    expect(normalizeValue(def, ' https://hc-ping.com/abc ')).toBe('https://hc-ping.com/abc');
    expect(() => normalizeValue(def, 'hc-ping.com/abc')).toThrow(/http\(s\) URL/);
    expect(() => normalizeValue(def, 'ftp://example.com')).toThrow(/http\(s\) URL/);
  });
});
