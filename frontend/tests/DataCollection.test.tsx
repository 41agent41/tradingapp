/**
 * Settings > Schedulers and data: the list of instruments collected
 * automatically, adding one, pausing one and removing one.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import DataCollection from '../app/components/DataCollection';

const ENTRY = {
  id: 3,
  broker: 'oanda',
  account: 'default',
  symbol: 'EUR_USD',
  sec_type: 'CASH',
  exchange: null,
  currency: 'USD',
  timeframe: '5min',
  enabled: true,
  auto_collect: true,
  collection_interval_minutes: 5,
  retention_days: 365,
  latest_bar: null,
};

function mockApi(entries = [ENTRY]) {
  const writes: { url: string; method: string; body: any }[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      writes.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return method === 'DELETE'
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ entry: ENTRY }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ entries, brokers: ['oanda', 'ib'], timeframes: ['5min', '1hour'] }),
      { status: 200 }
    );
  }) as any;
  return writes;
}

describe('DataCollection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists what is collected and adds an instrument', async () => {
    const writes = mockApi();
    render(<DataCollection />);
    await waitFor(() => expect(screen.getByText('EUR_USD')).toBeInTheDocument());
    expect(screen.getByText('none yet')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Symbol *'), { target: { value: 'gbp_usd' } });
    fireEvent.change(screen.getByLabelText('Timeframe'), { target: { value: '1hour' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      method: 'POST',
      body: { broker: 'oanda', symbol: 'gbp_usd', timeframe: '1hour', retention_days: '365' },
    });
    await waitFor(() => expect(screen.getByText('GBP_USD 1hour added.')).toBeInTheDocument());
  });

  it('pauses and removes an entry', async () => {
    const writes = mockApi();
    render(<DataCollection />);
    const box = await screen.findByLabelText('Collect EUR_USD 5min');
    fireEvent.click(box);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      method: 'PUT',
      body: { enabled: true, auto_collect: false },
    });
    expect(writes[0].url).toContain('/api/market-data/collection/3');

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].method).toBe('DELETE');
    await waitFor(() => expect(screen.getByText(/stored bars are kept/)).toBeInTheDocument());
  });

  it('says when nothing is collected yet', async () => {
    mockApi([]);
    render(<DataCollection />);
    await waitFor(() => expect(screen.getByText(/Nothing is collected yet/)).toBeInTheDocument());
  });
});
