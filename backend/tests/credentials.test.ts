/**
 * The Security tab's store: hashed password, hashed tokens shown once,
 * sealed MFA secret, a generated session key, and .env still winning.
 */
import {
  CredentialStore,
  hashPassword,
  newTotpSecret,
  verifyPasswordHash,
} from '../src/services/credentials.js';
import { verifyTotp } from '../src/services/totp.js';
import { credentialsDb } from './helpers/credentialsDb.js';
import { totpNow } from './helpers/totp.js';

const KEY = 'a'.repeat(64);
const ctx = { actor: 'browser', ip: '127.0.0.1' };

async function store(env: Record<string, string> = {}) {
  const db = credentialsDb();
  const s = new CredentialStore({ SETTINGS_ENCRYPTION_KEY: KEY, ...env });
  s.attach(db);
  await s.load();
  return { s, db };
}

describe('password hashing', () => {
  it('verifies the right password only', () => {
    const stored = hashPassword('correct horse battery');
    expect(stored).toMatch(/^scrypt\$/);
    expect(stored).not.toContain('correct');
    expect(verifyPasswordHash('correct horse battery', stored)).toBe(true);
    expect(verifyPasswordHash('wrong horse battery', stored)).toBe(false);
    expect(verifyPasswordHash('x', 'garbage')).toBe(false);
  });
});

describe('CredentialStore', () => {
  it('starts with no password and a generated session key', async () => {
    const { s, db } = await store();
    expect(s.isLoaded()).toBe(true);
    expect(s.hasPassword()).toBe(false);
    expect(db.rows.get('session_secret')?.ciphertext).toMatch(/^v1:/);
    expect(s.sessionSecret()).toHaveLength(64);
  });

  it('stores the password hashed, checks it, and rotates the session key', async () => {
    const { s, db } = await store();
    const before = s.sessionSecret();
    await expect(s.setPassword('short', ctx)).rejects.toMatchObject({ status: 400 });
    await s.setPassword('a long enough password', ctx);
    expect(db.rows.get('password').hash).not.toContain('long enough');
    expect(s.verifyPassword('a long enough password')).toBe(true);
    expect(s.verifyPassword('another password!!')).toBe(false);
    expect(s.sessionSecret()).not.toBe(before);
    expect(db.audit).toContainEqual(
      expect.objectContaining({ key: 'security:password', new_value: '(secret)' })
    );
  });

  it('lets APP_PASSWORD in .env win and refuses to change it here', async () => {
    const { s } = await store({ APP_PASSWORD: 'from-the-env-file' });
    expect(s.passwordSource()).toBe('environment');
    expect(s.verifyPassword('from-the-env-file')).toBe(true);
    await expect(s.setPassword('a long enough password', ctx)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('creates a token, shows it once, matches it and revokes it', async () => {
    const { s, db } = await store();
    const { token, view } = await s.createToken('trading', 'phone', ctx);
    expect(token.startsWith('ttrd_')).toBe(true);
    expect(JSON.stringify([...db.rows.values()])).not.toContain(token);
    expect(JSON.stringify(s.listTokens())).not.toContain(token);
    expect(view).toMatchObject({ kind: 'trading', label: 'phone' });
    expect(s.hasTokens('trading')).toBe(true);
    expect(s.matchToken('trading', token)).toBe(true);
    expect(s.matchToken('api', token)).toBe(false);
    expect(s.matchToken('trading', token + 'x')).toBe(false);

    await s.revokeToken(view.id, ctx);
    expect(s.matchToken('trading', token)).toBe(false);
    expect(s.hasTokens('trading')).toBe(false);
  });

  it('accepts .env tokens alongside stored ones', async () => {
    const { s } = await store({ TRADING_TOKENS: 'one, two', API_TOKEN: 'env-api-token' });
    expect(s.matchToken('trading', 'two')).toBe(true);
    expect(s.matchToken('api', 'env-api-token')).toBe(true);
    expect(s.envTokenCount('trading')).toBe(2);
  });

  it('enrols MFA only once a code from the new secret is confirmed', async () => {
    const { s, db } = await store();
    const secret = s.beginMfa();
    expect(s.mfaSecret()).toBe('');
    await expect(s.confirmMfa((sec) => verifyTotp(sec, '000000'), ctx)).rejects.toMatchObject({
      status: 400,
    });
    await s.confirmMfa((sec) => verifyTotp(sec, totpNow(sec)), ctx);
    expect(s.mfaSecret()).toBe(secret);
    expect(db.rows.get('mfa').ciphertext).not.toContain(secret);

    await s.removeMfa(ctx);
    expect(s.mfaSecret()).toBe('');
  });

  it('expires an unconfirmed enrolment', async () => {
    const { s } = await store();
    s.beginMfa(0);
    await expect(s.confirmMfa(() => true, ctx)).rejects.toMatchObject({ status: 409 });
  });

  it('makes base32 secrets an authenticator accepts', () => {
    const secret = newTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(verifyTotp(secret, totpNow(secret))).toBe(true);
  });

  it('tells listeners when something changes', async () => {
    const { s } = await store();
    const fn = jest.fn();
    s.onChange(fn);
    await s.createToken('api', 'script', ctx);
    expect(fn).toHaveBeenCalled();
  });
});
