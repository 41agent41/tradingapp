/**
 * Forwards `/api/*` and `/socket.io/*` from the frontend's own address to the
 * backend, so the browser talks to one origin and the backend's address is
 * never built into the page.
 *
 * Plain `http`, no dependency: requests are streamed both ways and WebSocket
 * upgrades (Socket.IO's live updates) are piped through. Each forwarded
 * request carries the browser's address in `X-Forwarded-For`; the backend
 * trusts that header only from this container (`TRUST_PROXY` in compose), so
 * login lockout and the settings audit still see the real client.
 *
 * Next's own `rewrites` would proxy too, but they drop the client address and
 * cut every request off at 30 seconds.
 */
const http = require('http');
const https = require('https');

const BACKEND_PATH = /^\/(api|socket\.io)(\/|\?|$)/;

// Hop-by-hop headers describe one connection and are not forwarded on a
// plain request (an upgrade keeps them; they are the point of it).
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'upgrade', 'te', 'trailer'];

function isBackendPath(url) {
  return BACKEND_PATH.test(url || '');
}

function sameOrigin(origin, host) {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function forwardedHeaders(req, target, { upgrade = false } = {}) {
  const headers = { ...req.headers };
  if (!upgrade) for (const name of HOP_BY_HOP) delete headers[name];

  // The page and the API now share an origin, so a request from our own page
  // needs no CORS approval. Dropping its Origin lets the backend treat it as
  // same-origin; a request from any other site keeps its Origin and is still
  // checked against CORS_ORIGINS.
  if (sameOrigin(headers.origin, req.headers.host)) delete headers.origin;

  const remote = req.socket.remoteAddress || '';
  headers['x-forwarded-for'] = headers['x-forwarded-for']
    ? `${headers['x-forwarded-for']}, ${remote}`
    : remote;
  headers['x-forwarded-host'] = headers['x-forwarded-host'] || req.headers.host || '';
  headers['x-forwarded-proto'] =
    headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  headers.host = target.host;
  return headers;
}

function requestOptions(req, target, headers) {
  return {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: req.url,
    headers,
  };
}

function rawHeaderLines(res) {
  const lines = [];
  for (let i = 0; i < res.rawHeaders.length; i += 2) {
    lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
  }
  return lines.join('\r\n');
}

/** @param {string} backendUrl e.g. http://172.20.0.5:4000 */
function createBackendProxy(backendUrl) {
  const target = new URL(backendUrl);
  const client = target.protocol === 'https:' ? https : http;

  function web(req, res) {
    const upstream = client.request(
      requestOptions(req, target, forwardedHeaders(req, target)),
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
      }
    );
    upstream.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Backend unavailable', message: err.message }));
      } else {
        res.destroy();
      }
    });
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  }

  function ws(req, socket, head) {
    const upstream = client.request(
      requestOptions(req, target, forwardedHeaders(req, target, { upgrade: true }))
    );
    socket.on('error', () => upstream.destroy());
    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${rawHeaderLines(upRes)}\r\n\r\n`);
      if (upHead && upHead.length) socket.write(upHead);
      if (head && head.length) upSocket.write(head);
      upSocket.on('error', () => socket.destroy());
      socket.on('close', () => upSocket.destroy());
      upSocket.on('close', () => socket.destroy());
      upSocket.pipe(socket).pipe(upSocket);
    });
    // The backend answered without upgrading (a refused handshake): pass the
    // status on and close.
    upstream.on('response', (upRes) => {
      upRes.resume();
      socket.end(
        `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n` +
          'Connection: close\r\nContent-Length: 0\r\n\r\n'
      );
    });
    upstream.on('error', () => socket.destroy());
    upstream.end();
  }

  return { handles: isBackendPath, web, ws };
}

module.exports = { createBackendProxy, isBackendPath, forwardedHeaders };
