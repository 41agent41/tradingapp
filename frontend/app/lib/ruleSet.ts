/**
 * Rule-set construction for the systematic strategy builder (A5 / Phase 4).
 *
 * Pure helpers that turn the flat form state of `<StrategyBuilder>` into the
 * declarative rule-set the backend persists (see backend A1 schema) — kept out
 * of the component so the serialization is unit-testable.
 */

export const OPERATORS = ['>', '<', '>=', '<=', 'crosses_above', 'crosses_below'] as const;
export type Operator = (typeof OPERATORS)[number];

export const TIMEFRAMES = [
  '1min',
  '5min',
  '15min',
  '30min',
  '1hour',
  '4hour',
  '8hour',
  '1day',
] as const;

export const SIZING_TYPES = ['fixed', 'notional', 'pct_equity'] as const;
export type SizingType = (typeof SIZING_TYPES)[number];

/** Common operand suggestions for the left/right selects. Free text is also
 *  allowed (e.g. a bare number for the right-hand side, or a `close`/`volume`
 *  bar field). */
export const OPERAND_SUGGESTIONS = [
  'sma_20',
  'sma_50',
  'ema_20',
  'rsi',
  'macd',
  'close',
  'volume',
  'position.size',
  'position.unrealized_pct',
];

export interface ConditionForm {
  left: string;
  op: Operator;
  right: string;
}

export interface StrategyForm {
  name: string;
  symbol: string;
  timeframe: string;
  broker: string;
  indicators: string; // comma-separated
  entry: ConditionForm[];
  exit: ConditionForm[];
  sizingType: SizingType;
  sizingSize: string;
  maxOrdersPerDay: string;
  stopLossPct: string;
}

export interface RuleCondition {
  left: string | number;
  op: Operator;
  right: string | number;
}

/** Coerce an operand string to a number when it is purely numeric, else keep
 *  it as an identifier (indicator column / bar field / position operand). */
export function coerceOperand(raw: string): string | number {
  const s = raw.trim();
  if (s === '') return s;
  const n = Number(s);
  return Number.isFinite(n) && /^-?\d*\.?\d+$/.test(s) ? n : s;
}

function compileConditions(rows: ConditionForm[]): RuleCondition[] {
  return rows
    .filter((c) => c.left.trim() !== '' && c.right.trim() !== '')
    .map((c) => ({ left: coerceOperand(c.left), op: c.op, right: coerceOperand(c.right) }));
}

export interface BuildResult {
  ok: boolean;
  errors: string[];
  ruleSet?: Record<string, unknown>;
  payload?: Record<string, unknown>;
}

/**
 * Validate + serialize the builder form into the `POST /api/strategies/definitions`
 * payload. Entry conditions join with `all` (every rule must hold), exit
 * conditions with `any` (any rule triggers an exit) — matching the roadmap's
 * example schema.
 */
export function buildDefinitionPayload(form: StrategyForm): BuildResult {
  const errors: string[] = [];
  if (!form.name.trim()) errors.push('Name is required');
  if (!form.symbol.trim()) errors.push('Symbol is required');
  if (!form.timeframe) errors.push('Timeframe is required');

  const entry = compileConditions(form.entry);
  if (entry.length === 0) errors.push('At least one entry condition is required');

  const exit = compileConditions(form.exit);

  const size = Number(form.sizingSize);
  if (!Number.isFinite(size) || size <= 0) errors.push('Sizing size must be a positive number');

  if (errors.length > 0) return { ok: false, errors };

  const indicators = form.indicators
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const sizing: Record<string, unknown> = {
    type: form.sizingType,
    unit: 'broker_default',
    size,
  };

  const risk: Record<string, unknown> = {};
  const maxOrders = Number(form.maxOrdersPerDay);
  if (Number.isFinite(maxOrders) && maxOrders > 0) risk.max_orders_per_day = maxOrders;
  const stopLoss = Number(form.stopLossPct);
  if (Number.isFinite(stopLoss) && stopLoss > 0) risk.stop_loss_pct = stopLoss;

  const ruleSet: Record<string, unknown> = {
    name: form.name.trim(),
    symbol: form.symbol.trim().toUpperCase(),
    broker: form.broker,
    timeframe: form.timeframe,
    ...(indicators.length > 0 ? { indicators } : {}),
    entry: { all: entry },
    ...(exit.length > 0 ? { exit: { any: exit } } : {}),
    sizing,
    ...(Object.keys(risk).length > 0 ? { risk } : {}),
  };

  const payload: Record<string, unknown> = {
    name: form.name.trim(),
    symbol: form.symbol.trim().toUpperCase(),
    timeframe: form.timeframe,
    broker: form.broker,
    rule_set: ruleSet,
  };

  return { ok: true, errors: [], ruleSet, payload };
}
