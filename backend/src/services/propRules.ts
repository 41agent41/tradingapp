/**
 * Prop-firm loss rules (R-P1), computed the firm's way.
 *
 * A funded or evaluation account is closed the moment it breaches its firm's
 * daily loss or maximum loss, and firms measure those differently:
 *
 *   - **Daily loss** is an allowance (a % of the initial balance, or an
 *     amount) below where the day started. The day's start is the balance at
 *     rollover for some firms, equity for others, the higher of the two for
 *     the strictest.
 *   - **Maximum loss** is an allowance below a floor that is either
 *     **static** (the initial balance) or **trailing** (the highest equity or
 *     balance reached), and a trailing floor often stops trailing once it
 *     reaches the initial balance.
 *
 * Breaching either one ends the account, so the app stops new entries
 * **short** of it: once the room left is within a buffer you set (a % of the
 * allowance). Open positions keep their stops; they can still lose more, which
 * is why the buffer exists.
 *
 * Configured per connection as JSON in `PROP_RULES__<CONNECTION>`, for
 * example `PROP_RULES__MT5_FTMO`:
 *
 *   {"firm":"FTMO 100k","initial_balance":100000,
 *    "daily_loss":{"pct":5,"basis":"balance"},
 *    "max_loss":{"pct":10,"mode":"static"},
 *    "buffer_pct":20}
 *
 * Firms also restrict *when* an account may trade (R-P2), and those rules are
 * optional blocks in the same JSON:
 *
 *   - `news_blackout`: no new entries from `minutes_before` to
 *     `minutes_after` a news release of the listed `impact` for either of the
 *     instrument's currencies (see newsCalendar.ts). When the calendar cannot
 *     be read, entries are refused.
 *   - `weekend`: no new entries from `no_entries_after` (e.g. `"fri 20:00"`)
 *     until `resume` (default `"mon 00:00"`), both in `TRADING_DAY_TIMEZONE`.
 *     A position still open inside that window pages the operator.
 *   - `min_trading_days`: the firm's minimum number of days traded since
 *     `start_date`. Nothing is refused for it; the Fleet panel shows progress.
 */

import { blackoutEvent, type BlackoutRule, type CalendarState } from './newsCalendar.js';

export type DailyBasis = 'balance' | 'equity' | 'higher';
export type MaxLossMode = 'static' | 'trailing_equity' | 'trailing_balance';

export interface PropRules {
  firm: string;
  initial_balance: number;
  daily_loss?: { pct?: number; amount?: number; basis: DailyBasis };
  max_loss?: { pct?: number; amount?: number; mode: MaxLossMode; lock_at_initial?: boolean };
  /** Stop entries once the room left is within this % of the allowance. */
  buffer_pct: number;
  news_blackout?: BlackoutRule;
  weekend?: WeekendRule;
  min_trading_days?: { days: number; start_date: string };
}

/** A weekly window, as minutes after Monday 00:00 in the trading timezone. */
export interface WeekendRule {
  no_entries_after: string;
  resume: string;
  /** Parsed forms of the two above. */
  from_minute: number;
  until_minute: number;
}

/** The balance and equity readings the rules are measured against. */
export interface PropMarks {
  equity: number;
  balance: number | null;
  day_start_equity: number;
  day_start_balance: number | null;
  equity_high_water_mark: number;
  balance_high_water_mark: number | null;
}

export interface PropLimitState {
  kind: 'prop_daily_loss' | 'prop_max_loss';
  /** The level equity must stay above, as the firm computes it. */
  floor: number;
  allowance: number;
  /** Equity above the floor. At or below zero the firm's rule is broken. */
  room: number;
  /** Entries stop once `room` is at or below this. */
  stop_at: number;
  stopped: boolean;
  detail: string;
}

const DEFAULT_BUFFER_PCT = 20;

/**
 * Parse and validate one connection's rules. Throws with a message naming
 * the problem: a prop account with rules the app cannot read must not trade.
 */
