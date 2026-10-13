/**
 * Economic calendar for prop-firm news blackouts (R-P2).
 *
 * Most prop firms forbid opening (and often closing) trades within a few
 * minutes of high-impact news for the instrument's currencies. That needs a
 * calendar, so this reads one: by default the free weekly feed many retail
 * tools use (`NEWS_CALENDAR_URL`), a JSON list of
 * `{title, country, date, impact}` where `country` is a currency code.
 *
 * The calendar is refreshed on demand when it is older than
 * `NEWS_CALENDAR_REFRESH_MINUTES`, and kept in memory: a restart simply
 * fetches it again. When it cannot be fetched and the copy held is older than
 * `NEWS_CALENDAR_MAX_AGE_HOURS`, it reports itself **stale**, and a prop
 * account with a blackout rule then refuses entries. Trading blind through a
 * firm's news rule is how the account gets closed.
 */

import axios from 'axios';
import { logger } from './logger.js';

export interface NewsEvent {
  at: Date;
  currency: string;
  impact: string;
  title: string;
}

export const DEFAULT_CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

/** Parse the feed, dropping rows it cannot place in time. */
export function parseCalendar(body: unknown): NewsEvent[] {
  if (!Array.isArray(body)) throw new Error('calendar is not a list');
  const events: NewsEvent[] = [];
  for (const row of body as any[]) {
    const at = new Date(String(row?.date ?? ''));
    const currency = String(row?.country ?? '')
      .trim()
      .toUpperCase();
    if (Number.isNaN(at.getTime()) || !currency) continue;
    events.push({
      at,
      currency,
      impact: String(row?.impact ?? '').trim(),
      title: String(row?.title ?? '').trim(),
    });
  }
  return events;
}

/**
 * The currencies an instrument moves with. A six-letter FX or metal pair
 * (`EURUSD`, `XAUUSD`, with any broker suffix stripped) is its two halves;
 * anything else falls back to the quote currency it is priced in.
 */
export function instrumentCurrencies(symbol: string, quoteCurrency?: string | null): string[] {
  const letters = symbol.toUpperCase().replace(/[^A-Z]/g, '');
  if (letters.length >= 6) {
    const pair = letters.slice(0, 6);
    return [pair.slice(0, 3), pair.slice(3, 6)];
  }
  return quoteCurrency ? [quoteCurrency.toUpperCase()] : [];
}

export interface BlackoutRule {
  minutes_before: number;
  minutes_after: number;
  /** Impact levels that count, as the feed spells them. */
  impact: string[];
}

/** The event whose blackout window `now` falls in, or null. Pure. */
export function blackoutEvent(
  events: NewsEvent[],
  currencies: string[],
  now: Date,
  rule: BlackoutRule
): NewsEvent | null {
  const impacts = new Set(rule.impact.map((i) => i.toLowerCase()));
  const wanted = new Set(currencies.map((c) => c.toUpperCase()));
  const t = now.getTime();
  for (const event of events) {
    if (!wanted.has(event.currency) || !impacts.has(event.impact.toLowerCase())) continue;
    const start = event.at.getTime() - rule.minutes_before * 60_000;
    const end = event.at.getTime() + rule.minutes_after * 60_000;
    if (t >= start && t <= end) return event;
  }
  return null;
}

export interface CalendarState {
  events: NewsEvent[];
  stale: boolean;
  fetchedAt: Date | null;
  error: string | null;
}

export class NewsCalendar {
  private events: NewsEvent[] = [];
  private fetchedAt: Date | null = null;
  private lastAttempt = 0;
  private error: string | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly fetchBody: () => Promise<unknown> = defaultFetch,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  /** The calendar, refreshed first when due. Never throws. */
  async current(now: Date = new Date()): Promise<CalendarState> {
    const refreshMs = minutes(this.env.NEWS_CALENDAR_REFRESH_MINUTES, 360) * 60_000;
    // Retry a failed fetch at most once a minute, so an outage does not turn
    // every entry check into a slow network call.
    const due = !this.fetchedAt || now.getTime() - this.fetchedAt.getTime() >= refreshMs;
    if (due && now.getTime() - this.lastAttempt >= 60_000) {
      this.lastAttempt = now.getTime();
      this.inFlight ??= this.refresh(now).finally(() => {
        this.inFlight = null;
      });
      await this.inFlight;
    }
    const maxAgeMs = minutes(this.env.NEWS_CALENDAR_MAX_AGE_HOURS, 24) * 3_600_000;
    const stale = !this.fetchedAt || now.getTime() - this.fetchedAt.getTime() > maxAgeMs;
    return { events: this.events, stale, fetchedAt: this.fetchedAt, error: this.error };
  }

  private async refresh(now: Date): Promise<void> {
    try {
      this.events = parseCalendar(await this.fetchBody());
      this.fetchedAt = now;
      this.error = null;
      logger.info({ events: this.events.length }, 'news calendar refreshed');
    } catch (err) {
      this.error = (err as Error)?.message ?? String(err);
      logger.warn({ err: this.error }, 'news calendar refresh failed');
    }
  }
}

function minutes(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? '');
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function defaultFetch(): Promise<unknown> {
  const url = (process.env.NEWS_CALENDAR_URL || DEFAULT_CALENDAR_URL).trim();
  const response = await axios.get(url, { timeout: 15000, headers: { Connection: 'close' } });
  return response.data;
}

/** The process-wide calendar. */
export const newsCalendar = new NewsCalendar();
