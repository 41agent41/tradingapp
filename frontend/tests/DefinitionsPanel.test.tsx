/**
 * Tests for the definitions list: paper-gate status, setting a holdout start,
 * and showing why the backend refused a run.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DefinitionsPanel, { errorMessage } from '../app/components/systematic/DefinitionsPanel';

const ROWS = [
  {
    id: 1,
    name: 'Passed one',
    broker: 'mt5',
    symbol: 'EURUSD',
    timeframe: '1hour',
    version: 1,
    holdout_start: '2025-01-01',
    created_at: '2026-01-01T00:00:00Z',
    promotion: { paper: { allowed: true, reasons: [] } },
  },
  {
    id: 2,
    name: 'New one',
    broker: 'mt5',
    symbol: 'GBPUSD',
    timeframe: '1hour',
    version: 1,
    holdout_start: null,
    created_at: '2026-01-02T00:00:00Z',
    promotion: { paper: { allowed: false, reasons: ['set a holdout start date'] } },
  },
];

type Handler = (url: string, init?: RequestInit) => { status: number; body: unknown };

function mockApi(handler: Handler) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const { status, body } = handler(String(url), init);
    return new Response(JSON.stringify(body), { status });
  });
  global.fetch = fetchMock as any;
  return fetchMock;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('errorMessage', () => {
  it('lists the gate reasons', () => {
    expect(errorMessage({ error: 'Not passed', detail: ['a', 'b'] }, 409)).toBe(
      'Not passed: a; b'
    );
  });
  it('falls back to a string detail or the status', () => {
    expect(errorMessage({ detail: 'boom' }, 500)).toBe('boom');
    expect(errorMessage({}, 502)).toBe('HTTP 502');
  });
});

describe('DefinitionsPanel', () => {
  it('shows each definition’s paper gate', async () => {
    mockApi(() => ({ status: 200, body: { definitions: ROWS } }));
    render(<DefinitionsPanel />);
    await waitFor(() => expect(screen.getByText('Passed one')).toBeInTheDocument());
    expect(screen.getByText('Passed')).toBeInTheDocument();
    expect(screen.getByText('Not yet')).toHaveAttribute('title', 'set a holdout start date');
    expect(screen.getByText('2025-01-01')).toBeInTheDocument();
  });

  it('sets a holdout start on a definition without one', async () => {
    const fetchMock = mockApi((url) =>
      url.includes('/holdout')
        ? { status: 200, body: { id: 2 } }
        : { status: 200, body: { definitions: ROWS } }
    );
    render(<DefinitionsPanel />);
    const input = await screen.findByLabelText('Holdout start for definition 2');
    fireEvent.change(input, { target: { value: '2025-03-01' } });
    fireEvent.click(screen.getByText('Set'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/definitions/2/holdout'))).toBe(
        true
      )
    );
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/holdout'))!;
    expect(call[1]?.method).toBe('PATCH');
    expect(JSON.parse(String(call[1]?.body))).toEqual({ holdout_start: '2025-03-01' });
  });

  it('shows why a run was refused', async () => {
    mockApi((url, init) =>
      init?.method === 'POST'
        ? {
            status: 409,
            body: {
              error: 'Definition 2 has not passed the paper gate',
              detail: ['no backtest of definition 2 yet'],
            },
          }
        : { status: 200, body: { definitions: ROWS } }
    );
    render(<DefinitionsPanel />);
    await screen.findByText('New one');
    fireEvent.click(screen.getAllByText('Start run')[1]);
    await waitFor(() =>
      expect(
        screen.getByText(
          'Definition 2 has not passed the paper gate: no backtest of definition 2 yet'
        )
      ).toBeInTheDocument()
    );
  });
});
