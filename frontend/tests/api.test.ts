/**
 * Unit tests for `app/lib/api.ts`.
 *
 * The module reads `process.env.NEXT_PUBLIC_*` at import time, so each
 * test that needs a different env mutates `process.env`, calls
 * `vi.resetModules()`, and re-imports the module under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_FETCH = global.fetch;

function mockFetch() {
  const fn = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })
  );
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => {
  vi.resetModules();
  delete process.env.NEXT_PUBLIC_API_URL;
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe('apiUrl', () => {
  it('uses relative URLs on the page origin when NEXT_PUBLIC_API_URL is unset', async () => {
    const mod = await import('../app/lib/api');
    expect(mod.apiBaseUrl).toBe('');
    expect(mod.apiUrl('/foo')).toBe('/foo');
    expect(mod.apiUrl('foo')).toBe('/foo');
  });

  it('points Socket.IO at the page origin when NEXT_PUBLIC_API_URL is unset', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://10.0.0.5:3000' } });
    const mod = await import('../app/lib/api');
    expect(mod.socketUrl()).toBe('http://10.0.0.5:3000');
    vi.unstubAllGlobals();
  });

  it('sends a relative request to the same origin', async () => {
    const fetchMock = mockFetch();
    const mod = await import('../app/lib/api');
    await mod.apiFetch('/api/health');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/health');
  });

  it('strips trailing slashes off NEXT_PUBLIC_API_URL', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://example.com/';
    const mod = await import('../app/lib/api');
    expect(mod.apiBaseUrl).toBe('https://example.com');
    expect(mod.apiUrl('/foo')).toBe('https://example.com/foo');
  });

  it('handles paths without a leading slash', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://example.com';
    const mod = await import('../app/lib/api');
    expect(mod.apiUrl('foo')).toBe('https://example.com/foo');
  });
});

describe('apiFetch', () => {
  it('prefixes relative paths with NEXT_PUBLIC_API_URL', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
    const fetchMock = mockFetch();

    const mod = await import('../app/lib/api');
    await mod.apiFetch('/api/market-data/history');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/api/market-data/history');
  });

  it('leaves absolute URLs untouched', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
    const fetchMock = mockFetch();

    const mod = await import('../app/lib/api');
    await mod.apiFetch('https://example.org/health');

    expect(fetchMock.mock.calls[0][0]).toBe('https://example.org/health');
  });

  it('sends the session cookie with every request', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
    const fetchMock = mockFetch();

    const mod = await import('../app/lib/api');
    await mod.apiFetch('/x');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe('include');
  });

  it('never attaches an Authorization header of its own', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
    const fetchMock = mockFetch();

    const mod = await import('../app/lib/api');
    await mod.apiFetch('/x');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBeNull();
  });

  it('preserves caller-supplied headers', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
    const fetchMock = mockFetch();

    const mod = await import('../app/lib/api');
    await mod.apiFetch('/x', {
      headers: { 'X-Data-Query-Enabled': 'true', 'Content-Type': 'application/json' },
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('x-data-query-enabled')).toBe('true');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('redirects to /login on a 401', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
    global.fetch = vi.fn(
      async () => new Response('{}', { status: 401 })
    ) as unknown as typeof fetch;
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { pathname: '/trade', search: '?x=1', assign } });

    const mod = await import('../app/lib/api');
    const res = await mod.apiFetch('/x');

    expect(res.status).toBe(401);
    expect(assign).toHaveBeenCalledWith('/login?next=%2Ftrade%3Fx%3D1');
    vi.unstubAllGlobals();
  });

  it('does not redirect when skipAuthRedirect is set', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
    global.fetch = vi.fn(
      async () => new Response('{}', { status: 401 })
    ) as unknown as typeof fetch;
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { pathname: '/trade', search: '', assign } });

    const mod = await import('../app/lib/api');
    await mod.apiFetch('/api/auth/login', { skipAuthRedirect: true });

    expect(assign).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('does not redirect on a 401 about the MFA code', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
    global.fetch = vi.fn(
      async () => new Response('{}', { status: 401, headers: { 'X-Step-Up-Required': 'mfa' } })
    ) as unknown as typeof fetch;
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { pathname: '/settings', search: '', assign } });

    const mod = await import('../app/lib/api');
    const res = await mod.apiFetch('/api/settings/ORDER_MAX_QUANTITY', { method: 'PUT' });

    expect(res.status).toBe(401);
    expect(assign).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('attaches a generated X-Request-Id when the caller did not supply one', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
    const fetchMock = mockFetch();

    const mod = await import('../app/lib/api');
    await mod.apiFetch('/x');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('X-Request-Id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('preserves a caller-supplied X-Request-Id', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
    const fetchMock = mockFetch();

    const mod = await import('../app/lib/api');
    await mod.apiFetch('/x', { headers: { 'X-Request-Id': 'rid-caller' } });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('X-Request-Id')).toBe('rid-caller');
  });
});

describe('newRequestId', () => {
  it('returns a uuid-shaped string', async () => {
    const mod = await import('../app/lib/api');
    const id = mod.newRequestId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('returns distinct ids across calls', async () => {
    const mod = await import('../app/lib/api');
    const a = mod.newRequestId();
    const b = mod.newRequestId();
    expect(a).not.toBe(b);
  });
});

describe('socketAuth', () => {
  it('authenticates the handshake with the session cookie', async () => {
    const mod = await import('../app/lib/api');
    expect(mod.socketAuth()).toEqual({ withCredentials: true });
  });
});
