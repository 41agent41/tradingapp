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
 */

export type DailyBasis = 'balance' | 'equity' | 'higher';
export type MaxLossMode = 'static' | 'trailing_equity' | 'trailing_balance';

export interface PropRules {
  firm: string;
  initial_balance: number;
  daily_loss?: { pct?: number; amount?: number; basis: DailyBasis };
  max_loss?: { pct?: number; amount?: number; mode: MaxLossMode; lock_at_initial?: boolean };
  /** Stop entries once the room left is within this % of the allowance. */
  buffer_pct: number;
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
  return rules;
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
