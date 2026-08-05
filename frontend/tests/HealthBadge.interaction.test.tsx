/**
 * RTL interaction tests for HealthBadge — clicking the badge opens a
 * popover with per-service rows, clicking outside closes it.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import HealthBadge from '../app/components/HealthBadge';

function mockFetch(body: unknown) {
  global.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as any;
}

describe('HealthBadge popover interactions', () => {
  beforeEach(() => {
    mockFetch({
      status: 'healthy',
      services: {
        database: { connected: true },
        broker_service: { connected: true, status: 'ok' },
        cache: { connected: true, enabled: true },
        streaming: { connected: true, enabled: true },
        backfill: { enabled: true, last_error: null },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens a popover when clicked and lists the five services', async () => {
    render(<HealthBadge intervalMs={60_000} />);
    // Wait for the first fetch to land so the summary reflects "healthy".
    await waitFor(() => expect(screen.getByText('All systems healthy')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('IB Gateway')).toBeInTheDocument();
    expect(screen.getByText('Database')).toBeInTheDocument();
    expect(screen.getByText('Cache')).toBeInTheDocument();
    expect(screen.getByText('Streaming')).toBeInTheDocument();
    expect(screen.getByText('Backfill')).toBeInTheDocument();
  });

  it('closes the popover when clicking outside', async () => {
    render(
      <div>
        <HealthBadge intervalMs={60_000} />
        <button type="button">elsewhere</button>
      </div>,
    );
    await waitFor(() => expect(screen.getByText('All systems healthy')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /System health/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // Click outside.
    act(() => {
      fireEvent.mouseDown(screen.getByText('elsewhere'));
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
