/**
 * Security headers for every page (S-12).
 *
 * The Content Security Policy lets the pages load only what the app itself
 * serves. Next.js starts each page with inline scripts and the charts set
 * inline styles, so both stay allowed; what the policy stops is a script,
 * frame or form pointed at another site, and the app being framed by one.
 * Live prices use a WebSocket to the page's own address, or to
 * NEXT_PUBLIC_API_URL when the backend is addressed directly.
 */
function contentSecurityPolicy(env = process.env) {
  const dev = env.NODE_ENV !== 'production';
  let api = '';
  try {
    api = env.NEXT_PUBLIC_API_URL ? new URL(env.NEXT_PUBLIC_API_URL).origin : '';
  } catch {
    api = '';
  }
  const connect = ["'self'", 'ws:', 'wss:', api].filter(Boolean).join(' ');
  return [
    "default-src 'self'",
    // Development builds evaluate code for hot reloading.
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function securityHeaders(env = process.env) {
  return [
    { key: 'Content-Security-Policy', value: contentSecurityPolicy(env) },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'same-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  ];
}

module.exports = { contentSecurityPolicy, securityHeaders };
