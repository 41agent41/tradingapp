/** Test helpers for the order step-up (trading token + TOTP code). */
import { createHmac } from 'crypto';

export const TEST_MFA_SECRET = 'JBSWY3DPEHPK3PXP';
export const TEST_TRADING_TOKEN = 'trader-token-1';

/** The current RFC 6238 code for a base32 secret. */
export function totpNow(secret: string = TEST_MFA_SECRET): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Sets up the trader role and MFA in the environment. */
export function withSafeguards(): void {
  process.env.TRADING_TOKENS = TEST_TRADING_TOKEN;
  process.env.ORDER_MFA_SECRET = TEST_MFA_SECRET;
}

export function stepUpHeaders(): Record<string, string> {
  return { 'X-Trading-Token': TEST_TRADING_TOKEN, 'X-MFA-Code': totpNow() };
}
