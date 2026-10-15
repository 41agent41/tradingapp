/**
 * StartupNotice covers the page while the backend reports it is not ready,
 * and gets out of the way once it is.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import StartupNotice from '../app/components/StartupNotice';

function respond(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StartupNotice', () => {
  it('shows why the app is not ready', async () => {
    vi.stubGlobal(
      'fetch',
      respond(503, {
        state: 'waiting_for_database',
        ready: false,
        detail: 'waiting for the database at db:5432/tradingapp',
      })
    );
    render(<StartupNotice />);
    expect(await screen.findByText('Waiting for the database')).toBeTruthy();
    expect(screen.getByText(/db:5432\/tradingapp/)).toBeTruthy();
  });

  it('says a wrong encryption key will not fix itself', async () => {
    vi.stubGlobal(
      'fetch',
      respond(503, { state: 'key_mismatch', ready: false, detail: 'wrong key' })
    );
    render(<StartupNotice />);
    expect(await screen.findByText(/encryption key does not match/)).toBeTruthy();
    expect(screen.getByText(/will not start until this is fixed/)).toBeTruthy();
  });

  it('renders nothing once ready', async () => {
    const fetchMock = respond(200, { state: 'ready', ready: true, detail: null });
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<StartupNotice />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });
});
