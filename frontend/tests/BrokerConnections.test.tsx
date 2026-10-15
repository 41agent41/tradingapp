/**
 * Settings > Connections: brokers in priority order with their checks, Test,
 * and adding, editing, removing and reranking connections.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import BrokerConnections from '../app/components/BrokerConnections';
import {
  checkSummary,
  emptyForm,
  formFromStored,
  movePlatform,
  requestBody,
  saveMessage,
} from '../app/lib/brokerConnections';

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

const STATUS = {
  default: 'oanda',
  priority: ['oanda', 'mt5', 'ib', 'alpaca'],
  overridden: [],
  connections: [
    {
      label: 'oanda:default',
      platform: 'oanda',
      account: 'default',
      account_mode: 'paper',
      is_default: true,
      source: 'env',
      check: { status: 'connected', error: null, latency_ms: 42, checked_at: 'x' },
    },
    {
      label: 'alpaca:paper',
      platform: 'alpaca',
      account: 'paper',
      account_mode: 'paper',
      is_default: true,
      source: 'app',
      check: null,
    },
  ],
};

const STORED_ALPACA = {
  id: 7,
  platform: 'alpaca',
  account: 'paper',
  label: 'alpaca:paper',
  account_mode: 'paper',
  currency: 'USD',
  is_default: true,
  settings: {},
  secrets_set: { api_key: true, api_secret: true },
  secret_error: null,
};

const STORED = {
  connections: [STORED_ALPACA],
  platforms: ['oanda', 'mt5', 'ib', 'alpaca'],
  priority: null,
  priority_locked: false,
  encryption_ready: true,
  auth: { trading_auth_required: false, mfa_required: false },
};

/** Route fetches by URL; `writes` records every non-GET call. */
function mockApi(overrides: { status?: unknown; stored?: unknown } = {}) {
  const writes: { url: string; method: string; body: any }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      writes.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/test')) {
        return respond({
          label: 'alpaca:paper',
          check: { status: 'unreachable', error: 'timeout', latency_ms: 3, checked_at: 'y' },
        });
      }
      return respond({ ok: true, sync_error: null });
    }
    if (url.includes('/api/brokers/status')) return respond(overrides.status ?? STATUS);
    if (url.includes('/api/brokers/connections')) return respond(overrides.stored ?? STORED);
    return respond({}, 404);
  });
  global.fetch = fetchMock as any;
  return writes;
}

describe('helpers', () => {
  it('describes each check state', () => {
    expect(checkSummary(null).text).toBe('Not checked yet');
    expect(
      checkSummary({ status: 'connected', error: null, latency_ms: 5, checked_at: null }).text
    ).toBe('Connected (5 ms)');
    expect(
      checkSummary({ status: 'unreachable', error: 'refused', latency_ms: 1, checked_at: null })
    ).toEqual({ tone: 'bad', text: 'Unreachable: refused' });
  });

  it('reports the check that runs right after a save', () => {
    const ok = { status: 'connected' as const, error: null, latency_ms: 40, checked_at: null };
    const bad = {
      status: 'unreachable' as const,
      error: '401 Unauthorized',
      latency_ms: 3,
      checked_at: null,
    };
    expect(saveMessage('Connection added.', { sync_error: null, check: ok })).toEqual({
      kind: 'ok',
      text: 'Connection added. Connected (40 ms).',
    });
    expect(saveMessage('Connection added.', { check: bad })).toEqual({
      kind: 'error',
      text: 'Connection added. Check failed. Unreachable: 401 Unauthorized',
    });
    expect(saveMessage('Connection saved.', { check_error: 'timeout' }).text).toBe(
      'Connection saved. It could not be checked: timeout'
    );
    expect(saveMessage('Connection saved.', { sync_error: 'down' }).kind).toBe('error');
    expect(saveMessage('Connection removed.', { sync_error: null })).toEqual({
      kind: 'ok',
      text: 'Connection removed.',
    });
  });

  it('moves a broker up and down, stopping at the ends', () => {
    const order = ['oanda', 'mt5', 'ib', 'alpaca'];
    expect(movePlatform(order, 'ib', -1)).toEqual(['oanda', 'ib', 'mt5', 'alpaca']);
    expect(movePlatform(order, 'oanda', -1)).toEqual(order);
    expect(movePlatform(order, 'alpaca', 1)).toEqual(order);
  });

  it('splits settings from secrets and leaves blank secrets out', () => {
    const form = {
      ...emptyForm('oanda'),
      account: ' Practice ',
      values: { account_id: '101-1', token: '' },
    };
    expect(requestBody(form)).toEqual({
      platform: 'oanda',
      account: 'practice',
      account_mode: 'paper',
      currency: 'USD',
      is_default: true,
      settings: { account_id: '101-1' },
      limits: {
        max_orders_per_day: '',
        max_daily_loss: '',
        max_daily_equity_loss: '',
        max_drawdown: '',
      },
      prop_rules: null,
    });
    expect(requestBody({ ...form, values: { token: 't' } }).secrets).toEqual({ token: 't' });
    expect(formFromStored(STORED_ALPACA as any).values).toEqual({});
  });

  it("round-trips a connection's own limits and prop rules", () => {
    const stored = {
      ...STORED_ALPACA,
      limits: { max_drawdown: 2000 },
      prop_rules: { firm: 'FTMO', initial_balance: 10000 },
    };
    const form = formFromStored(stored as any);
    expect(form.limits).toEqual({ max_drawdown: '2000' });
    const body = requestBody({ ...form, limits: { ...form.limits, max_daily_loss: ' 300 ' } });
    expect(body.limits).toMatchObject({ max_drawdown: '2000', max_daily_loss: '300' });
    expect(JSON.parse(body.prop_rules as string)).toEqual(stored.prop_rules);
    expect(requestBody({ ...form, prop_rules: '  ' }).prop_rules).toBeNull();
  });
});

