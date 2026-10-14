/**
 * The one-time code for the first-run setup screen.
 *
 * With no login password anywhere, the first person to reach the page chooses
 * it. On a LAN that could be anyone, so the screen also asks for this code,
 * which only someone who can read the backend's log has: the backend prints
 * it at startup, and `./tradingapp.sh setup-code` shows it. A new code is made
 * at every start until a password is set.
 */
import crypto from 'crypto';

import { logger } from './logger.js';

// No 0/O, 1/I/L: the code is read off a terminal and typed by hand.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

let current: string | null = null;

function generate(): string {
  const bytes = crypto.randomBytes(12);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  return chars.match(/.{4}/g)!.join('-');
}

function normalise(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Makes a code (once per process) and prints it. */
export function announceSetupCode(): string {
  if (!current) current = generate();
  logger.warn(
    { setup_code: current },
    `First-run setup: open the app and enter setup code ${current} to choose the login password.`
  );
  // Plain line too, so `docker compose logs backend | grep "SETUP CODE"` finds it.
  console.log(`SETUP CODE: ${current}`);
  return current;
}

export function checkSetupCode(supplied: unknown): boolean {
  if (!current || typeof supplied !== 'string') return false;
  const a = crypto.createHash('sha256').update(normalise(supplied)).digest();
  const b = crypto.createHash('sha256').update(normalise(current)).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Spent once a password is set. */
export function clearSetupCode(): void {
  current = null;
}

/** Test-only. */
export function setSetupCodeForTest(code: string | null): void {
  current = code;
}
