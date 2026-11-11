/**
 * The "Signed-in browsers" list on Settings > Security (S-05).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SessionsSection from '../app/components/SessionsSection';

const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0';
const SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

function session(id: string, userAgent: string, current: boolean) {
  return {
    id,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ip: '192.168.1.20',
    user_agent: userAgent,
    current,
  };
}

const TWO = [session('aaaaaaaaaaaa', FIREFOX, true), session('bbbbbbbbbbbb', SAFARI, false)];

/** Answers by path, and records each call as "METHOD path". */
function mockApi(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: string[] = [];
  global.fetch = vi.fn(async (input: any, init?: RequestInit) => {
    const path = new URL(String(input), 'https://api.test').pathname;
    const key = `${init?.method ?? 'GET'} ${path}`;
    calls.push(key);
    const hit = routes[key] ?? { status: 404, body: { error: 'Not found' } };
    return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200 });
  }) as any;
  return calls;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('SessionsSection', () => {
  it('lists the browsers signed in and marks this one', async () => {
    mockApi({ 'GET /api/auth/sessions': { body: { sessions: TWO } } });
    render(<SessionsSection onDone={vi.fn()} leave={vi.fn()} />);

    expect(await screen.findByText('Firefox on Linux')).toBeInTheDocument();
    expect(screen.getByText('Safari on iOS')).toBeInTheDocument();
    expect(screen.getAllByText('this browser')).toHaveLength(1);
    expect(screen.getAllByText(/192\.168\.1\.20 · signed in just now/)).toHaveLength(2);
  });

  it('signs another browser out and reloads the list', async () => {
    const calls = mockApi({
      'GET /api/auth/sessions': { body: { sessions: TWO } },
      'DELETE /api/auth/sessions/bbbbbbbbbbbb': { body: { ended: true } },
    });
    const onDone = vi.fn();
    const leave = vi.fn();
    render(<SessionsSection onDone={onDone} leave={leave} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sign out Safari on iOS' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('Safari on iOS signed out.', 'ok'));
    expect(calls.filter((c) => c === 'GET /api/auth/sessions')).toHaveLength(2);
    expect(leave).not.toHaveBeenCalled();
  });

  it('signs this browser out and leaves for the login page', async () => {
    const calls = mockApi({
      'GET /api/auth/sessions': { body: { sessions: TWO } },
      'POST /api/auth/logout': { body: { authenticated: false } },
    });
    const leave = vi.fn();
    render(<SessionsSection onDone={vi.fn()} leave={leave} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sign out this browser' }));
    await waitFor(() => expect(leave).toHaveBeenCalledTimes(1));
    expect(calls).toContain('POST /api/auth/logout');
  });

  it('asks before signing out everywhere', async () => {
    const calls = mockApi({
      'GET /api/auth/sessions': { body: { sessions: TWO } },
      'POST /api/auth/logout-all': { body: { authenticated: false, ended: 2 } },
    });
    const leave = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SessionsSection onDone={vi.fn()} leave={leave} />);

    const button = await screen.findByRole('button', { name: 'Sign out everywhere' });
    fireEvent.click(button);
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(calls).not.toContain('POST /api/auth/logout-all');

    confirm.mockReturnValue(true);
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await waitFor(() => expect(leave).toHaveBeenCalledTimes(1));
    expect(calls).toContain('POST /api/auth/logout-all');
  });

  it('reports a failure and stays on the page', async () => {
    mockApi({
      'GET /api/auth/sessions': { body: { sessions: TWO } },
      'DELETE /api/auth/sessions/bbbbbbbbbbbb': {
        status: 404,
        body: { error: 'Not found', message: 'No such session.' },
      },
    });
    const onDone = vi.fn();
    render(<SessionsSection onDone={onDone} leave={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Sign out Safari on iOS' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('No such session.', 'error'));
  });

  it('says so when no browser is signed in', async () => {
    mockApi({ 'GET /api/auth/sessions': { body: { sessions: [] } } });
    render(<SessionsSection onDone={vi.fn()} leave={vi.fn()} />);

    expect(await screen.findByText(/No browser is signed in/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out everywhere' })).toBeDisabled();
  });
});
