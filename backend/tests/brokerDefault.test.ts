/**
 * Broker priority: the default broker follows the broker service's choice
 * (DEFAULT_BROKER, else the highest-priority configured broker), and
 * persisted rows with no broker keep meaning IB.
 */
import {
  BROKER_PRIORITY,
  LEGACY_BROKER,
  connectionOf,
  defaultBroker,
  setResolvedDefaultBroker,
} from '../src/services/orderTypes.js';
import { refreshDefaultBroker } from '../src/services/brokerDefault.js';

describe('broker priority', () => {
  const saved = process.env.DEFAULT_BROKER;
  afterEach(() => {
    if (saved === undefined) delete process.env.DEFAULT_BROKER;
    else process.env.DEFAULT_BROKER = saved;
  });

  it('ranks API brokers, then MT5, IB and Alpaca', () => {
    expect(BROKER_PRIORITY).toEqual(['oanda', 'mt5', 'ib', 'alpaca']);
  });

  it('defaults to the top of the list before the broker service answers', () => {
    delete process.env.DEFAULT_BROKER;
    expect(defaultBroker()).toBe('oanda');
  });

  it("follows the broker service's choice", () => {
    delete process.env.DEFAULT_BROKER;
    setResolvedDefaultBroker('ib');
    expect(defaultBroker()).toBe('ib');
  });

  it('ignores anything that is not a broker', () => {
    delete process.env.DEFAULT_BROKER;
    setResolvedDefaultBroker('mt5');
    setResolvedDefaultBroker('robinhood');
    setResolvedDefaultBroker(undefined);
    expect(defaultBroker()).toBe('mt5');
  });

  it('lets DEFAULT_BROKER override', () => {
    setResolvedDefaultBroker('oanda');
    process.env.DEFAULT_BROKER = 'alpaca';
    expect(defaultBroker()).toBe('alpaca');
    process.env.DEFAULT_BROKER = 'nonsense';
    expect(defaultBroker()).toBe('oanda');
  });

  it('reads a persisted row with no broker as IB', () => {
    setResolvedDefaultBroker('oanda');
    expect(LEGACY_BROKER).toBe('ib');
    expect(connectionOf({}).broker).toBe('ib');
  });
});

describe('refreshDefaultBroker', () => {
  beforeEach(() => {
    delete process.env.DEFAULT_BROKER;
  });

  it("takes providers.default from the broker service's /health", async () => {
    const get = jest.fn().mockResolvedValue({ data: { providers: { default: 'mt5' } } });
    await refreshDefaultBroker('http://bs:8000', get);
    expect(get).toHaveBeenCalledWith('http://bs:8000/health');
    expect(defaultBroker()).toBe('mt5');
  });

  it('keeps the last good value when the broker service is unreachable', async () => {
    await refreshDefaultBroker('http://bs:8000', async () => ({
      data: { providers: { default: 'ib' } },
    }));
    await refreshDefaultBroker('http://bs:8000', async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(defaultBroker()).toBe('ib');
  });
});