export function parsePropRules(raw: string): PropRules {
  let value: any;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('is not valid JSON');
  }
  if (!value || typeof value !== 'object') throw new Error('must be a JSON object');

  const initial = Number(value.initial_balance);
  if (!Number.isFinite(initial) || initial <= 0) {
    throw new Error('needs initial_balance, a positive number');
  }

  const rules: PropRules = {
    firm: String(value.firm || 'prop account'),
    initial_balance: initial,
    buffer_pct: DEFAULT_BUFFER_PCT,
  };

  if (value.buffer_pct != null) {
    const buffer = Number(value.buffer_pct);
    if (!Number.isFinite(buffer) || buffer < 0 || buffer >= 100) {
      throw new Error('buffer_pct must be at least 0 and below 100');
    }
    rules.buffer_pct = buffer;
  }

  if (value.daily_loss != null) {
    const basis = value.daily_loss.basis ?? 'balance';
    if (!['balance', 'equity', 'higher'].includes(basis)) {
      throw new Error('daily_loss.basis must be balance, equity or higher');
    }
    rules.daily_loss = { ...allowanceOf(value.daily_loss, 'daily_loss'), basis };
  }

  if (value.max_loss != null) {
    const mode = value.max_loss.mode ?? 'static';
    if (!['static', 'trailing_equity', 'trailing_balance'].includes(mode)) {
      throw new Error('max_loss.mode must be static, trailing_equity or trailing_balance');
    }
    rules.max_loss = {
      ...allowanceOf(value.max_loss, 'max_loss'),
      mode,
      lock_at_initial: value.max_loss.lock_at_initial !== false,
    };
  }

  if (!rules.daily_loss && !rules.max_loss) {
    throw new Error('needs daily_loss, max_loss or both');
  }

  if (value.news_blackout != null) {
    const block = value.news_blackout;
    const before = Number(block.minutes_before ?? 2);
    const after = Number(block.minutes_after ?? 2);
    if (![before, after].every((m) => Number.isFinite(m) && m >= 0 && m <= 1440)) {
      throw new Error('news_blackout minutes_before and minutes_after must be 0 to 1440');
    }
    const impact = block.impact ?? ['High'];
    if (
      !Array.isArray(impact) ||
      impact.length === 0 ||
      !impact.every((i) => typeof i === 'string')
    ) {
      throw new Error('news_blackout.impact must be a list such as ["High"]');
    }
    rules.news_blackout = { minutes_before: before, minutes_after: after, impact };
  }

  if (value.weekend != null) {
    const from = String(value.weekend.no_entries_after ?? '');
    const until = String(value.weekend.resume ?? 'mon 00:00');
    const fromMinute = weekMinute(from);
    const untilMinute = weekMinute(until);
    if (fromMinute == null) throw new Error('weekend.no_entries_after must look like "fri 20:00"');
    if (untilMinute == null) throw new Error('weekend.resume must look like "mon 00:00"');
    if (fromMinute === untilMinute) throw new Error('weekend window is empty');
    rules.weekend = {
      no_entries_after: from,
      resume: until,
      from_minute: fromMinute,
      until_minute: untilMinute,
    };
  }

  if (value.min_trading_days != null) {
    const days = Number(value.min_trading_days.days);
    const start = String(value.min_trading_days.start_date ?? '');
    if (!Number.isInteger(days) || days <= 0) {
      throw new Error('min_trading_days.days must be a positive whole number');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || Number.isNaN(Date.parse(start))) {
      throw new Error('min_trading_days.start_date must be YYYY-MM-DD');
    }
    rules.min_trading_days = { days, start_date: start };
  }
  return rules;
}

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** `"fri 20:00"` as minutes after Monday 00:00, or null when malformed. */
export function weekMinute(text: string): number | null {
  const match = /^\s*([a-z]{3})[a-z]*\s+(\d{1,2}):(\d{2})\s*$/i.exec(text);
  if (!match) return null;
  const day = WEEKDAYS.indexOf(match[1].toLowerCase());
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  if (day < 0 || hour > 23 || minute > 59) return null;
  return day * 1440 + hour * 60 + minute;
}

/** Where `at` falls in the week, in minutes after Monday 00:00 in `timeZone`. */
export function minuteOfWeek(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = WEEKDAYS.indexOf(get('weekday').slice(0, 3).toLowerCase());
  return day * 1440 + Number(get('hour')) * 60 + Number(get('minute'));
}

/** Whether `at` is inside the weekend window. The window may wrap past Sunday. */
export function inWeekendWindow(at: Date, rule: WeekendRule, timeZone: string): boolean {
  const m = minuteOfWeek(at, timeZone);
  return rule.from_minute < rule.until_minute
    ? m >= rule.from_minute && m < rule.until_minute
    : m >= rule.from_minute || m < rule.until_minute;
}

/**
 * Why a new entry is refused by the firm's schedule rules right now, or null
 * when it may go ahead. Pure.
 *
 * `calendar` is only read when there is a news rule, and a stale or missing
 * calendar refuses: a blackout that cannot be checked is treated as in force.
 */
export function propScheduleRefusal(input: {
  rules: PropRules;
  now: Date;
  timeZone: string;
  currencies: string[];
  calendar: CalendarState | null;
}): string | null {
  const { rules, now, timeZone, currencies, calendar } = input;
  if (rules.weekend && inWeekendWindow(now, rules.weekend, timeZone)) {
    return (
      `${rules.firm} weekend rule: no new entries from ${rules.weekend.no_entries_after} ` +
      `until ${rules.weekend.resume} (${timeZone})`
    );
  }
  if (rules.news_blackout) {
    if (!calendar || calendar.stale) {
      return (
        `${rules.firm} news rule cannot be checked: the economic calendar is ` +
        `${calendar?.fetchedAt ? 'out of date' : 'unavailable'}` +
        (calendar?.error ? ` (${calendar.error})` : '')
      );
    }
    if (currencies.length === 0) {
      return `${rules.firm} news rule cannot be checked: the instrument's currencies are unknown`;
    }
    const event = blackoutEvent(calendar.events, currencies, now, rules.news_blackout);
    if (event) {
      return (
        `${rules.firm} news blackout: ${event.currency} ${event.title} at ` +
        `${event.at.toISOString()} (${rules.news_blackout.minutes_before} min before to ` +
        `${rules.news_blackout.minutes_after} min after)`
      );
    }
  }
  return null;
}

