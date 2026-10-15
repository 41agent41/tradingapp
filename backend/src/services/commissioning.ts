/**
 * The Settings page's "Getting started" checklist: what a new install still
 * needs before it is ready for paper trading. Computed from state each time,
 * so it needs no table of its own and an item ticks itself once done,
 * however it was done (in the app or in .env).
 */
import axios from 'axios';

import { configService } from '../config/configService.js';
import { credentials } from './credentials.js';
import { dbService } from './database.js';
import type { Querier } from './backtestRunRepository.js';

export interface ChecklistState {
  passwordSet: boolean;
  tradingToken: boolean;
  mfa: boolean;
  /** Broker connections the broker service has, or null when it did not answer. */
  connections: number | null;
  /** Enabled data collection entries. */
  collecting: number;
  backfillEnabled: boolean;
  telegram: boolean;
  heartbeat: boolean;
}

export interface ChecklistItem {
  id: string;
  title: string;
  done: boolean;
  detail: string;
  /** The Settings tab where it is done. */
  tab: string;
}

/** The checklist for a state. Pure. */
export function checklist(s: ChecklistState): ChecklistItem[] {
  return [
    {
      id: 'password',
      title: 'Choose the login password',
      done: s.passwordSet,
      detail: s.passwordSet ? 'Set.' : 'Set it on the Security tab.',
      tab: 'security',
    },
    {
      id: 'trading_auth',
      title: 'Enrol order MFA and make a trading token',
      done: s.tradingToken && s.mfa,
      detail:
        s.tradingToken && s.mfa
          ? 'Both set.'
          : `Still needed: ${[!s.tradingToken && 'a trading token', !s.mfa && 'order MFA']
              .filter(Boolean)
              .join(' and ')}.`,
      tab: 'security',
    },
    {
      id: 'broker',
      title: 'Add a broker connection',
      done: (s.connections ?? 0) > 0,
      detail:
        s.connections === null
          ? 'The broker service is not answering, so connections cannot be counted.'
          : s.connections > 0
            ? `${s.connections} connected.`
            : 'Add one (OANDA, MT5, IB or Alpaca); it is tested when saved.',
      tab: 'connections',
    },
    {
      id: 'collection',
      title: 'Choose the market data to collect',
      done: s.collecting > 0 && s.backfillEnabled,
      detail:
        s.collecting === 0
          ? 'Add instruments and timeframes on the Schedulers and data tab.'
          : s.backfillEnabled
            ? `${s.collecting} collected.`
            : `${s.collecting} chosen; turn the backfill scheduler on to start collecting.`,
      tab: 'schedulers',
    },
    {
      id: 'alerts',
      title: 'Set up alerts and the dead-man’s switch',
      done: s.telegram && s.heartbeat,
      detail:
        s.telegram && s.heartbeat
          ? 'Telegram and the heartbeat are set.'
          : `Still needed: ${[!s.telegram && 'Telegram', !s.heartbeat && 'the heartbeat URL']
              .filter(Boolean)
              .join(' and ')}.`,
      tab: 'alerts',
    },
  ];
}

function isSet(key: string): boolean {
  return Boolean((configService.get(key) ?? '').trim());
}

async function countConnections(brokerServiceUrl: string): Promise<number | null> {
  try {
    const response = await axios.get(`${brokerServiceUrl}/providers`, {
      timeout: 5000,
      headers: { Connection: 'close' },
    });
    return Object.keys(response.data?.connections ?? {}).length;
  } catch {
    return null;
  }
}

async function countCollecting(db: Querier): Promise<number> {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM data_collection_config WHERE enabled AND auto_collect`
  );
  return Number(rows[0]?.n ?? 0);
}

/** Reads the state from the app, the database and the broker service. */
export async function loadChecklistState(
  brokerServiceUrl: string,
  db: Querier = dbService
): Promise<ChecklistState> {
  const [connections, collecting] = await Promise.all([
    countConnections(brokerServiceUrl),
    countCollecting(db),
  ]);
  return {
    passwordSet: credentials.hasPassword(),
    tradingToken: credentials.hasTokens('trading'),
    mfa: Boolean(credentials.mfaSecret()),
    connections,
    collecting,
    backfillEnabled: (configService.get('BACKFILL_ENABLED') ?? 'false').toLowerCase() === 'true',
    telegram: isSet('TELEGRAM_BOT_TOKEN') && isSet('TELEGRAM_CHAT_ID'),
    heartbeat: isSet('HEARTBEAT_URL'),
  };
}
