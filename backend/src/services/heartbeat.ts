/**
 * Dead-man's switch: an outbound heartbeat to a monitor off the host.
 *
 * Every alert the app sends comes from the app, so none of them fire when the
 * app is down, the host is off or the internet is cut (decision E-P3). The
 * only thing that notices silence is something else, somewhere else. So the
 * backend pings `HEARTBEAT_URL` (a healthchecks.io check, an Uptime Kuma push
 * monitor, anything that pages when pings stop) every
 * `HEARTBEAT_INTERVAL_SECONDS`, and the monitor pages you when they stop.
 *
 * A ping means "this app is able to trade", not merely "this process is up":
 * it is sent only when the database answers, the broker service answers, the
 * default broker's last connectivity check did not fail, and the strategy runner (when enabled) has completed a pass recently. A runner
 * whose timer died, or that the schema guard never started, stops the pings
 * just as a crash would. When something is wrong and `HEARTBEAT_FAIL_URL` is
 * set (healthchecks.io: the check URL plus `/fail`), that is pinged instead,
 * so the page arrives at once rather than after the monitor's grace period.
 */

import axios from 'axios';
import { logger } from './logger.js';
import { configService } from '../config/configService.js';

export interface HeartbeatProbe {
  database(): Promise<boolean>;
  brokerService(): Promise<boolean>;
  /** A problem with the default broker's connection, or null when it is fine or unchecked. */
  defaultBroker?(): Promise<string | null>;
  /** The runner's state, or null when the app has no runner. */
  runner(): { enabled: boolean; intervalSeconds: number; lastRunAt: number | null } | null;
}

export interface HeartbeatOptions {
  url: string | null;
  failUrl: string | null;
  intervalSeconds: number;
  now?: () => number;
  /** GET with no body for a healthy ping; POST with the problems for a fail. */
  ping?: (url: string, problems?: string) => Promise<void>;
}

/** What is wrong right now, or an empty list when the app can trade. Pure. */
export function heartbeatProblems(input: {
  database: boolean;
  brokerService: boolean;
  /** From brokerStatus.defaultBrokerProblem; null or absent when fine. */
  defaultBroker?: string | null;
  runner: { enabled: boolean; intervalSeconds: number; lastRunAt: number | null } | null;
  now: number;
  since: number;
}): string[] {
  const problems: string[] = [];
  if (!input.database) problems.push('database unreachable');
  if (!input.brokerService) problems.push('broker service unreachable');
  else if (input.defaultBroker) problems.push(input.defaultBroker);
  const runner = input.runner;
  if (runner?.enabled) {
    // Three missed passes, and never less than three minutes, so one slow
    // pass over a busy fleet is not a page.
    const maxAgeMs = Math.max(3 * runner.intervalSeconds, 180) * 1000;
    const last = runner.lastRunAt ?? input.since;
    if (input.now - last > maxAgeMs) {
      problems.push(
        runner.lastRunAt == null
          ? 'strategy runner has not completed a pass since startup'
          : `strategy runner last completed a pass ${Math.round((input.now - last) / 1000)}s ago`
      );
    }
  }
  return problems;
}

export class Heartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly since: number;
  private lastPingAt: number | null = null;
  private lastResult: 'ok' | 'fail' | 'silent' | 'error' | null = null;
  private lastProblems: string[] = [];
  private lastError: string | null = null;
  private readonly now: () => number;
  private readonly ping: (url: string, problems?: string) => Promise<void>;

  constructor(
    private readonly probe: HeartbeatProbe,
    private opts: HeartbeatOptions
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.ping = opts.ping ?? defaultPing;
    this.since = this.now();
  }

  get enabled(): boolean {
    return Boolean(this.opts.url);
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    logger.info({ interval_seconds: this.opts.intervalSeconds }, 'heartbeat started');
    void this.beat();
    this.timer = setInterval(() => void this.beat(), this.opts.intervalSeconds * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Stops the heartbeat and takes new URLs and interval. Call `start()` to
   *  resume. */
  reconfigure(next: Pick<HeartbeatOptions, 'url' | 'failUrl' | 'intervalSeconds'>): void {
    this.stop();
    this.opts = { ...this.opts, ...next };
  }

  /** One check and one ping. Never throws. */
  async beat(): Promise<void> {
    if (!this.opts.url) return;
    const [database, brokerService, defaultBroker] = await Promise.all([
      this.probe.database().catch(() => false),
      this.probe.brokerService().catch(() => false),
      this.probe.defaultBroker ? this.probe.defaultBroker().catch(() => null) : null,
    ]);
    const problems = heartbeatProblems({
      database,
      brokerService,
      defaultBroker,
      runner: this.probe.runner(),
      now: this.now(),
      since: this.since,
    });
    this.lastProblems = problems;
    const target = problems.length === 0 ? this.opts.url : this.opts.failUrl;
    if (!target) {
      // No fail URL: staying silent is the signal, and the monitor pages once
      // its grace period runs out.
      this.lastResult = 'silent';
      logger.warn({ problems }, 'heartbeat withheld');
      return;
    }
    try {
      await (problems.length === 0 ? this.ping(target) : this.ping(target, problems.join('; ')));
      this.lastPingAt = this.now();
      this.lastResult = problems.length === 0 ? 'ok' : 'fail';
      this.lastError = null;
      if (problems.length > 0) logger.warn({ problems }, 'heartbeat reported failure');
    } catch (err) {
      this.lastResult = 'error';
      this.lastError = err instanceof Error ? err.message : String(err);
      logger.warn({ err: this.lastError }, 'heartbeat ping failed');
    }
  }

  status() {
    return {
      enabled: this.enabled,
      interval_seconds: this.opts.intervalSeconds,
      fail_url_set: Boolean(this.opts.failUrl),
      last_ping_at: this.lastPingAt ? new Date(this.lastPingAt).toISOString() : null,
      last_result: this.lastResult,
      problems: this.lastProblems,
      last_error: this.lastError,
    };
  }
}

async function defaultPing(url: string, problems?: string): Promise<void> {
  const headers = { Connection: 'close' };
  if (problems == null) {
    await axios.get(url, { timeout: 10000, headers });
    return;
  }
  // healthchecks.io keeps a ping's body in the check's log, so the page says why.
  await axios.post(url, problems, {
    timeout: 10000,
    headers: { ...headers, 'Content-Type': 'text/plain' },
  });
}

/** Changing any of these restarts the heartbeat with the new values. */
export const HEARTBEAT_SETTING_KEYS = [
  'HEARTBEAT_URL',
  'HEARTBEAT_FAIL_URL',
  'HEARTBEAT_INTERVAL_SECONDS',
] as const;

/** Options from `.env` or the Settings page. Unset `HEARTBEAT_URL` turns the
 *  heartbeat off. */
export function heartbeatOptionsFromEnv(
  env: Record<string, string | undefined> = configService.asEnv()
): HeartbeatOptions {
  const interval = Number(env.HEARTBEAT_INTERVAL_SECONDS ?? '');
  return {
    url: (env.HEARTBEAT_URL || '').trim() || null,
    failUrl: (env.HEARTBEAT_FAIL_URL || '').trim() || null,
    intervalSeconds: Number.isFinite(interval) && interval >= 10 ? interval : 60,
  };
}
