/**
 * Settings > Schedulers and data: the list of instruments collected
 * automatically, adding one, pausing one and removing one.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import DataCollection, {
  historyProgress,
  liveFeed,
  recorderSummary,
  reconcileSummary,
  type RecorderStatus,
} from '../app/components/DataCollection';

const ENTRY = {
  id: 3,
  contract_id: 9,
  record_live: false,
  record_ticks: false,
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
  history_start: null,
  oldest_bar: null,
  backfilled_to: null,
};

const STATUS: RecorderStatus = {
  enabled: true,
  running: true,
  degraded: false,
  lag_seconds: 0.4,
  waiting: 0,
  last_error: null,
  poll_seconds: 2,
  contracts: [
    {
      contract_id: 9,
      mode: 'polled',
      last_quote: '2026-11-10T12:00:05Z',
      last_bar: '2026-11-10T12:00:00Z',
      quotes_last_minute: 28,
      error: null,
    },
  ],
};

function mockApi(entries = [ENTRY], status: RecorderStatus = STATUS) {
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
    if (url.includes('/recorder/status')) {
      return new Response(JSON.stringify(status), { status: 200 });
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

  it('sends the history start date with a new entry', async () => {
    const writes = mockApi();
    render(<DataCollection />);
    await screen.findByText('EUR_USD');
    fireEvent.change(screen.getByLabelText('Symbol *'), { target: { value: 'EUR_USD' } });
    fireEvent.change(screen.getByLabelText('History from'), { target: { value: '2025-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body).toMatchObject({ history_start: '2025-01-01' });
  });

  it('shows how far the walk back to the history start has got', () => {
    expect(historyProgress(ENTRY)).toBe('recent only');
    const deep = { ...ENTRY, history_start: '2025-01-01' };
    expect(historyProgress(deep)).toBe('from 2025-01-01: starting');
    expect(
      historyProgress({
        ...deep,
        oldest_bar: '2025-06-03T00:00:00.000Z',
        backfilled_to: '2025-06-01T00:00:00.000Z',
      })
    ).toBe('from 2025-01-01: back to 2025-06-03 so far');
    expect(
      historyProgress({
        ...deep,
        oldest_bar: '2025-01-02T00:00:00.000Z',
        backfilled_to: '2025-01-01T00:00:00.000Z',
      })
    ).toBe('from 2025-01-01: complete (oldest bar 2025-01-02)');
  });

  it('says when nothing is collected yet', async () => {
    mockApi([]);
    render(<DataCollection />);
    await waitFor(() => expect(screen.getByText(/Nothing is collected yet/)).toBeInTheDocument());
  });
});

describe('live recording', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ticks Record live and Store ticks for an instrument', async () => {
    const writes = mockApi();
    render(<DataCollection />);
    fireEvent.click(await screen.findByLabelText('Record EUR_USD live'));
    await waitFor(() => expect(writes).toHaveLength(1));
    fireEvent.click(screen.getByLabelText('Store EUR_USD ticks'));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes.map((w) => [w.url.split('/').pop(), w.method, w.body])).toEqual([
      ['3', 'PUT', { record_live: true }],
      ['3', 'PUT', { record_ticks: true }],
    ]);
  });

  it('shows the recorder and what each recorded instrument is receiving', async () => {
    mockApi([{ ...ENTRY, record_live: true, record_ticks: true }]);
    render(<DataCollection />);
    await waitFor(() =>
      expect(screen.getByTestId('recorder-summary')).toHaveTextContent(
        'Live recorder: on, recording 1, 0 s behind the stream.'
      )
    );
    expect(screen.getByText(/polled every 2 s, 28 quotes in the last minute/)).toBeInTheDocument();
    expect(screen.getByLabelText('Record EUR_USD live')).toBeChecked();
    expect(screen.getByLabelText('Store EUR_USD ticks')).toBeChecked();
  });

  it('shows the last reconcile and runs one on request', async () => {
    const writes = mockApi([{ ...ENTRY, record_live: true }], {
      ...STATUS,
      reconcile: {
        running: false,
        last_run: '2026-11-10T02:30:00Z',
        last_error: null,
        results: [
          { replaced: 40, filled: 3, left: 0, error: null },
          { replaced: 2, filled: 0, left: 1, error: 'broker down' },
        ],
      },
    });
    render(<DataCollection />);
    await waitFor(() =>
      expect(screen.getByTestId('reconcile-summary')).toHaveTextContent(
        /42 recorded bars replaced, 3 missing minutes filled, 1 instrument failed\./
      )
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile now' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ method: 'POST' });
    expect(writes[0].url).toContain('/api/market-data/recorder/reconcile');
    expect(reconcileSummary({ ...STATUS, reconcile: undefined })).toBe('');
    expect(
      reconcileSummary({
        ...STATUS,
        reconcile: { running: false, last_run: null, last_error: null, results: [] },
      })
    ).toMatch(/nightly at 02:30 UTC/);
  });

  it('says why an instrument is not streaming, and when the recorder is off or behind', () => {
    const on = { ...ENTRY, record_live: true };
    expect(liveFeed(ENTRY, STATUS)).toBe('not recorded');
    expect(liveFeed({ ...on, enabled: false }, STATUS)).toBe('paused (entry disabled)');
    expect(liveFeed(on, { ...STATUS, contracts: [] })).toBe('starting');
    expect(
      liveFeed(on, { ...STATUS, contracts: [{ ...STATUS.contracts[0], error: 'no such symbol' }] })
    ).toBe('not streaming: no such symbol');
    expect(
      liveFeed(on, {
        ...STATUS,
        contracts: [{ ...STATUS.contracts[0], mode: 'streamed', last_quote: null }],
      })
    ).toBe('streamed, no quote yet');
    expect(liveFeed(on, { ...STATUS, enabled: false })).toBe('recorder is off');

    expect(recorderSummary({ ...STATUS, enabled: false })).toMatch(/off/);
    expect(recorderSummary({ ...STATUS, running: false, last_error: 'redis down' })).toBe(
      'Live recorder: not running (redis down).'
    );
    expect(recorderSummary({ ...STATUS, degraded: true, lag_seconds: 95 })).toBe(
      'Live recorder: falling behind, 95 s behind the stream.'
    );
  });
});
