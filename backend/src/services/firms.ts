/**
 * The firms a broker connection can belong to, and the one connection type
 * each is allowed (docs/plans/ENHANCEMENT_PLAN.md, E-31): its web API when it
 * has one, the MT5 bridge when it does not. A firm with a web API cannot be
 * added through the MT5 bridge. Interactive Brokers is the one firm with two
 * entries: its Web API (`ibkr`, preferred) and the older IB Gateway (`ib`).
 *
 * Mirrored by FIRM_PRESETS in frontend/app/lib/brokerConnections.ts, which
 * adds the help text for the form; tests/firms.test.ts checks the two match.
 * To add a firm, add it in both places and to the backfill in
 * database/migrations/005_connection_firm.sql only if existing rows need it.
 */
import type { Broker } from './orderTypes.js';

export interface Firm {
  id: string;
  name: string;
  platform: Broker;
}

export const FIRMS: readonly Firm[] = [
  { id: 'oanda', name: 'OANDA', platform: 'oanda' },
  { id: 'ig', name: 'IG', platform: 'ig' },
  { id: 'pepperstone', name: 'Pepperstone (cTrader)', platform: 'ctrader' },
  { id: 'icmarkets', name: 'IC Markets (cTrader)', platform: 'ctrader' },
  { id: 'fpmarkets', name: 'FP Markets (cTrader)', platform: 'ctrader' },
  { id: 'fusion', name: 'Fusion Markets (cTrader)', platform: 'ctrader' },
  { id: 'other_ctrader', name: 'Another cTrader firm', platform: 'ctrader' },
  { id: 'ibkr', name: 'Interactive Brokers (Web API)', platform: 'ibweb' },
  { id: 'alpaca', name: 'Alpaca', platform: 'alpaca' },
  { id: 'axi', name: 'Axi (MT5)', platform: 'mt5' },
  { id: 'eightcap', name: 'Eightcap (MT5)', platform: 'mt5' },
  { id: 'vantage', name: 'Vantage (MT5)', platform: 'mt5' },
  { id: 'other_mt5', name: 'Another MT5 firm (no web API)', platform: 'mt5' },
  { id: 'ib', name: 'Interactive Brokers (IB Gateway)', platform: 'ib' },
];

const BY_ID = new Map(FIRMS.map((f) => [f.id, f]));

export function findFirm(id: string): Firm | undefined {
  return BY_ID.get(id);
}

/** The firms a platform serves. */
export function firmsFor(platform: string): Firm[] {
  return FIRMS.filter((f) => f.platform === platform);
}

/**
 * The firm a platform implies when it serves only one (OANDA, IG, the IBKR
 * Web API, Alpaca, IB Gateway), or null when the firm has to be chosen (cTrader, MT5).
 */
export function impliedFirm(platform: string): string | null {
  const firms = firmsFor(platform);
  return firms.length === 1 ? firms[0].id : null;
}
