/**
 * TOTP verification tests, anchored on the RFC 6238 Appendix B SHA-1 test
 * vectors (secret = ASCII "12345678901234567890"). The reference 8-digit
 * values are truncated to the 6 digits authenticator apps show.
 */
import { verifyTotp, isMfaConfigured } from '../src/services/totp.js';

// base32("12345678901234567890")
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.ORDER_MFA_SECRET;
});

function atUnixSeconds(t: number) {
  jest.spyOn(Date, 'now').mockReturnValue(t * 1000);
}

describe('verifyTotp', () => {
  it('accepts the RFC 6238 SHA-1 vector at T=59 (287082)', () => {
    atUnixSeconds(59);
    expect(verifyTotp(SECRET, '287082')).toBe(true);
  });

  it('accepts another vector at T=1234567890 (005924)', () => {
    atUnixSeconds(1234567890);
    expect(verifyTotp(SECRET, '005924')).toBe(true);
  });

  it('rejects a wrong code', () => {
    atUnixSeconds(59);
    expect(verifyTotp(SECRET, '000000')).toBe(false);
  });

  it('tolerates ±1 step of clock skew but not more', () => {
    // '287082' belongs to counter=1 (T in [30,59]). At T=75 (counter=2) it is
    // one step back, so window=1 still accepts it; far away it must not.
    atUnixSeconds(75);
    expect(verifyTotp(SECRET, '287082')).toBe(true);
    atUnixSeconds(300000);
    expect(verifyTotp(SECRET, '287082')).toBe(false);
  });

  it('rejects malformed input without throwing', () => {
    atUnixSeconds(59);
    expect(verifyTotp(SECRET, '12ab56')).toBe(false); // non-numeric
    expect(verifyTotp(SECRET, '1234')).toBe(false); // wrong length
    expect(verifyTotp('', '287082')).toBe(false); // empty secret
    expect(verifyTotp('not base32 !!!', '287082')).toBe(false); // bad secret
  });
});

describe('isMfaConfigured', () => {
  it('reflects ORDER_MFA_SECRET presence', () => {
    delete process.env.ORDER_MFA_SECRET;
    expect(isMfaConfigured()).toBe(false);
    process.env.ORDER_MFA_SECRET = SECRET;
    expect(isMfaConfigured()).toBe(true);
  });
});
