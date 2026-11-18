/**
 * The symbol picker: offers the connection's own symbols by market, fills in
 * the security type and currency of a listed symbol, and flags one that is
 * not on a complete list.
 */
import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SymbolPicker, { type SymbolChoice } from '../app/components/SymbolPicker';

const OANDA = {
  platform: 'oanda',
  account: '',
  complete: true,
  refreshed_at: new Date().toISOString(),
  stale: false,
  markets: [
    { market: 'FX', count: 1 },
    { market: 'INDEX', count: 1 },
  ],
  symbols: [
    {
      symbol: 'AU200.AUD',
      name: 'Australia 200',
      market: 'INDEX',
      sec_type: 'CFD',
      currency: 'AUD',
      exchange: 'OANDA',
      venue_id: 'AU200_AUD',
    },
    {
      symbol: 'EUR.USD',
      name: 'EUR/USD',
      market: 'FX',
      sec_type: 'CASH',
      currency: 'USD',
      exchange: 'OANDA',
      venue_id: 'EUR_USD',
    },
  ],
};

function serve(body: unknown, status = 200) {
  const urls: string[] = [];
  global.fetch = vi.fn(async (url: any) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), { status });
  }) as any;
  return urls;
}

function Harness({
  source = 'oanda',
  onPick,
}: {
  source?: string;
  onPick?: (c: SymbolChoice) => void;
}) {
  const [symbol, setSymbol] = useState('');
  return (
    <form>
      <SymbolPicker
        source={source}
        symbol={symbol}
        onChange={(c) => {
          setSymbol(c.symbol);
          onPick?.(c);
        }}
      />
    </form>
  );
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const settle = () => act(async () => void vi.advanceTimersByTime(300));

describe('SymbolPicker', () => {
  it("lists the connection's markets and symbols", async () => {
    const urls = serve(OANDA);
    render(<Harness />);
    await settle();
    await waitFor(() => expect(screen.getByText(/2 symbols from OANDA/)).toBeInTheDocument());
    expect(urls[0]).toContain('/api/market-data/symbols?');
    expect(urls[0]).toContain('source=oanda');
    const options = screen.getByTestId('symbol-options').querySelectorAll('option');
    expect(Array.from(options).map((o) => o.value)).toEqual(['AU200.AUD', 'EUR.USD']);
    const market = screen.getByLabelText('Market') as HTMLSelectElement;
    expect(Array.from(market.options).map((o) => o.textContent)).toEqual([
      'All (2)',
      'FX (1)',
      'Indices (1)',
    ]);
    fireEvent.change(market, { target: { value: 'INDEX' } });
    await settle();
    await waitFor(() => expect(urls.some((u) => u.includes('market=INDEX'))).toBe(true));
  });

  it("fills in a listed symbol's type and currency, and finds it typed without the dot", async () => {
    serve(OANDA);
    const picks: SymbolChoice[] = [];
    render(<Harness onPick={(c) => picks.push(c)} />);
    await settle();
    await waitFor(() => expect(screen.getByText(/2 symbols/)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'au200aud' } });
    expect(picks.at(-1)).toEqual({
      symbol: 'AU200.AUD',
      secType: 'CFD',
      currency: 'AUD',
      exchange: 'OANDA',
    });
    expect((screen.getByLabelText('Symbol') as HTMLInputElement).value).toBe('AU200.AUD');
  });

  it('flags a symbol that is not on the list', async () => {
    serve({ ...OANDA, symbols: [] });
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'NOPE' } });
    await settle();
    await waitFor(() =>
      expect(screen.getByTestId('symbol-list-note').textContent).toMatch(
        /NOPE is not on OANDA's list/
      )
    );
  });

  it('says a search-only broker is searched as you type', async () => {
    serve({ ...OANDA, platform: 'ib', complete: false, markets: [], symbols: [] });
    render(<Harness source="ib" />);
    await settle();
    await waitFor(() =>
      expect(screen.getByTestId('symbol-list-note').textContent).toMatch(/type two letters/)
    );
  });

  it('shows why the list could not be read', async () => {
    serve({ message: 'OANDA unreachable' }, 502);
    render(<Harness />);
    await settle();
    await waitFor(() => expect(screen.getByText('OANDA unreachable')).toBeInTheDocument());
  });
});
