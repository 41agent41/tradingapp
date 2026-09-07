/**
 * Helpers for Jesse-engine strategies on the /backtest picker.
 *
 * The broker service's catalogue (`GET /api/backtesting/strategies`) tags each
 * entry with an `engine`. Rule-based built-ins are `rules`; strategies authored
 * against the embedded Jesse framework (`broker_service/jesse_strategies/`)
 * are `jesse` and additionally publish a `hyperparameters` spec — the
 * strategy's own `hyperparameters()` declaration, rendered JSON-safe. This
 * module turns that spec into form state and back into a request selector.
 */

export type HyperparameterType = 'int' | 'float' | 'bool' | 'str' | string;

export interface HyperparameterSpec {
  name: string;
  type: HyperparameterType;
  default: number | string | boolean | null;
  min?: number | null;
  max?: number | null;
}

export interface StrategyCatalogueEntry {
  name: string;
  indicators: string[];
  description: string;
  engine?: 'rules' | 'jesse' | string;
  hyperparameters?: HyperparameterSpec[];
  class_name?: string;
}

export function isJesseStrategy(info: StrategyCatalogueEntry | undefined | null): boolean {
  return String(info?.engine ?? 'rules').toLowerCase() === 'jesse';
}

/** Form text for a spec default — what the input shows before any edit. */
export function defaultInputValue(spec: HyperparameterSpec): string {
  if (spec.default === null || spec.default === undefined) return '';
  return String(spec.default);
}

/** Initial form state for a spec list: every name mapped to its default. */
export function initialHyperparameterValues(specs: HyperparameterSpec[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of specs) out[spec.name] = defaultInputValue(spec);
  return out;
}

export type ParseOutcome =
  { ok: true; value: number | string | boolean } | { ok: false; error: string };

/** Coerce one raw input string to the spec's type and range. */
export function parseHyperparameter(spec: HyperparameterSpec, raw: string): ParseOutcome {
  const text = raw.trim();
  switch (spec.type) {
    case 'bool': {
      if (text === '') return { ok: false, error: `${spec.name} is required` };
      const lowered = text.toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(lowered)) return { ok: true, value: true };
      if (['false', '0', 'no', 'off'].includes(lowered)) return { ok: true, value: false };
      return { ok: false, error: `${spec.name} must be true or false` };
    }
    case 'int':
    case 'float': {
      if (text === '') return { ok: false, error: `${spec.name} is required` };
      const num = Number(text);
      if (!Number.isFinite(num)) return { ok: false, error: `${spec.name} must be a number` };
      if (spec.type === 'int' && !Number.isInteger(num)) {
        return { ok: false, error: `${spec.name} must be a whole number` };
      }
      if (spec.min != null && num < spec.min) {
        return { ok: false, error: `${spec.name} must be ≥ ${spec.min}` };
      }
      if (spec.max != null && num > spec.max) {
        return { ok: false, error: `${spec.name} must be ≤ ${spec.max}` };
      }
      return { ok: true, value: num };
    }
    default:
      return { ok: true, value: text };
  }
}

export interface OverridesOutcome {
  /** Only the values that differ from the strategy's declared defaults. */
  overrides: Record<string, number | string | boolean>;
  /** Field-level validation messages, keyed by hyperparameter name. */
  errors: Record<string, string>;
}

/**
 * Validate every field and collect the ones the user actually changed.
 *
 * Unchanged fields are omitted so the request stays a plain `strategy` key
 * when nothing was tuned — the persisted run then carries the catalogue key
 * rather than an inline definition that merely restates the defaults.
 */
export function collectHyperparameterOverrides(
  specs: HyperparameterSpec[],
  values: Record<string, string>
): OverridesOutcome {
  const overrides: Record<string, number | string | boolean> = {};
  const errors: Record<string, string> = {};
  for (const spec of specs) {
    const raw = values[spec.name] ?? defaultInputValue(spec);
    const parsed = parseHyperparameter(spec, raw);
    if (!parsed.ok) {
      errors[spec.name] = parsed.error;
      continue;
    }
    if (parsed.value !== spec.default) overrides[spec.name] = parsed.value;
  }
  return { overrides, errors };
}

export type BacktestSelector =
  | { strategy: string }
  | { definition_id: number }
  | { rule_set: { engine: 'jesse'; strategy: string; hyperparameters: Record<string, unknown> } };

/** Picker values: a registered strategy key, or `def:<id>` for a saved rule-set. */
export const DEF_PREFIX = 'def:';

/**
 * The part of the `/api/backtesting/run` body that names what to run.
 *
 * A saved definition and a rules built-in map straight through. A Jesse
 * strategy with tuned hyperparameters becomes an inline
 * `{engine: 'jesse', strategy, hyperparameters}` definition — the same shape
 * `/systematic` saves, so a tuned backtest can later be deployed unchanged.
 */
export function buildBacktestSelector(
  picked: string,
  info: StrategyCatalogueEntry | undefined,
  overrides: Record<string, unknown>
): BacktestSelector {
  if (picked.startsWith(DEF_PREFIX)) {
    return { definition_id: Number(picked.slice(DEF_PREFIX.length)) };
  }
  if (isJesseStrategy(info) && Object.keys(overrides).length > 0) {
    return {
      rule_set: {
        engine: 'jesse',
        strategy: info?.class_name || picked,
        hyperparameters: overrides,
      },
    };
  }
  return { strategy: picked };
}

/** Human label for the engine badge. */
export function engineLabel(engine: string | undefined | null): string {
  const key = String(engine ?? 'rules').toLowerCase();
  if (key === 'jesse') return 'Jesse';
  if (key === 'rules') return 'Rules';
  return key;
}

/**
 * Jesse-only metrics worth surfacing beside the shared result grid. Keys are
 * those `jesse.metrics` emits; anything absent is simply not rendered.
 */
export type ExtraMetricFormat = 'number' | 'percent' | 'currency' | 'hours';

export const JESSE_EXTRA_METRICS: Array<{
  key: string;
  label: string;
  /** `hours` takes a value in seconds (Jesse's holding-period unit). */
  format: ExtraMetricFormat;
}> = [
  { key: 'sortino_ratio', label: 'Sortino', format: 'number' },
  { key: 'calmar_ratio', label: 'Calmar', format: 'number' },
  { key: 'omega_ratio', label: 'Omega', format: 'number' },
  { key: 'annual_return', label: 'Annual Return', format: 'percent' },
  { key: 'expectancy', label: 'Expectancy', format: 'currency' },
  { key: 'kelly_criterion', label: 'Kelly', format: 'number' },
  { key: 'longs_percentage', label: 'Longs', format: 'percent' },
  { key: 'average_holding_period', label: 'Avg Hold', format: 'hours' },
  { key: 'fee', label: 'Fees Paid', format: 'currency' },
  { key: 'warmup_candles', label: 'Warm-up Bars', format: 'number' },
];

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Render one extra metric for display; null when absent or non-numeric. */
export function formatExtraMetric(value: unknown, format: ExtraMetricFormat): string | null {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  switch (format) {
    case 'percent':
      return `${num.toFixed(2)}%`;
    case 'currency':
      return usd.format(num);
    case 'hours':
      return `${(num / 3600).toFixed(1)} h`;
    default:
      return Number.isInteger(num) ? String(num) : num.toFixed(2);
  }
}
