/**
 * Unit tests for the pure mapping helpers in `HealthBadge.tsx`.
 * The component itself is exercised lightly via a smoke render to
 * confirm the polling effect is wired without throwing.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import HealthBadge, { __test } from '../app/components/HealthBadge';

const { rowsFromPayload, summarise } = __test;

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
      null,
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
      null,
    );
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.state]));
    expect(byKey.cache).toBe('disabled');
    expect(byKey.stream).toBe('disabled');
    expect(byKey.backfill).toBe('disabled');
  });

  it('surfaces IB error state when broker_service.status is error', () => {
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
      null,
    );
    const ib = rows.find((r) => r.key === 'ib');
    expect(ib?.state).toBe('down');
    expect(ib?.detail).toBe('connection refused');
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
      null,
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
