/**
 * The Historical and Download pages' instrument filters: a broker connection,
 * then a symbol from that connection's own list, which fills in its type,
 * currency and exchange.
 */
import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import InstrumentFilters, {
  DEFAULT_INSTRUMENT,
  instrumentParams,
  type Instrument,
} from '../app/components/InstrumentFilters';

const STATUS = {
  connections: [
    {
      label: 'oanda:practice',
      platform: 'oanda',
      account: 'practice',
      account_mode: 'paper',
      is_default: true,
      check: null,
    },
  ],
};

const OANDA = {
  platform: 'oanda',
  account: 'practice',
  complete: true,
  refreshed_at: new Date().toISOString(),
  stale: false,
  markets: [{ market: 'INDEX', count: 1 }],
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
  ],
};

function serve() {
  const urls: string[] = [];
  global.fetch = vi.fn(async (url: any) => {
    const u = String(url);
    urls.push(u);
    const body = u.includes('/api/brokers/status') ? STATUS : OANDA;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as any;
  return urls;
}

let latest: Instrument = DEFAULT_INSTRUMENT;
function Harness({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState<Instrument>(DEFAULT_INSTRUMENT);
  const onChange = (next: Instrument) => {
    latest = next;
    setValue(next);
  };
  return <InstrumentFilters value={value} onChange={onChange} disabled={disabled} />;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
  vi.useFakeTimers({ shouldAdvanceTime: true });
  latest = DEFAULT_INSTRUMENT;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const settle = () => act(async () => void vi.advanceTimersByTime(300));

describe('InstrumentFilters', () => {
  it("picks a symbol from the chosen connection's list and fills in its details", async () => {
    const urls = serve();
    render(<Harness />);
    const connection = (await screen.findByRole('option', {
      name: /OANDA practice \(paper\)/,
    })) as HTMLOptionElement;
    fireEvent.change(screen.getByLabelText('Connection'), {
      target: { value: connection.value },
    });
    expect(latest.source).toBe('oanda');
    expect(latest.account).toBe('practice');
    await settle();
    await waitFor(() =>
      expect(
        urls.some((u) => u.includes('/api/market-data/symbols?') && u.includes('source=oanda'))
      ).toBe(true)
    );
    await waitFor(() => expect(screen.getByText(/1 symbols from OANDA/)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Symbol'), { target: { value: 'AU200.AUD' } });
    expect(latest).toMatchObject({
      symbol: 'AU200.AUD',
      secType: 'CFD',
      currency: 'AUD',
      exchange: 'OANDA',
    });
    expect((screen.getByLabelText('Type') as HTMLSelectElement).value).toBe('CFD');
  });

  it('greys everything out when data querying is off', async () => {
    serve();
    render(<Harness disabled />);
    await settle();
    for (const name of ['Connection', 'Market', 'Symbol', 'Type', 'Currency', 'Exchange']) {
      expect(screen.getByLabelText(name)).toBeDisabled();
    }
  });
});

describe('instrumentParams', () => {
  it('names the connection and leaves out empty fields', () => {
    expect(
      instrumentParams({
        source: 'oanda',
        account: 'practice',
        symbol: ' AU200.AUD ',
        secType: 'CFD',
        currency: 'aud',
        exchange: '',
      })
    ).toEqual({
      symbol: 'AU200.AUD',
      secType: 'CFD',
      currency: 'AUD',
      source: 'oanda',
      account: 'practice',
    });
    expect(instrumentParams(DEFAULT_INSTRUMENT)).toEqual({
      symbol: 'MSFT',
      secType: 'STK',
      exchange: 'SMART',
      currency: 'USD',
    });
  });
});
