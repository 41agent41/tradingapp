/**
 * Broker connection status: the broker service's checks, ordered by broker
 * priority, and the one problem the heartbeat pages for.
 */
import { brokersFromHealth, defaultBrokerProblem } from '../src/services/brokerStatus.js';
import { heartbeatProblems } from '../src/services/heartbeat.js';

const providers = {
  default: 'oanda',
  connections: {
    'ib:default': {
      platform: 'ib',
      account: 'default',
      account_mode: 'paper',
      is_default: true,
      check: { status: 'unreachable', error: 'refused', latency_ms: 3, checked_at: 't1' },
    },
    'oanda:default': {
      platform: 'oanda',
      account: 'default',
      account_mode: 'paper',
      is_default: true,
      check: { status: 'connected', error: null, latency_ms: 120, checked_at: 't1' },
    },
    'mt5:demo': {
      platform: 'mt5',
      account: 'demo',
      account_mode: 'paper',
      is_default: true,
      check: null,
    },
  },
};

describe('brokersFromHealth', () => {
  it('orders connections by broker priority and marks the default', () => {
    const s = brokersFromHealth(providers);
    expect(s.default).toBe('oanda');
    expect(s.connections.map((c) => c.label)).toEqual(['oanda:default', 'mt5:demo', 'ib:default']);
    expect(s.connections.map((c) => c.is_default)).toEqual([true, false, false]);
  });

  it('reports a connection not checked yet as unchecked', () => {
    const mt5 = brokersFromHealth(providers).connections.find((c) => c.platform === 'mt5');
    expect(mt5?.status).toBe('unchecked');
    expect(mt5?.checked_at).toBeNull();
  });

  it('is empty when nothing is configured or the payload is missing', () => {
    expect(brokersFromHealth({ default: 'oanda', connections: {} }).connections).toEqual([]);
    expect(brokersFromHealth(undefined)).toEqual({ default: null, connections: [] });
  });
});

describe('defaultBrokerProblem', () => {
  it('is null while the default broker is connected, even with others down', () => {
    expect(defaultBrokerProblem(brokersFromHealth(providers))).toBeNull();
  });

  it('names the default broker when its check failed', () => {
    const down = { ...providers, default: 'ib' };
    expect(defaultBrokerProblem(brokersFromHealth(down))).toBe(
      'default broker ib:default unreachable: refused'
    );
  });

  it('is null for a default broker not checked yet', () => {
    expect(defaultBrokerProblem(brokersFromHealth({ ...providers, default: 'mt5' }))).toBeNull();
  });
});

describe('heartbeatProblems with the default broker', () => {
  const T0 = Date.parse('2026-10-13T00:00:00Z');
  const base = { database: true, brokerService: true, runner: null, now: T0, since: T0 };

  it('reports the default broker problem', () => {
    expect(heartbeatProblems({ ...base, defaultBroker: 'default broker x unreachable' })).toEqual([
      'default broker x unreachable',
    ]);
  });

  it('reports only the broker service when that is down', () => {
    expect(
      heartbeatProblems({ ...base, brokerService: false, defaultBroker: 'default broker x' })
    ).toEqual(['broker service unreachable']);
  });
});