/** Whether the rules restrict when entries may be placed. */
export function hasScheduleRules(rules: PropRules | null | undefined): boolean {
  return Boolean(rules && (rules.news_blackout || rules.weekend));
}

function allowanceOf(block: any, name: string): { pct?: number; amount?: number } {
  const pct = block.pct == null ? null : Number(block.pct);
  const amount = block.amount == null ? null : Number(block.amount);
  if ((pct == null) === (amount == null)) {
    throw new Error(`${name} needs exactly one of pct or amount`);
  }
  if (pct != null && (!Number.isFinite(pct) || pct <= 0 || pct >= 100)) {
    throw new Error(`${name}.pct must be above 0 and below 100`);
  }
  if (amount != null && (!Number.isFinite(amount) || amount <= 0)) {
    throw new Error(`${name}.amount must be a positive number`);
  }
  return pct != null ? { pct } : { amount: amount as number };
}

function allowance(rules: PropRules, block: { pct?: number; amount?: number }): number {
  return block.pct != null ? (rules.initial_balance * block.pct) / 100 : (block.amount as number);
}

/**
 * Where each rule stands. Pure.
 *
 * A rule that needs the balance when the venue reported none is reported as
 * stopped: unknown is not the same as safe.
 */
export function evaluatePropRules(marks: PropMarks, rules: PropRules): PropLimitState[] {
  const states: PropLimitState[] = [];

  if (rules.daily_loss) {
    const allowed = allowance(rules, rules.daily_loss);
    const start = dailyStart(marks, rules.daily_loss.basis);
    states.push(
      state(
        'prop_daily_loss',
        start == null ? null : start - allowed,
        allowed,
        marks.equity,
        rules,
        `${rules.firm} daily loss: ${money(allowed)} below the day's starting ` +
          `${rules.daily_loss.basis === 'higher' ? 'balance or equity' : rules.daily_loss.basis}`
      )
    );
  }

  if (rules.max_loss) {
    const allowed = allowance(rules, rules.max_loss);
    const peak =
      rules.max_loss.mode === 'static'
        ? rules.initial_balance
        : rules.max_loss.mode === 'trailing_equity'
          ? Math.max(rules.initial_balance, marks.equity_high_water_mark)
          : marks.balance_high_water_mark == null
            ? null
            : Math.max(rules.initial_balance, marks.balance_high_water_mark);
    let floor = peak == null ? null : peak - allowed;
    // Most trailing rules stop trailing once the floor reaches the initial
    // balance: from then on the account can never lose its starting capital.
    if (floor != null && rules.max_loss.mode !== 'static' && rules.max_loss.lock_at_initial) {
      floor = Math.min(floor, rules.initial_balance);
    }
    states.push(
      state(
        'prop_max_loss',
        floor,
        allowed,
        marks.equity,
        rules,
        `${rules.firm} max loss: ${money(allowed)} below ` +
          (rules.max_loss.mode === 'static'
            ? 'the initial balance'
            : `the highest ${rules.max_loss.mode === 'trailing_equity' ? 'equity' : 'balance'}`)
      )
    );
  }
  return states;
}

function dailyStart(marks: PropMarks, basis: DailyBasis): number | null {
  if (basis === 'equity') return marks.day_start_equity;
  if (marks.day_start_balance == null) return null;
  if (basis === 'balance') return marks.day_start_balance;
  return Math.max(marks.day_start_balance, marks.day_start_equity);
}

function state(
  kind: PropLimitState['kind'],
  floor: number | null,
  allowed: number,
  equity: number,
  rules: PropRules,
  rule: string
): PropLimitState {
  const stopAt = (allowed * rules.buffer_pct) / 100;
  if (floor == null) {
    return {
      kind,
      floor: Number.NaN,
      allowance: allowed,
      room: Number.NaN,
      stop_at: stopAt,
      stopped: true,
      detail: `${rule}; the venue reported no balance, so the floor is unknown`,
    };
  }
  const room = equity - floor;
  return {
    kind,
    floor,
    allowance: allowed,
    room,
    stop_at: stopAt,
    stopped: room <= stopAt,
    detail:
      `${rule}. Floor ${money(floor)}, equity ${money(equity)}, room ${money(room)}; ` +
      `entries stop at ${money(stopAt)} of room (${rules.buffer_pct}% buffer)`,
  };
}

function money(value: number): string {
  return value.toFixed(2);
}
