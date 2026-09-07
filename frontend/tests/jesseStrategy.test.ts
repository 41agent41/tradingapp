/**
 * Tests for the Jesse-engine picker helpers used by /backtest.
 */
import { describe, expect, it } from 'vitest';
import {
  buildBacktestSelector,
  collectHyperparameterOverrides,
  engineLabel,
  formatExtraMetric,
  initialHyperparameterValues,
  isJesseStrategy,
  parseHyperparameter,
  type HyperparameterSpec,
  type StrategyCatalogueEntry,
} from '../app/lib/jesseStrategy';

const specs: HyperparameterSpec[] = [
  { name: 'fast', type: 'int', default: 10, min: 2, max: 100 },
  { name: 'slow', type: 'int', default: 30, min: 5, max: 400 },
  { name: 'risk_pct', type: 'float', default: 1.5, min: 0.1, max: 5 },
  { name: 'use_trail', type: 'bool', default: false },
  { name: 'mode', type: 'str', default: 'close' },
];

const jesseInfo: StrategyCatalogueEntry = {
  name: 'SMA Crossover',
  indicators: [],
  description: 'fast/slow SMA cross',
  engine: 'jesse',
  class_name: 'SMACrossover',
  hyperparameters: specs,
};

const rulesInfo: StrategyCatalogueEntry = {
  name: 'MA Crossover',
  indicators: ['sma_20', 'sma_50'],
  description: 'built-in',
  engine: 'rules',
};

describe('isJesseStrategy / engineLabel', () => {
  it('recognises the jesse engine tag and defaults to rules', () => {
    expect(isJesseStrategy(jesseInfo)).toBe(true);
    expect(isJesseStrategy(rulesInfo)).toBe(false);
    expect(isJesseStrategy({ name: 'x', indicators: [], description: '' })).toBe(false);
    expect(isJesseStrategy(undefined)).toBe(false);
  });

  it('labels engines for the badge', () => {
    expect(engineLabel('jesse')).toBe('Jesse');
    expect(engineLabel('rules')).toBe('Rules');
    expect(engineLabel(undefined)).toBe('Rules');
    expect(engineLabel('other')).toBe('other');
  });
});

describe('initialHyperparameterValues', () => {
  it('maps every spec to its default as input text', () => {
    expect(initialHyperparameterValues(specs)).toEqual({
      fast: '10',
      slow: '30',
      risk_pct: '1.5',
      use_trail: 'false',
      mode: 'close',
    });
  });

  it('renders a null default as an empty field', () => {
    expect(initialHyperparameterValues([{ name: 'x', type: 'str', default: null }])).toEqual({
      x: '',
    });
  });
});

describe('parseHyperparameter', () => {
  const fast = specs[0];
  const risk = specs[2];
  const trail = specs[3];

  it('coerces ints and rejects fractions', () => {
    expect(parseHyperparameter(fast, '12')).toEqual({ ok: true, value: 12 });
    expect(parseHyperparameter(fast, '12.5')).toMatchObject({ ok: false });
    expect(parseHyperparameter(fast, 'abc')).toMatchObject({ ok: false });
    expect(parseHyperparameter(fast, '')).toMatchObject({ ok: false });
  });

  it('enforces min/max bounds', () => {
    expect(parseHyperparameter(fast, '1')).toMatchObject({ ok: false, error: /≥ 2/ });
    expect(parseHyperparameter(fast, '101')).toMatchObject({ ok: false, error: /≤ 100/ });
    expect(parseHyperparameter(risk, '0.25')).toEqual({ ok: true, value: 0.25 });
    expect(parseHyperparameter(risk, '7')).toMatchObject({ ok: false });
  });

  it('parses booleans from common spellings', () => {
    expect(parseHyperparameter(trail, 'true')).toEqual({ ok: true, value: true });
    expect(parseHyperparameter(trail, '0')).toEqual({ ok: true, value: false });
    expect(parseHyperparameter(trail, 'maybe')).toMatchObject({ ok: false });
  });

  it('passes strings through trimmed', () => {
    expect(parseHyperparameter(specs[4], '  hl2 ')).toEqual({ ok: true, value: 'hl2' });
  });
});

