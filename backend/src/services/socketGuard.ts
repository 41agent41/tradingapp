/**
 * Two rules for live (Socket.IO) connections that the HTTP middleware cannot
 * enforce, because a WebSocket is not an ordinary request:
 *
 *   - CORS does not apply to a WebSocket. A browser opens one to any site
 *     and sends the cookie with it, so a handshake from another site's page
 *     is refused here by the same rule as an API call (S-04).
 *   - A socket outlives the request that opened it. When the login session
 *     it was opened under ends, it is closed at once (S-05).
 */
import type { IncomingMessage } from 'http';

import type { Server as SocketIOServer } from 'socket.io';

import { originAllowed } from './network.js';
import { readCookie, SESSION_COOKIE, sessionId } from './session.js';
import { sessionStore, type SessionStore } from './sessionStore.js';

/** Socket.IO's `allowRequest`: refuses a handshake from a site not allowed. */
export function allowSocketRequest(
  req: IncomingMessage,
  callback: (err: string | null | undefined, success: boolean) => void,
  allowed: (origin: string | undefined) => boolean = originAllowed
): void {
  const origin = req.headers.origin;
  const ok = allowed(Array.isArray(origin) ? origin[0] : origin);
  callback(ok ? null : 'Origin not allowed', ok);
}

/**
 * Notes on each socket the login session it connected under, and closes the
 * sockets of a session when it ends. A client that also holds an API token
 * simply reconnects with it. Returns a function that undoes the second part.
 */
export function closeSocketsWithSessions(
  io: SocketIOServer,
  store: SessionStore = sessionStore
): () => void {
  io.use((socket, next) => {
    socket.data.sessionId = sessionId(readCookie(socket.handshake.headers.cookie, SESSION_COOKIE));
    next();
  });
  return store.onEnd((ended) => {
    for (const socket of io.sockets.sockets.values()) {
      const id = socket.data.sessionId as string | null | undefined;
      if (id && (ended === 'all' || ended.includes(id))) socket.disconnect(true);
    }
  });
}
