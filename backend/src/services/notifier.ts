/**
 * Operational alerting (Component E — §8).
 *
 * Telegram, chosen for reachability rather than preference: a bot token and an
 * HTTPS call, against WhatsApp Business API approval or a Signal bridge
 * process. The requirement is "reaches the operator's phone reliably", and the
 * simplest transport that achieves it wins.
 *
 * The channel sits behind an interface so a second one is additive rather than
 * a change to every call site — the design cost of that is one small type, and
 * it is the difference between adding a channel and rewiring the callers.
 *
 * **Deduplication is not a nicety here.** These alerts fire from a loop that
 * runs every bar: an unprotected position or a position divergence is true
 * again on the next bar, and the one after. An alert channel that repeats the
 * same line every 60 seconds is an alert channel that gets muted, and a muted
 * channel is worse than none because it looks like coverage.
 */

import axios from 'axios';
import { logger } from './logger.js';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Alert {
  /** Stable identity for deduplication. Two alerts about the same ongoing
   *  condition must share a key, or the channel floods. */
  key: string;
  severity: AlertSeverity;
  title: string;
  detail?: string;
  context?: Record<string, unknown>;
}

export interface NotificationChannel {
  readonly name: string;
  send(alert: Alert): Promise<void>;
}

/** How long the same key stays suppressed after being sent. */
const DEFAULT_DEDUPE_SECONDS = Math.max(
  0,
  parseInt(process.env.ALERT_DEDUPE_SECONDS || '3600', 10) || 3600
);
/** Ceiling on alerts per window, whatever their keys — a backstop against a
 *  novel failure producing a new key every bar. */
const MAX_PER_WINDOW = Math.max(1, parseInt(process.env.ALERT_MAX_PER_HOUR || '30', 10) || 30);
const WINDOW_MS = 3_600_000;

const SEVERITY_PREFIX: Record<AlertSeverity, string> = {
  info: 'ℹ️',
  warning: '⚠️',
  critical: '🚨',
};

/** Telegram Bot API. Credentials come from the environment, never from the
 *  connection manifest or the database. */
export class TelegramChannel implements NotificationChannel {
  readonly name = 'telegram';

  constructor(
    private readonly token: string,
    private readonly chatId: string
  ) {}

  static fromEnv(): TelegramChannel | null {
    const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    const chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();
    if (!token || !chatId) return null;
    return new TelegramChannel(token, chatId);
  }

  async send(alert: Alert): Promise<void> {
    const lines = [`${SEVERITY_PREFIX[alert.severity]} *${escapeMarkdown(alert.title)}*`];
    if (alert.detail) lines.push(escapeMarkdown(alert.detail));
    for (const [key, value] of Object.entries(alert.context ?? {})) {
      lines.push(`• ${escapeMarkdown(key)}: ${escapeMarkdown(String(value))}`);
    }
    await axios.post(
      `https://api.telegram.org/bot${this.token}/sendMessage`,
      { chat_id: this.chatId, text: lines.join('\n'), parse_mode: 'Markdown' },
      { timeout: 15_000 }
    );
  }
}

/** Telegram's Markdown parser rejects unbalanced control characters, and an
 *  alert that fails to send because a symbol contained an underscore is the
 *  worst possible time to discover it. */
function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

export interface NotifierOptions {
  channels?: NotificationChannel[];
  dedupeSeconds?: number;
  maxPerWindow?: number;
  now?: () => number;
}

export class Notifier {
  private readonly channels: NotificationChannel[];
  private readonly dedupeMs: number;
  private readonly maxPerWindow: number;
  private readonly now: () => number;

  private readonly lastSent = new Map<string, number>();
  private windowStart = 0;
  private windowCount = 0;

  public sent = 0;
  public suppressed = 0;
  public failures = 0;

  constructor(opts: NotifierOptions = {}) {
    const fromEnv = TelegramChannel.fromEnv();
    this.channels = opts.channels ?? (fromEnv ? [fromEnv] : []);
    this.dedupeMs = (opts.dedupeSeconds ?? DEFAULT_DEDUPE_SECONDS) * 1000;
    this.maxPerWindow = opts.maxPerWindow ?? MAX_PER_WINDOW;
    this.now = opts.now ?? (() => Date.now());
  }

  get enabled(): boolean {
    return this.channels.length > 0;
  }

  /**
   * Deliver an alert, unless it duplicates a recent one or the window is full.
   *
   * Never throws. A failing alert channel must not take down the loop it is
   * reporting on — an operator with a broken notifier and a working trading
   * system is in a much better position than the reverse.
   */
  async notify(alert: Alert): Promise<{ sent: boolean; reason?: string }> {
    if (!this.enabled) return { sent: false, reason: 'no channel configured' };

    const now = this.now();
    const previous = this.lastSent.get(alert.key);
    if (previous != null && now - previous < this.dedupeMs) {
      this.suppressed++;
      return { sent: false, reason: 'deduplicated' };
    }

    if (now - this.windowStart >= WINDOW_MS) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    if (this.windowCount >= this.maxPerWindow) {
      this.suppressed++;
      // Logged rather than silent: hitting the ceiling is itself a signal, and
      // it is the one alert that cannot be sent through the channel.
      logger.warn(
        { key: alert.key, max: this.maxPerWindow },
        'alert rate limit reached — suppressing until the window rolls'
      );
      return { sent: false, reason: 'rate limited' };
    }

    let delivered = false;
    for (const channel of this.channels) {
      try {
        await channel.send(alert);
        delivered = true;
      } catch (err) {
        this.failures++;
        logger.error(
          { channel: channel.name, key: alert.key, err: String(err) },
          'alert delivery failed'
        );
      }
    }

    if (delivered) {
      this.lastSent.set(alert.key, now);
      this.windowCount++;
      this.sent++;
    }
    return { sent: delivered, reason: delivered ? undefined : 'all channels failed' };
  }

  /** Clear a key's suppression, so a condition that recurs after resolving
   *  alerts again rather than waiting out the dedupe window. */
  resolve(key: string): void {
    this.lastSent.delete(key);
  }

  status() {
    return {
      enabled: this.enabled,
      channels: this.channels.map((c) => c.name),
      dedupe_seconds: this.dedupeMs / 1000,
      max_per_hour: this.maxPerWindow,
      totals: { sent: this.sent, suppressed: this.suppressed, failures: this.failures },
    };
  }
}

export const notifier = new Notifier();