describe('collectHyperparameterOverrides', () => {
  it('returns no overrides when every field is at its default', () => {
    const out = collectHyperparameterOverrides(specs, initialHyperparameterValues(specs));
    expect(out.overrides).toEqual({});
    expect(out.errors).toEqual({});
  });

  it('collects only the edited fields, typed', () => {
    const out = collectHyperparameterOverrides(specs, {
      ...initialHyperparameterValues(specs),
      fast: '5',
      use_trail: 'true',
    });
    expect(out.overrides).toEqual({ fast: 5, use_trail: true });
    expect(out.errors).toEqual({});
  });

  it('reports field-level errors and still collects the valid edits', () => {
    const out = collectHyperparameterOverrides(specs, {
      ...initialHyperparameterValues(specs),
      fast: '0',
      slow: '50',
    });
    expect(out.errors).toEqual({ fast: expect.stringMatching(/fast/) });
    expect(out.overrides).toEqual({ slow: 50 });
  });

  it('treats a missing value as the default', () => {
    const out = collectHyperparameterOverrides(specs, { fast: '20' });
    expect(out.overrides).toEqual({ fast: 20 });
    expect(out.errors).toEqual({});
  });
});

describe('formatExtraMetric', () => {
  it('converts Jesse holding periods from seconds to hours', () => {
    expect(formatExtraMetric(66390.7 * 3600, 'hours')).toBe('66390.7 h');
    expect(formatExtraMetric(5400, 'hours')).toBe('1.5 h');
  });

  it('formats percentages, currency and plain numbers', () => {
    expect(formatExtraMetric(54.3123, 'percent')).toBe('54.31%');
    expect(formatExtraMetric(365.657, 'currency')).toBe('$365.66');
    expect(formatExtraMetric(2.6139, 'number')).toBe('2.61');
    expect(formatExtraMetric(50, 'number')).toBe('50');
  });

  it('returns null for absent or non-numeric values', () => {
    expect(formatExtraMetric(null, 'number')).toBeNull();
    expect(formatExtraMetric(undefined, 'hours')).toBeNull();
    expect(formatExtraMetric('n/a', 'percent')).toBeNull();
    expect(formatExtraMetric(Infinity, 'number')).toBeNull();
  });
});

describe('buildBacktestSelector', () => {
  it('maps a saved definition to definition_id', () => {
    expect(buildBacktestSelector('def:7', undefined, {})).toEqual({ definition_id: 7 });
  });

  it('maps a rules built-in to its strategy key', () => {
    expect(buildBacktestSelector('ma_crossover', rulesInfo, {})).toEqual({
      strategy: 'ma_crossover',
    });
  });

  it('keeps a Jesse strategy as a plain key when nothing was tuned', () => {
    expect(buildBacktestSelector('jesse_sma_crossover', jesseInfo, {})).toEqual({
      strategy: 'jesse_sma_crossover',
    });
  });

  it('becomes an inline engine=jesse definition when hyperparameters were tuned', () => {
    expect(buildBacktestSelector('jesse_sma_crossover', jesseInfo, { fast: 5 })).toEqual({
      rule_set: { engine: 'jesse', strategy: 'SMACrossover', hyperparameters: { fast: 5 } },
    });
  });

  it('falls back to the catalogue key when the class name is unknown', () => {
    const info = { ...jesseInfo, class_name: undefined };
    expect(buildBacktestSelector('jesse_sma_crossover', info, { fast: 5 })).toEqual({
      rule_set: {
        engine: 'jesse',
        strategy: 'jesse_sma_crossover',
        hyperparameters: { fast: 5 },
      },
    });
  });
});
