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
import { configService } from '../config/configService.js';
import { type EnvLike, readInt } from '../config/read.js';

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
function dedupeSecondsSetting(): number {
  return readInt(configService.asEnv(), 'ALERT_DEDUPE_SECONDS', 3600, 0);
}
/** Ceiling on alerts per window, whatever their keys — a backstop against a
 *  novel failure producing a new key every bar. */
function maxPerWindowSetting(): number {
  return readInt(configService.asEnv(), 'ALERT_MAX_PER_HOUR', 30, 1);
}
const WINDOW_MS = 3_600_000;

const SEVERITY_PREFIX: Record<AlertSeverity, string> = {
  info: 'ℹ️',
  warning: '⚠️',
  critical: '🚨',
};

/** Telegram Bot API. Credentials come from `.env` or the Settings page
 *  (where the token is stored encrypted), never from the connection manifest. */
export class TelegramChannel implements NotificationChannel {
  readonly name = 'telegram';

  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly post: (url: string, body: unknown, config: object) => Promise<unknown> = (
      url,
      body,
      config
    ) => axios.post(url, body, config)
  ) {}

  static fromEnv(env: EnvLike = configService.asEnv()): TelegramChannel | null {
    const token = (env.TELEGRAM_BOT_TOKEN || '').trim();
    const chatId = (env.TELEGRAM_CHAT_ID || '').trim();
    if (!token || !chatId) return null;
    return new TelegramChannel(token, chatId);
  }

  async send(alert: Alert): Promise<void> {
    const lines = [`${SEVERITY_PREFIX[alert.severity]} *${escapeMarkdown(alert.title)}*`];
    if (alert.detail) lines.push(escapeMarkdown(alert.detail));
    for (const [key, value] of Object.entries(alert.context ?? {})) {
      lines.push(`• ${escapeMarkdown(key)}: ${escapeMarkdown(String(value))}`);
    }
    await this.post(
      `https://api.telegram.org/bot${this.token}/sendMessage`,
      { chat_id: this.chatId, text: lines.join('\n'), parse_mode: 'MarkdownV2' },
      { timeout: 15_000 }
    );
  }
}

/** Escapes text for Telegram's MarkdownV2, which rejects any unescaped
 *  reserved character, and an alert that fails to send because a symbol
 *  contained an underscore is the worst possible time to discover it. The
 *  message must be sent with `parse_mode: 'MarkdownV2'`: under legacy
 *  `Markdown` these backslashes show up literally (`EURUSD\.a`). */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

export interface NotifierOptions {
  channels?: NotificationChannel[];
  dedupeSeconds?: number;
  maxPerWindow?: number;
  now?: () => number;
}

export class Notifier {
  private readonly fixedChannels: NotificationChannel[] | undefined;
  private readonly fixedDedupeSeconds: number | undefined;
  private readonly fixedMaxPerWindow: number | undefined;
  private readonly now: () => number;

  private readonly lastSent = new Map<string, number>();
  private windowStart = 0;
  private windowCount = 0;

  public sent = 0;
  public suppressed = 0;
  public failures = 0;

  constructor(opts: NotifierOptions = {}) {
    this.fixedChannels = opts.channels;
    this.fixedDedupeSeconds = opts.dedupeSeconds;
    this.fixedMaxPerWindow = opts.maxPerWindow;
    this.now = opts.now ?? (() => Date.now());
  }

  // Unless fixed by the caller, these are read on every alert, so a change on
  // the Settings page applies to the next one.
  private get channels(): NotificationChannel[] {
    if (this.fixedChannels) return this.fixedChannels;
    const telegram = TelegramChannel.fromEnv();
    return telegram ? [telegram] : [];
  }

  private get dedupeMs(): number {
    return (this.fixedDedupeSeconds ?? dedupeSecondsSetting()) * 1000;
  }

  private get maxPerWindow(): number {
    return this.fixedMaxPerWindow ?? maxPerWindowSetting();
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

  /**
   * Mark a condition as cleared. Its key stops being suppressed, so a
   * recurrence alerts at once instead of waiting out the dedupe window.
   *
   * When `message` is given and an alert for this key was actually delivered,
   * a "resolved" message goes out too, so the operator sees the all-clear and
   * not only the alarm. Never throws, like `notify`.
   */
  async resolve(
    key: string,
    message?: { title: string; detail?: string; context?: Record<string, unknown> }
  ): Promise<{ sent: boolean }> {
    const wasActive = this.lastSent.delete(key);
    if (!wasActive || !message || !this.enabled) return { sent: false };

    let delivered = false;
    for (const channel of this.channels) {
      try {
        await channel.send({ key: `${key}:resolved`, severity: 'info', ...message });
        delivered = true;
      } catch (err) {
        this.failures++;
        logger.error(
          { channel: channel.name, key, err: String(err) },
          'resolved-alert delivery failed'
        );
      }
    }
    if (delivered) this.sent++;
    return { sent: delivered };
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
