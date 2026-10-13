/**
 * Dead-man's switch: an outbound heartbeat to a monitor off the host.
 */
import {
  Heartbeat,
  heartbeatOptionsFromEnv,
  heartbeatProblems,
} from '../src/services/heartbeat.js';

const T0 = Date.parse('2026-10-13T00:00:00Z');

describe('heartbeatProblems', () => {
  const healthy = {
    database: true,
    brokerService: true,
    runner: { enabled: true, intervalSeconds: 60, lastRunAt: T0 - 30_000 },
    now: T0,
    since: T0 - 3_600_000,
  };

  it('is empty when the app can trade', () => {
    expect(heartbeatProblems(healthy)).toEqual([]);
  });

  it('names each thing that is down', () => {
    expect(heartbeatProblems({ ...healthy, database: false, brokerService: false })).toEqual([
      'database unreachable',
      'broker service unreachable',
    ]);
  });

  it('flags a runner that has missed three passes, but not one slow pass', () => {
    const at = (secondsAgo: number) => ({
      ...healthy,
      runner: { enabled: true, intervalSeconds: 60, lastRunAt: T0 - secondsAgo * 1000 },
    });
    expect(heartbeatProblems(at(170))).toEqual([]);
    expect(heartbeatProblems(at(181))).toEqual(['strategy runner last completed a pass 181s ago']);
  });

  it('gives a runner that never started a grace period from startup, then flags it', () => {
    const never = { enabled: true, intervalSeconds: 60, lastRunAt: null };
    expect(heartbeatProblems({ ...healthy, runner: never, since: T0 - 60_000 })).toEqual([]);
    expect(heartbeatProblems({ ...healthy, runner: never, since: T0 - 600_000 })).toEqual([
      'strategy runner has not completed a pass since startup',
    ]);
  });

  it('ignores a runner that is switched off', () => {
    expect(
      heartbeatProblems({
        ...healthy,
        runner: { enabled: false, intervalSeconds: 60, lastRunAt: null },
        since: T0 - 3_600_000,
      })
    ).toEqual([]);
  });
});

describe('Heartbeat.beat', () => {
  function make(
    probe: Partial<Parameters<typeof makeProbe>[0]> = {},
    failUrl: string | null = null
  ) {
    const ping = jest.fn().mockResolvedValue(undefined);
    const heartbeat = new Heartbeat(makeProbe(probe), {
      url: 'https://hc-ping.com/abc',
      failUrl,
      intervalSeconds: 60,
      now: () => T0,
      ping,
    });
    return { heartbeat, ping };
  }
  function makeProbe(o: { database?: boolean; brokerService?: boolean } = {}) {
    return {
      database: async () => o.database ?? true,
      brokerService: async () => {
        if (o.brokerService === false) throw new Error('ECONNREFUSED');
        return true;
      },
      runner: () => ({ enabled: true, intervalSeconds: 60, lastRunAt: T0 - 10_000 }),
    };
  }

  it('pings the monitor when healthy', async () => {
    const { heartbeat, ping } = make();
    await heartbeat.beat();
    expect(ping).toHaveBeenCalledWith('https://hc-ping.com/abc');
    expect(heartbeat.status()).toEqual(
      expect.objectContaining({
        last_result: 'ok',
        problems: [],
        last_ping_at: '2026-10-13T00:00:00.000Z',
      })
    );
  });

  it('stays silent when something is down and no fail URL is set', async () => {
    const { heartbeat, ping } = make({ brokerService: false });
    await heartbeat.beat();
    expect(ping).not.toHaveBeenCalled();
    expect(heartbeat.status()).toEqual(
      expect.objectContaining({ last_result: 'silent', problems: ['broker service unreachable'] })
    );
  });

  it('pings the fail URL when something is down and one is set', async () => {
    const { heartbeat, ping } = make({ database: false }, 'https://hc-ping.com/abc/fail');
    await heartbeat.beat();
    expect(ping).toHaveBeenCalledWith('https://hc-ping.com/abc/fail', 'database unreachable');
    expect(heartbeat.status().last_result).toBe('fail');
  });

  it('records a ping that could not be sent', async () => {
    const ping = jest.fn().mockRejectedValue(new Error('timeout'));
    const heartbeat = new Heartbeat(makeProbe(), {
      url: 'https://hc-ping.com/abc',
      failUrl: null,
      intervalSeconds: 60,
      now: () => T0,
      ping,
    });
    await heartbeat.beat();
    expect(heartbeat.status()).toEqual(
      expect.objectContaining({ last_result: 'error', last_error: 'timeout' })
    );
  });
});

describe('heartbeatOptionsFromEnv', () => {
  it('is off without a URL, and defaults the interval to a minute', () => {
    expect(heartbeatOptionsFromEnv({})).toEqual({ url: null, failUrl: null, intervalSeconds: 60 });
    expect(
      heartbeatOptionsFromEnv({ HEARTBEAT_URL: ' https://x/1 ', HEARTBEAT_INTERVAL_SECONDS: '5' })
    ).toEqual({ url: 'https://x/1', failUrl: null, intervalSeconds: 60 });
    expect(heartbeatOptionsFromEnv({ HEARTBEAT_INTERVAL_SECONDS: '120' }).intervalSeconds).toBe(
      120
    );
  });
});
