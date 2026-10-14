/**
 * Unit tests for the pure mapping helpers in `HealthBadge.tsx`.
 * The component itself is exercised lightly via a smoke render to
 * confirm the polling effect is wired without throwing.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import HealthBadge, { __test } from '../app/components/HealthBadge';

const { rowsFromPayload, summarise, brokerRows } = __test;

describe('rowsFromPayload', () => {
  it('reports backend down when the fetch itself failed', () => {
    const rows = rowsFromPayload(null, 'NetworkError');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'backend', state: 'down', detail: 'NetworkError' });
  });

  it('maps a fully healthy payload to ok across all rows', () => {
    const rows = rowsFromPayload(
      {
        status: 'healthy',
        services: {
          database: { connected: true },
          broker_service: { connected: true, status: 'ok' },
          cache: { connected: true, enabled: true },
          streaming: { connected: true, enabled: true },
          backfill: { enabled: true, last_error: null },
        },
      },
      null
    );
    expect(rows.map((r) => r.state)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
  });

  it('shows disabled when a subsystem is turned off rather than down', () => {
    const rows = rowsFromPayload(
      {
        services: {
          database: { connected: true },
          broker_service: { connected: true },
          cache: { connected: false, enabled: false },
          streaming: { connected: false, enabled: false },
          backfill: { enabled: false, last_error: null },
        },
      },
      null
    );
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.state]));
    expect(byKey.cache).toBe('disabled');
    expect(byKey.stream).toBe('disabled');
    expect(byKey.backfill).toBe('disabled');
  });

  it('surfaces the broker service error state when broker_service.status is error', () => {
    const rows = rowsFromPayload(
      {
        services: {
          database: { connected: true },
          broker_service: { connected: false, status: 'error', error: 'connection refused' },
          cache: { connected: true, enabled: true },
          streaming: { connected: true, enabled: true },
          backfill: { enabled: true, last_error: null },
        },
      },
      null
    );
    const svc = rows.find((r) => r.key === 'broker_service');
    expect(svc?.state).toBe('down');
    expect(svc?.detail).toBe('connection refused');
  });

  it('adds a row per broker connection after the broker service row', () => {
    const rows = rowsFromPayload(
      {
        services: {
          database: { connected: true },
          broker_service: { connected: true },
          brokers: {
            default: 'oanda',
            connections: [
              {
                label: 'oanda:default',
                platform: 'oanda',
                account: 'default',
                is_default: true,
                status: 'connected',
              },
              {
                label: 'mt5:default',
                platform: 'mt5',
                account: 'default',
                status: 'unreachable',
                error: 'timeout',
              },
            ],
          },
          cache: { connected: true, enabled: true },
          streaming: { connected: true, enabled: true },
          backfill: { enabled: true, last_error: null },
        },
      },
      null
    );
    expect(rows.slice(0, 3).map((r) => [r.key, r.label, r.state])).toEqual([
      ['broker_service', 'Broker service', 'ok'],
      ['broker:oanda:default', 'OANDA · default', 'ok'],
      ['broker:mt5:default', 'MT5', 'warn'],
    ]);
    expect(rows[2].detail).toBe('timeout');
  });

  it('hides broker rows while the broker service itself is down', () => {
    const rows = rowsFromPayload(
      {
        services: {
          broker_service: { connected: false, status: 'error' },
          brokers: { default: null, connections: [] },
        },
      },
      null
    );
    expect(rows.some((r) => r.key.startsWith('broker:'))).toBe(false);
  });
});

describe('brokerRows', () => {
  it('says no broker is connected when none is configured', () => {
    expect(brokerRows({ default: null, connections: [] })).toEqual([
      { key: 'broker:none', label: 'No broker connected', state: 'warn' },
    ]);
  });

  it('marks an unreachable default broker down and an unchecked one unknown', () => {
    const rows = brokerRows({
      default: 'ib',
      connections: [
        {
          label: 'ib:default',
          platform: 'ib',
          account: 'default',
          is_default: true,
          status: 'unreachable',
        },
        { label: 'alpaca:default', platform: 'alpaca', account: 'default', status: 'unchecked' },
      ],
    });
    expect(rows.map((r) => r.state)).toEqual(['down', 'unknown']);
  });

  it('names the account when a platform has more than one', () => {
    const rows = brokerRows({
      connections: [
        { label: 'oanda:live', platform: 'oanda', account: 'live', status: 'connected' },
        { label: 'oanda:practice', platform: 'oanda', account: 'practice', status: 'connected' },
      ],
    });
    expect(rows.map((r) => r.label)).toEqual(['OANDA (live)', 'OANDA (practice)']);
  });

  it('marks backfill as warn when last_error is populated even if running', () => {
    const rows = rowsFromPayload(
      {
        services: {
          database: { connected: true },
          broker_service: { connected: true },
          cache: { connected: true, enabled: true },
          streaming: { connected: true, enabled: true },
          backfill: { enabled: true, running: true, last_error: 'IB timeout' },
        },
      },
      null
    );
    const backfill = rows.find((r) => r.key === 'backfill');
    expect(backfill?.state).toBe('warn');
    expect(backfill?.detail).toBe('IB timeout');
  });
});

describe('summarise', () => {
  it('reports down when any service is down', () => {
    const out = summarise([
      { key: 'a', label: 'A', state: 'ok' },
      { key: 'b', label: 'B', state: 'down' },
    ]);
    expect(out.state).toBe('down');
  });

  it('reports warn when no down but at least one warn', () => {
    const out = summarise([
      { key: 'a', label: 'A', state: 'ok' },
      { key: 'b', label: 'B', state: 'warn' },
    ]);
    expect(out.state).toBe('warn');
  });

  it('reports ok when all services are ok or disabled', () => {
    const out = summarise([
      { key: 'a', label: 'A', state: 'ok' },
      { key: 'b', label: 'B', state: 'disabled' },
    ]);
    expect(out.state).toBe('ok');
  });

  it('reports disabled when every row is disabled', () => {
    const out = summarise([
      { key: 'a', label: 'A', state: 'disabled' },
      { key: 'b', label: 'B', state: 'disabled' },
    ]);
    expect(out.state).toBe('disabled');
  });
});

describe('HealthBadge render', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders an aria-labelled button without crashing when fetch fails', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('boom'));
    vi.stubGlobal('fetch', fetchMock);

    render(<HealthBadge intervalMs={60_000} />);

    expect(screen.getByRole('button')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalled();
  });
});
