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
  delete process.env.NEXT_PUBLIC_API_TOKEN;
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

describe('apiUrl', () => {
  it('falls back to http://localhost:4000 when NEXT_PUBLIC_API_URL is unset', async () => {
    const mod = await import('../app/lib/api');
    expect(mod.apiBaseUrl).toBe('http://localhost:4000');
    expect(mod.apiUrl('/foo')).toBe('http://localhost:4000/foo');
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

  it('attaches Bearer token from NEXT_PUBLIC_API_TOKEN when set', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
    process.env.NEXT_PUBLIC_API_TOKEN = 'tok-abc-123';
    const fetchMock = mockFetch();

    const mod = await import('../app/lib/api');
    await mod.apiFetch('/x');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer tok-abc-123');
  });

  it('does not attach Authorization when the token is empty', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
    const fetchMock = mockFetch();

    const mod = await import('../app/lib/api');
    await mod.apiFetch('/x');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBeNull();
  });

  it('honours skipAuth=true and omits the Authorization header', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
    process.env.NEXT_PUBLIC_API_TOKEN = 'tok-skip';
    const fetchMock = mockFetch();

    const mod = await import('../app/lib/api');
    await mod.apiFetch('/api/health', { skipAuth: true });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBeNull();
  });

  it('preserves caller-supplied headers when attaching the token', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
    process.env.NEXT_PUBLIC_API_TOKEN = 'tok-merge';
    const fetchMock = mockFetch();

    const mod = await import('../app/lib/api');
    await mod.apiFetch('/x', {
      headers: { 'X-Data-Query-Enabled': 'true', 'Content-Type': 'application/json' },
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer tok-merge');
    expect(headers.get('x-data-query-enabled')).toBe('true');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('does not overwrite a caller-supplied Authorization header', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.test';
    process.env.NEXT_PUBLIC_API_TOKEN = 'env-token';
    const fetchMock = mockFetch();

    const mod = await import('../app/lib/api');
    await mod.apiFetch('/x', { headers: { Authorization: 'Bearer caller-supplied' } });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer caller-supplied');
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
  it('returns an empty object when no token is configured', async () => {
    const mod = await import('../app/lib/api');
    expect(mod.socketAuth()).toEqual({});
  });

  it('returns { auth: { token } } when NEXT_PUBLIC_API_TOKEN is set', async () => {
    process.env.NEXT_PUBLIC_API_TOKEN = 'socket-tok';
    const mod = await import('../app/lib/api');
    expect(mod.socketAuth()).toEqual({ auth: { token: 'socket-tok' } });
  });
});
