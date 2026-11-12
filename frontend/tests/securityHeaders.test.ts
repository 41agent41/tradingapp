/**
 * The security headers every page is served with (S-12).
 */
import { describe, expect, it } from 'vitest';

const { contentSecurityPolicy, securityHeaders } = require('../securityHeaders');

describe('contentSecurityPolicy', () => {
  it('loads only what the app serves and cannot be framed', () => {
    const csp: string = contentSecurityPolicy({ NODE_ENV: 'production' });
    const rules = Object.fromEntries(
      csp.split('; ').map((rule) => [rule.split(' ')[0], rule.split(' ').slice(1).join(' ')])
    );
    expect(rules['default-src']).toBe("'self'");
    expect(rules['script-src']).toBe("'self' 'unsafe-inline'");
    expect(rules['connect-src']).toBe("'self' ws: wss:");
    expect(rules['frame-ancestors']).toBe("'none'");
    expect(rules['object-src']).toBe("'none'");
    expect(rules['form-action']).toBe("'self'");
  });

  it('allows eval only in development, for hot reloading', () => {
    expect(contentSecurityPolicy({ NODE_ENV: 'development' })).toContain("'unsafe-eval'");
    expect(contentSecurityPolicy({ NODE_ENV: 'production' })).not.toContain('unsafe-eval');
  });

  it('adds a backend addressed directly, by its origin only', () => {
    const csp = contentSecurityPolicy({
      NODE_ENV: 'production',
      NEXT_PUBLIC_API_URL: 'https://api.example.test:4000/some/path',
    });
    expect(csp).toContain("connect-src 'self' ws: wss: https://api.example.test:4000;");
    // A value that is not a URL adds nothing.
    expect(
      contentSecurityPolicy({ NODE_ENV: 'production', NEXT_PUBLIC_API_URL: 'not a url' })
    ).toContain("connect-src 'self' ws: wss:;");
  });
});

describe('securityHeaders', () => {
  it('sets the policy and the headers that go with it', () => {
    const headers = Object.fromEntries(
      securityHeaders({ NODE_ENV: 'production' }).map((h: { key: string; value: string }) => [
        h.key,
        h.value,
      ])
    );
    expect(Object.keys(headers).sort()).toEqual([
      'Content-Security-Policy',
      'Permissions-Policy',
      'Referrer-Policy',
      'X-Content-Type-Options',
      'X-Frame-Options',
    ]);
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
  });
});
