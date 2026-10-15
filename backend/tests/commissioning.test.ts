/**
 * The Getting started checklist: each item ticks itself from state, and says
 * what is still missing when it is not done.
 */
import axios from 'axios';

import {
  checklist,
  loadChecklistState,
  type ChecklistState,
} from '../src/services/commissioning.js';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const SAVED_ENV: NodeJS.ProcessEnv = { ...process.env };

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED_ENV)) delete process.env[k];
  }
  Object.assign(process.env, SAVED_ENV);
  jest.resetAllMocks();
});

const FRESH: ChecklistState = {
  passwordSet: false,
  tradingToken: false,
  mfa: false,
  connections: 0,
  collecting: 0,
  backfillEnabled: false,
  telegram: false,
  heartbeat: false,
};

const READY: ChecklistState = {
  passwordSet: true,
  tradingToken: true,
  mfa: true,
  connections: 2,
  collecting: 3,
  backfillEnabled: true,
  telegram: true,
  heartbeat: true,
};

function byId(state: ChecklistState) {
  return Object.fromEntries(checklist(state).map((i) => [i.id, i]));
}

describe('checklist', () => {
  it('lists every step as not done on a fresh install, each with its tab', () => {
    const items = checklist(FRESH);
    expect(items.map((i) => [i.id, i.done, i.tab])).toEqual([
      ['password', false, 'security'],
      ['trading_auth', false, 'security'],
      ['broker', false, 'connections'],
      ['collection', false, 'schedulers'],
      ['alerts', false, 'alerts'],
    ]);
  });

  it('is all done once everything is set', () => {
    expect(checklist(READY).every((i) => i.done)).toBe(true);
    expect(byId(READY).broker.detail).toBe('2 connected.');
  });

  it('names what is still missing', () => {
    const items = byId({ ...READY, mfa: false, heartbeat: false });
    expect(items.trading_auth.done).toBe(false);
    expect(items.trading_auth.detail).toBe('Still needed: order MFA.');
    expect(items.alerts.detail).toBe('Still needed: the heartbeat URL.');
  });

  it('needs the backfill scheduler on before collection counts as done', () => {
    const items = byId({ ...READY, backfillEnabled: false });
    expect(items.collection.done).toBe(false);
    expect(items.collection.detail).toMatch(/turn the backfill scheduler on/);
  });

  it('says so when the broker service cannot be asked', () => {
    const items = byId({ ...READY, connections: null });
    expect(items.broker.done).toBe(false);
    expect(items.broker.detail).toMatch(/not answering/);
  });
});

describe('loadChecklistState', () => {
  const db = () => ({ query: jest.fn(async () => ({ rows: [{ n: 4 }] })) });

  it('counts connections from the broker service and collection rows from the database', async () => {
    mockedAxios.get.mockResolvedValue({ data: { connections: { 'oanda:a': {}, 'mt5:b': {} } } });
    process.env.BACKFILL_ENABLED = 'true';
    process.env.TELEGRAM_BOT_TOKEN = 'bot';
    process.env.TELEGRAM_CHAT_ID = '1';
    process.env.HEARTBEAT_URL = 'https://hc-ping.com/x';
    const state = await loadChecklistState('http://broker', db());
    expect(mockedAxios.get).toHaveBeenCalledWith('http://broker/providers', expect.anything());
    expect(state).toMatchObject({
      connections: 2,
      collecting: 4,
      backfillEnabled: true,
      telegram: true,
      heartbeat: true,
    });
  });

  it('reports connections as unknown when the broker service does not answer', async () => {
    mockedAxios.get.mockRejectedValue(new Error('ECONNREFUSED'));
    const state = await loadChecklistState('http://broker', db());
    expect(state.connections).toBeNull();
  });
});
