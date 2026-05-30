/**
 * Tests for the cell coercion logic inside `routes/export.ts`.
 *
 * The route itself touches `@dsnp/parquetjs` and Express streaming, which
 * we don't try to unit-test — those paths are exercised in CI via the
 * existing route tests (Supertest hits the JSON path and the validation
 * branches). The `coerce` helper, on the other hand, is pure and is the
 * piece most likely to silently corrupt a downstream pandas read.
 */
import { coerce } from '../src/routes/export.js';

describe('coerce — number / currency', () => {
  it('passes through finite numbers unchanged', () => {
    expect(coerce(42, 'number')).toBe(42);
    expect(coerce(3.14, 'currency')).toBe(3.14);
  });

  it('parses numeric strings', () => {
    expect(coerce('42', 'number')).toBe(42);
    expect(coerce('3.14', 'currency')).toBe(3.14);
  });

  it('rejects non-finite numbers as null so parquetjs does not panic', () => {
    expect(coerce(Number.NaN, 'number')).toBeNull();
    expect(coerce(Number.POSITIVE_INFINITY, 'currency')).toBeNull();
    expect(coerce('not a number', 'number')).toBeNull();
  });
});

describe('coerce — date', () => {
  it('returns Date instances unchanged', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    expect(coerce(d, 'date')).toBe(d);
  });

  it('interprets large numbers as milliseconds', () => {
    const ms = 1_736_000_000_000;
    const out = coerce(ms, 'date') as Date;
    expect(out).toBeInstanceOf(Date);
    expect(out.getTime()).toBe(ms);
  });

  it('interprets small numbers as unix seconds', () => {
    const sec = 1_736_000_000;
    const out = coerce(sec, 'date') as Date;
    expect(out.getTime()).toBe(sec * 1000);
  });

  it('parses ISO-8601 strings', () => {
    const out = coerce('2026-01-05T12:00:00Z', 'date') as Date;
    expect(out).toBeInstanceOf(Date);
    expect(out.getUTCFullYear()).toBe(2026);
  });

  it('returns null for unparseable input', () => {
    expect(coerce('not a date', 'date')).toBeNull();
    expect(coerce({ not: 'a date' }, 'date')).toBeNull();
  });
});

describe('coerce — string / boolean / empties', () => {
  it('passes strings through and JSON-stringifies non-strings', () => {
    expect(coerce('hello', 'string')).toBe('hello');
    expect(coerce({ foo: 1 }, 'string')).toBe('{"foo":1}');
  });

  it('converts truthy/falsy to boolean', () => {
    expect(coerce(1, 'boolean')).toBe(true);
    expect(coerce('false', 'boolean')).toBe(true); // any non-empty string is truthy
    expect(coerce(0, 'boolean')).toBeNull(); // 0 is treated as empty by coerce()
  });

  it('returns null for null / undefined / empty-string regardless of type', () => {
    for (const t of ['number', 'string', 'date', 'boolean', 'currency'] as const) {
      expect(coerce(null, t)).toBeNull();
      expect(coerce(undefined, t)).toBeNull();
      expect(coerce('', t)).toBeNull();
    }
  });
});
