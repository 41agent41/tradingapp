/**
 * What a connection supports (E-19): finding the connection a chart names,
 * the timeframes to offer for it, and the line Settings shows.
 */
import { describe, expect, it } from 'vitest';

import {
  describeCapabilities,
  describeLink,
  findConnection,
  supportedTimeframes,
  type LiveConnection,
} from '../app/lib/brokerConnections';

const connection = (over: Partial<LiveConnection>): LiveConnection => ({
  label: 'oanda:default',
  platform: 'oanda',
  account: 'default',
  account_mode: 'paper',
  is_default: true,
  check: null,
  ...over,
});

const CONNECTIONS = [
  connection({ capabilities: { timeframes: ['1min', '1hour', '8hour', '1day'] } }),
  connection({ label: 'ig:demo', platform: 'ig', account: 'demo', is_default: false }),
  connection({ label: 'mt5:a', platform: 'mt5', account: 'a', is_default: false }),
  connection({ label: 'mt5:b', platform: 'mt5', account: 'b', is_default: true }),
];

describe('findConnection', () => {
  it('finds a connection by platform and account', () => {
    expect(findConnection(CONNECTIONS, 'mt5', 'a')?.label).toBe('mt5:a');
    expect(findConnection(CONNECTIONS, 'mt5', 'nope')).toBeNull();
  });

  it("takes the platform's default account when none is named", () => {
    expect(findConnection(CONNECTIONS, 'mt5', '')?.label).toBe('mt5:b');
    // The only account on a platform is the one meant.
    expect(findConnection(CONNECTIONS, 'ig', undefined)?.label).toBe('ig:demo');
  });

  it('finds nothing when the broker priority decides', () => {
    expect(findConnection(CONNECTIONS, '', '')).toBeNull();
    expect(findConnection(CONNECTIONS, undefined, undefined)).toBeNull();
  });
});

describe('supportedTimeframes', () => {
  it("gives the connection's timeframes", () => {
    expect(supportedTimeframes(CONNECTIONS[0])).toEqual(['1min', '1hour', '8hour', '1day']);
  });

  it('gives null, meaning all, when nothing is known', () => {
    expect(supportedTimeframes(null)).toBeNull();
    expect(supportedTimeframes(CONNECTIONS[1])).toBeNull();
    expect(supportedTimeframes(connection({ capabilities: { timeframes: [] } }))).toBeNull();
  });
});

describe('describeCapabilities', () => {
  it('says nothing when the connection does not report', () => {
    expect(describeCapabilities(undefined)).toBeNull();
    expect(describeCapabilities({})).toBeNull();
  });

  it('describes a connection that trades', () => {
    expect(
      describeCapabilities({
        market_data: true,
        trading: true,
        timeframes: ['1min', '1hour', '1day'],
        live_prices: 'stream',
        spread_bars: true,
        order_types: { MKT: ['FOK'], LMT: ['GTC'], STP_LMT: ['GTC'] },
        attaches_stops: true,
        fills: 'signal',
      })
    ).toBe(
      'Bars: 1m, 1h, 1d · prices streamed · bars carry the spread · ' +
        'orders: MKT, LMT, STP LMT · stop attached to the entry · fills pushed'
    );
  });

  it('describes a data-only connection without order lines', () => {
    expect(
      describeCapabilities({
        market_data: true,
        trading: false,
        timeframes: ['tick'],
        live_prices: 'poll',
      })
    ).toBe('Bars: tick · prices polled');
  });
});

describe('describeLink', () => {
  const at = { host: '10.0.0.20', port: 9100 };

  it('says nothing for a broker on the internet or on the app server itself', () => {
    expect(describeLink('oanda', null)).toBeNull();
    expect(describeLink('mt5', undefined)).toBeNull();
    expect(describeLink('mt5', { ...at, security: 'loopback' })).toBeNull();
  });

  it('says when the link is encrypted', () => {
    expect(describeLink('mt5', { ...at, security: 'tls_pinned' })).toEqual({
      tone: 'ok',
      text: 'Encrypted to 10.0.0.20:9100, certificate pinned',
    });
    expect(describeLink('mt5', { ...at, security: 'tls' })?.tone).toBe('ok');
  });

  it('warns when the secret and orders cross the network in the clear', () => {
    const mt5 = describeLink('mt5', { ...at, security: 'plain' });
    expect(mt5?.tone).toBe('warn');
    expect(mt5?.text).toMatch(/Not encrypted to 10\.0\.0\.20:9100.*Turn TLS on at the sidecar/);
    const ib = describeLink('ib', { host: '10.0.0.30', port: 4002, security: 'plain' });
    expect(ib?.tone).toBe('warn');
    expect(ib?.text).toMatch(/IB Gateway has no TLS.*firewalled/);
  });
});
