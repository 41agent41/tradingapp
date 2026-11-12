/**
 * The two rules for live connections (security sign-off): a WebSocket from a
 * site that is not allowed is refused, and a socket is closed when the login
 * session it was opened under ends.
 */
import crypto from 'crypto';
import { createServer, type IncomingMessage, type Server } from 'http';
import type { AddressInfo } from 'net';

import { Server as SocketIOServer } from 'socket.io';
import WebSocket from 'ws';

import { SESSION_COOKIE } from '../src/services/session.js';
import { SessionStore } from '../src/services/sessionStore.js';
import { allowSocketRequest, closeSocketsWithSessions } from '../src/services/socketGuard.js';

const SECRET = 'k'.repeat(48);
const HOUR = 3_600_000;

function cookieFor(id: string, expiresAt = Date.now() + HOUR): string {
  const payload = `v2.${expiresAt}.${id}`;
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `${SESSION_COOKIE}=${encodeURIComponent(`${payload}.${mac}`)}`;
}

describe('allowSocketRequest', () => {
  const request = (origin?: string) => ({ headers: { origin } }) as unknown as IncomingMessage;
  const only = (origin: string | undefined) => !origin || origin === 'http://app.lan:3000';

  it('accepts a handshake with no Origin or an allowed one', () => {
    for (const origin of [undefined, 'http://app.lan:3000']) {
      const callback = jest.fn();
      allowSocketRequest(request(origin), callback, only);
      expect(callback).toHaveBeenCalledWith(null, true);
    }
  });

  it('refuses a handshake from another site', () => {
    const callback = jest.fn();
    allowSocketRequest(request('http://other.lan:8080'), callback, only);
    expect(callback).toHaveBeenCalledWith('Origin not allowed', false);
  });
});

describe('live connections on a real server', () => {
  let http: Server;
  let io: SocketIOServer;
  let store: SessionStore;
  let url: string;
  const open: WebSocket[] = [];

  beforeAll(async () => {
    process.env.SESSION_SECRET = SECRET;
    store = new SessionStore();
    http = createServer();
    io = new SocketIOServer(http, {
      allowRequest: (req, callback) =>
        allowSocketRequest(req, callback, (origin) => !origin || origin === 'http://app.lan:3000'),
    });
    closeSocketsWithSessions(io, store);
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const { port } = http.address() as AddressInfo;
    url = `ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`;
  });

  afterAll(async () => {
    delete process.env.SESSION_SECRET;
    for (const ws of open) ws.terminate();
    await io.close();
  });

  /** Resolves 'open' or the HTTP status the handshake was refused with. */
  function handshake(
    headers: Record<string, string>,
    onMessage?: (ws: WebSocket, text: string) => void
  ): Promise<{ ws: WebSocket; result: unknown }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url, { headers });
      open.push(ws);
      // Listening from the start: the server's first packet can arrive with
      // the handshake itself.
      ws.on('message', (data) => onMessage?.(ws, String(data)));
      ws.on('open', () => resolve({ ws, result: 'open' }));
      ws.on('unexpected-response', (_req, res) => resolve({ ws, result: res.statusCode }));
      ws.on('error', () => undefined);
    });
  }

  /** Joins the default namespace and resolves once the server has accepted. */
  async function join(cookie?: string): Promise<{ ws: WebSocket; closed: Promise<void> }> {
    let joined: () => void = () => undefined;
    const accepted = new Promise<void>((resolve) => (joined = resolve));
    const { ws, result } = await handshake(cookie ? { Cookie: cookie } : {}, (socket, text) => {
      if (text.startsWith('0')) socket.send('40');
      if (text.startsWith('40')) joined();
    });
    expect(result).toBe('open');
    const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));
    await accepted;
    return { ws, closed };
  }

  it('refuses a WebSocket opened by a page on another site', async () => {
    const { result } = await handshake({ Origin: 'http://other.lan:8080' });
    // Refused before any socket exists, with an HTTP error.
    expect(result).toBe(400);
  });

  it('accepts one from an allowed site', async () => {
    const { result } = await handshake({ Origin: 'http://app.lan:3000' });
    expect(result).toBe('open');
  });

  it('closes the sockets of a session that ends, and leaves the others', async () => {
    const mine = store.create(Date.now() + HOUR);
    const theirs = store.create(Date.now() + HOUR);
    const a = await join(cookieFor(mine));
    const b = await join(cookieFor(theirs));
    const noCookie = await join();

    store.revoke(mine);
    await a.closed;
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    expect(noCookie.ws.readyState).toBe(WebSocket.OPEN);

    store.revokeAll();
    await b.closed;
    expect(noCookie.ws.readyState).toBe(WebSocket.OPEN);
  });
});
