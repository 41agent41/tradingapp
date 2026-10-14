/**
 * The frontend server's /api and /socket.io forwarding (proxy.js), against a
 * real local backend stand-in.
 *
 * @vitest-environment node
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createBackendProxy, isBackendPath } = require('../proxy.js');

const servers: http.Server[] = [];
const sockets = new Set<import('net').Socket>();

function listen(server: http.Server): Promise<number> {
  servers.push(server);
  // Upgraded sockets are not closed by closeAllConnections, so track them.
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  );
}

afterEach(async () => {
  sockets.forEach((socket) => socket.destroy());
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections?.();
          s.close(() => resolve());
        })
    )
  );
});

/** A backend that echoes what it received. */
async function echoBackend() {
  const backend = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(201, { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=1; HttpOnly' });
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
    });
  });
  backend.on('upgrade', (req, socket) => {
    if (req.url?.includes('refuse')) {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `X-Seen-Origin: ${req.headers.origin ?? 'none'}\r\n\r\n`
    );
    socket.on('data', (chunk) => socket.write(`echo:${chunk}`));
  });
  return listen(backend);
}

async function frontendFor(backendPort: number) {
  const proxy = createBackendProxy(`http://127.0.0.1:${backendPort}`);
  const server = http.createServer((req, res) => {
    if (proxy.handles(req.url)) proxy.web(req, res);
    else res.end('next');
  });
  server.on('upgrade', (req, socket, head) => {
    if (proxy.handles(req.url)) proxy.ws(req, socket, head);
    else socket.destroy();
  });
  return listen(server);
}

function request(
  port: number,
  opts: http.RequestOptions,
  body?: string
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, ...opts }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data })
      );
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('isBackendPath', () => {
  it('matches the API and Socket.IO, and nothing else', () => {
    expect(isBackendPath('/api/health')).toBe(true);
    expect(isBackendPath('/api')).toBe(true);
    expect(isBackendPath('/socket.io/?EIO=4&transport=polling')).toBe(true);
    expect(isBackendPath('/apix')).toBe(false);
    expect(isBackendPath('/settings')).toBe(false);
    expect(isBackendPath('/_next/static/x.js')).toBe(false);
  });
});

describe('forwarding a request', () => {
  it('passes method, path, body, status and cookies through, with the client address', async () => {
    const front = await frontendFor(await echoBackend());
    const res = await request(
      front,
      {
        method: 'PUT',
        path: '/api/settings/X?y=1',
        headers: { 'Content-Type': 'application/json', Host: 'app.local:3000' },
      },
      '{"value":"1"}'
    );
    expect(res.status).toBe(201);
    expect(res.headers['set-cookie']).toEqual(['sid=1; HttpOnly']);
    const seen = JSON.parse(res.body);
    expect(seen).toMatchObject({
      method: 'PUT',
      url: '/api/settings/X?y=1',
      body: '{"value":"1"}',
    });
    expect(seen.headers['x-forwarded-for']).toMatch(/127\.0\.0\.1/);
    expect(seen.headers['x-forwarded-host']).toBe('app.local:3000');
    expect(seen.headers['x-forwarded-proto']).toBe('http');
  });

  it("drops the Origin of the page's own requests and keeps a foreign one", async () => {
    const front = await frontendFor(await echoBackend());
    const own = await request(front, {
      path: '/api/x',
      headers: { Host: 'app.local:3000', Origin: 'http://app.local:3000' },
    });
    expect(JSON.parse(own.body).headers.origin).toBeUndefined();
    const foreign = await request(front, {
      path: '/api/x',
      headers: { Host: 'app.local:3000', Origin: 'https://evil.example' },
    });
    expect(JSON.parse(foreign.body).headers.origin).toBe('https://evil.example');
  });

  it('answers 502 when the backend is down', async () => {
    const closed = http.createServer();
    const port = await listen(closed);
    await new Promise<void>((r) => closed.close(() => r()));
    servers.splice(servers.indexOf(closed), 1);
    const front = await frontendFor(port);
    const res = await request(front, { path: '/api/health' });
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body).error).toBe('Backend unavailable');
  });
});

function upgrade(port: number, path: string, origin?: string) {
  return new Promise<{ res: http.IncomingMessage; socket?: import('net').Socket }>(
    (resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          Host: 'app.local:3000',
          ...(origin ? { Origin: origin } : {}),
        },
      });
      req.on('upgrade', (res, socket) => resolve({ res, socket }));
      req.on('response', (res) => resolve({ res }));
      req.on('error', reject);
      req.end();
    }
  );
}

describe('forwarding a WebSocket upgrade', () => {
  it('upgrades through to the backend and pipes both ways', async () => {
    const front = await frontendFor(await echoBackend());
    const { res, socket } = await upgrade(
      front,
      '/socket.io/?EIO=4&transport=websocket',
      'http://app.local:3000'
    );
    expect(res.statusCode).toBe(101);
    expect(res.headers['x-seen-origin']).toBe('none');
    const reply = await new Promise<string>((resolve) => {
      socket!.once('data', (d) => resolve(String(d)));
      socket!.write('ping');
    });
    expect(reply).toBe('echo:ping');
    socket!.destroy();
  });

  it('passes a refused handshake on', async () => {
    const front = await frontendFor(await echoBackend());
    const { res } = await upgrade(front, '/socket.io/?refuse=1');
    expect(res.statusCode).toBe(403);
  });
});
