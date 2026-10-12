import { describe, expect, it } from 'vitest';

import { toCsv } from '../app/components/DataframeViewer';

const cols = [
  { key: 'symbol', label: 'Symbol' },
  { key: 'note', label: 'Note' },
];

describe('toCsv', () => {
  it('emits header + CRLF-terminated rows', () => {
    const out = toCsv([{ symbol: 'MSFT', note: 'ok' }], cols);
    expect(out).toBe('Symbol,Note\r\nMSFT,ok\r\n');
  });

  it('emits header-only when there are no rows', () => {
    expect(toCsv([], cols)).toBe('Symbol,Note\r\n');
  });

  it('quotes values that contain commas, quotes or line breaks', () => {
    const out = toCsv([{ symbol: 'A,B', note: 'has "quote"\nnew line' }], cols);
    expect(out).toContain('"A,B"');
    expect(out).toContain('"has ""quote""\nnew line"');
  });

  it('renders null / undefined as empty cells', () => {
    const out = toCsv([{ symbol: 'MSFT', note: null }, { symbol: 'AAPL' }], cols);
    expect(out).toBe('Symbol,Note\r\nMSFT,\r\nAAPL,\r\n');
  });

  it('coerces non-string scalars', () => {
    const out = toCsv([{ symbol: 'MSFT', note: 42 }], cols);
    expect(out).toBe('Symbol,Note\r\nMSFT,42\r\n');
  });
});