describe('BrokerConnections', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists brokers in priority order with their connections', async () => {
    mockApi();
    render(<BrokerConnections />);
    await waitFor(() => expect(screen.getByText('Connected (42 ms)')).toBeInTheDocument());

    const items = screen
      .getAllByRole('listitem')
      .filter((li) => li.parentElement?.tagName === 'OL');
    expect(
      items.map(
        (li) => within(li).getAllByText(/OANDA|MT5|Interactive Brokers|Alpaca/)[0].textContent
      )
    ).toEqual(['OANDA', 'MT5', 'Interactive Brokers', 'Alpaca']);
    expect(screen.getByText('.env')).toBeInTheDocument();
    // A .env connection can be tested but not edited here.
    expect(screen.queryByRole('button', { name: 'Edit OANDA default' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit Alpaca paper' })).toBeInTheDocument();
  });

  it('tests one connection', async () => {
    const writes = mockApi();
    render(<BrokerConnections />);
    await waitFor(() => screen.getByRole('button', { name: 'Test Alpaca paper' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test Alpaca paper' }));
    await waitFor(() => expect(screen.getByText('Unreachable: timeout')).toBeInTheDocument());
    expect(writes[0].url).toContain('/api/brokers/alpaca%3Apaper/test');
  });

  it('moves a broker up', async () => {
    const writes = mockApi();
    render(<BrokerConnections />);
    await waitFor(() => screen.getByRole('button', { name: 'Move MT5 up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move MT5 up' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      method: 'PUT',
      body: { priority: ['mt5', 'oanda', 'ib', 'alpaca'] },
    });
  });

  it('adds a connection', async () => {
    const writes = mockApi();
    render(<BrokerConnections />);
    await waitFor(() => screen.getByRole('button', { name: 'Add connection' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }));
    const form = screen.getByRole('form', { name: 'Add a broker connection' });
    fireEvent.change(within(form).getByLabelText(/Account ID/), { target: { value: '101-9' } });
    fireEvent.change(within(form).getByLabelText(/API token/), { target: { value: 'secret' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('Connection added.')).toBeInTheDocument());
    expect(writes[0]).toMatchObject({
      method: 'POST',
      body: { platform: 'oanda', settings: { account_id: '101-9' }, secrets: { token: 'secret' } },
    });
  });

  it('shows an app connection that .env overrides as ignored', async () => {
    mockApi({
      status: { ...STATUS, overridden: ['oanda:mine'] },
      stored: {
        ...STORED,
        connections: [
          { ...STORED_ALPACA, id: 9, platform: 'oanda', account: 'mine', label: 'oanda:mine' },
        ],
      },
    });
    render(<BrokerConnections />);
    await waitFor(() =>
      expect(screen.getByText('(ignored: .env configures OANDA)')).toBeInTheDocument()
    );
  });

  it('warns when credentials cannot be stored', async () => {
    mockApi({ stored: { ...STORED, encryption_ready: false } });
    render(<BrokerConnections />);
    await waitFor(() => expect(screen.getByText(/SETTINGS_ENCRYPTION_KEY/)).toBeInTheDocument());
  });

  it('says no broker is connected when none is configured', async () => {
    mockApi({ status: { ...STATUS, connections: [] }, stored: { ...STORED, connections: [] } });
    render(<BrokerConnections />);
    await waitFor(() => expect(screen.getByText(/No broker connected/)).toBeInTheDocument());
  });
});
