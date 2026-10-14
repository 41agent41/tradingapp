/**
 * Broker connection status, as the broker service last checked it.
 *
 * The broker service probes every configured connection on a timer
 * (`broker_service/probes.py`) and reports the result on its `/health`. This
 * turns that report into the list the header badge and Settings page show, in
 * broker priority order, and into the one problem the heartbeat pages for: the
 * default broker being unreachable. Pure: no I/O here.
 */

import { BROKER_PRIORITY } from './orderTypes.js';

export type BrokerConnectionState = 'connected' | 'unreachable' | 'unchecked';

export interface BrokerConnectionStatus {
  label: string;
  platform: string;
  account: string;
  account_mode: string | null;
  /** The connection an unqualified request reaches (default platform + its default account). */
  is_default: boolean;
  status: BrokerConnectionState;
  error: string | null;
  latency_ms: number | null;
  checked_at: string | null;
}

export interface BrokerStatusSummary {
  default: string | null;
  connections: BrokerConnectionStatus[];
}

function ranker(priority: unknown): (platform: string) => number {
  const order: readonly string[] =
    Array.isArray(priority) && priority.length ? priority.map(String) : BROKER_PRIORITY;
  return (platform) => {
    const i = order.indexOf(platform);
    return i === -1 ? order.length : i;
  };
}

/**
 * Build the status list from the broker service's `/health` `providers` block,
 * in its priority order (which the Settings page or .env may have changed).
 */
export function brokersFromHealth(providers: any): BrokerStatusSummary {
  const defaultPlatform = typeof providers?.default === 'string' ? providers.default : null;
  const raw = providers?.connections;
  if (!raw || typeof raw !== 'object') return { default: defaultPlatform, connections: [] };

  const rank = ranker(providers?.priority);
  const connections = Object.entries(raw as Record<string, any>).map(([label, c]) => {
    const check = c?.check;
    const status: BrokerConnectionState =
      check?.status === 'connected' || check?.status === 'unreachable' ? check.status : 'unchecked';
    return {
      label,
      platform: String(c?.platform ?? label.split(':')[0]),
      account: String(c?.account ?? label.split(':')[1] ?? 'default'),
      account_mode: c?.account_mode ?? null,
      is_default: Boolean(c?.is_default) && c?.platform === defaultPlatform,
      status,
      error: check?.error ?? null,
      latency_ms: typeof check?.latency_ms === 'number' ? check.latency_ms : null,
      checked_at: check?.checked_at ?? null,
    };
  });

  connections.sort(
    (a, b) =>
      rank(a.platform) - rank(b.platform) ||
      Number(b.is_default) - Number(a.is_default) ||
      a.account.localeCompare(b.account)
  );
  return { default: defaultPlatform, connections };
}

/**
 * The heartbeat's broker problem: the default broker's last check failed.
 * Other connections being down shows in the app but does not page, and a
 * connection not checked yet is not a problem.
 */
export function defaultBrokerProblem(summary: BrokerStatusSummary): string | null {
  const def = summary.connections.find((c) => c.is_default);
  if (!def || def.status !== 'unreachable') return null;
  return `default broker ${def.label} unreachable${def.error ? `: ${def.error}` : ''}`;
}
