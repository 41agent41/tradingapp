/**
 * The login sessions that are in force (S-05).
 *
 * A session cookie is signed, so the backend can tell it issued it. That
 * alone made a cookie valid until it expired: logout cleared only the
 * browser's copy, and a copied cookie kept working. Each cookie now names a
 * session, and it is accepted only while that session is in this store.
 * Logout removes it, and "sign out everywhere" removes them all.
 *
 * Every request checks a session, so the check reads an in-memory copy. It is
 * read from `auth_sessions` at startup and written through on every change,
 * so sessions survive a restart. When the database cannot be written, a new
 * session still works until the next restart.
 */
import crypto from 'crypto';

import type { Querier } from './backtestRunRepository.js';
import { logger } from './logger.js';

export interface SessionRecord {
  id: string;
  createdAt: number;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
}

export interface SessionMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** What the Security tab shows of a session. The full id is never sent. */
export interface SessionView {
  /** The start of the id: enough to name the session, not to be it. */
  id: string;
  created_at: string;
  expires_at: string;
  ip: string | null;
  user_agent: string | null;
  /** The session the request itself came in on. */
  current: boolean;
}

const PUBLIC_ID_LENGTH = 12;

function clip(value: string | null | undefined, length: number): string | null {
  const text = (value ?? '').trim();
  return text ? text.slice(0, length) : null;
}

/** Told the ids of sessions that ended, or 'all' when every one did. */
export type SessionEndListener = (ended: string[] | 'all') => void;

export class SessionStore {
  private db: Querier | null = null;
  private sessions = new Map<string, SessionRecord>();
  private listeners = new Set<SessionEndListener>();
  /** Sessions ended while `start` was reading the stored ones. */
  private endedWhileLoading: Set<string> | 'all' | null = null;

  /**
   * Calls `listener` whenever sessions are ended, so what was opened under
   * them (a live socket) can be closed. Returns a function that stops it.
   */
  onEnd(listener: SessionEndListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private ended(what: string[] | 'all'): void {
    if (this.endedWhileLoading) {
      if (what === 'all') this.endedWhileLoading = 'all';
      else if (this.endedWhileLoading !== 'all') {
        for (const id of what) this.endedWhileLoading.add(id);
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(what);
      } catch (err) {
        logger.warn({ err: (err as Error)?.message }, 'session end listener failed');
      }
    }
  }

  attach(db: Querier): void {
    this.db = db;
  }

  /** Reads the sessions stored before the restart, and drops expired rows. */
  async start(now: number = Date.now()): Promise<void> {
    if (!this.db) return;
    this.endedWhileLoading = new Set();
    try {
      await this.db.query(`DELETE FROM auth_sessions WHERE expires_at <= NOW()`);
      const { rows } = await this.db.query(
        `SELECT id, created_at, expires_at, ip, user_agent FROM auth_sessions`
      );
      for (const row of rows as Array<Record<string, any>>) {
        const record: SessionRecord = {
          id: String(row.id),
          createdAt: new Date(row.created_at).getTime(),
          expiresAt: new Date(row.expires_at).getTime(),
          ip: row.ip ?? null,
          userAgent: row.user_agent ?? null,
        };
        // A session made while this was loading is already here; keep it.
        // One ended while this was loading must not come back.
        if (this.endedDuringLoad(record.id)) continue;
        if (record.expiresAt > now && !this.sessions.has(record.id)) {
          this.sessions.set(record.id, record);
        }
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error)?.message },
        'stored login sessions could not be read; browsers must sign in again'
      );
    } finally {
      this.endedWhileLoading = null;
    }
  }

  private endedDuringLoad(id: string): boolean {
    const ended = this.endedWhileLoading;
    return ended === 'all' || Boolean(ended?.has(id));
  }

  /** Forgets expired sessions, so the store does not grow with every login. */
  private prune(now: number): void {
    for (const [id, record] of this.sessions) {
      if (record.expiresAt <= now) this.sessions.delete(id);
    }
  }

  private write(sql: string, params: unknown[], what: string): void {
    void this.db?.query(sql, params).catch((err) => {
      logger.warn({ err: (err as Error)?.message }, `login session could not be ${what}`);
    });
  }

  /** Starts a session and returns its id. */
  create(expiresAt: number, meta: SessionMeta = {}, now: number = Date.now()): string {
    const record: SessionRecord = {
      id: crypto.randomBytes(24).toString('hex'),
      createdAt: now,
      expiresAt,
      ip: clip(meta.ip, 64),
      userAgent: clip(meta.userAgent, 256),
    };
    this.prune(now);
    this.sessions.set(record.id, record);
    this.write(`DELETE FROM auth_sessions WHERE expires_at <= NOW()`, [], 'tidied');
    this.write(
      `INSERT INTO auth_sessions (id, created_at, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
      [
        record.id,
        new Date(record.createdAt),
        new Date(record.expiresAt),
        record.ip,
        record.userAgent,
      ],
      'stored'
    );
    return record.id;
  }

  /** Whether the session is in force. */
  isActive(id: string, now: number = Date.now()): boolean {
    const record = this.sessions.get(id);
    if (!record) return false;
    if (record.expiresAt <= now) {
      this.sessions.delete(id);
      return false;
    }
    return true;
  }

  /** Ends one session. True when it was in force. */
  revoke(id: string): boolean {
    const had = this.sessions.delete(id);
    this.write(`DELETE FROM auth_sessions WHERE id = $1`, [id], 'ended');
    this.ended([id]);
    return had;
  }

  /** Ends the session whose shown id is `publicId`. True when one was. */
  revokeByPublicId(publicId: string): boolean {
    if (publicId.length !== PUBLIC_ID_LENGTH) return false;
    const match = [...this.sessions.keys()].filter((id) => id.startsWith(publicId));
    return match.length === 1 ? this.revoke(match[0]) : false;
  }

  /** Ends every session. Returns how many were in force. */
  revokeAll(): number {
    const count = this.sessions.size;
    this.sessions.clear();
    this.write(`DELETE FROM auth_sessions`, [], 'ended');
    this.ended('all');
    return count;
  }

  /** The sessions in force, newest first. */
  list(currentId: string | null, now: number = Date.now()): SessionView[] {
    return [...this.sessions.values()]
      .filter((s) => s.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((s) => ({
        id: s.id.slice(0, PUBLIC_ID_LENGTH),
        created_at: new Date(s.createdAt).toISOString(),
        expires_at: new Date(s.expiresAt).toISOString(),
        ip: s.ip,
        user_agent: s.userAgent,
        current: s.id === currentId,
      }));
  }
}

/** The process-wide store. `index.ts` attaches the database and starts it. */
export const sessionStore = new SessionStore();
