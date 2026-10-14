import { encryptionKey, openSecret, sealSecret } from '../src/config/secretBox.js';

describe('secretBox', () => {
  const key = Buffer.alloc(32, 7);

  it('round-trips and never stores the plaintext', () => {
    const sealed = sealSecret('hunter2-token', key);
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(sealed).not.toContain('hunter2');
    expect(openSecret(sealed, key)).toBe('hunter2-token');
  });

  it('uses a fresh IV each time', () => {
    expect(sealSecret('same', key)).not.toBe(sealSecret('same', key));
  });

  it('refuses the wrong key and a tampered value', () => {
    const sealed = sealSecret('value', key);
    expect(() => openSecret(sealed, Buffer.alloc(32, 8))).toThrow(/decrypted/);
    const parts = sealed.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => openSecret(parts.join(':'), key)).toThrow();
  });

  it('reads the key as hex or base64, and is loud about a bad one', () => {
    expect(encryptionKey({})).toBeNull();
    expect(encryptionKey({ SETTINGS_ENCRYPTION_KEY: 'ab'.repeat(32) })?.length).toBe(32);
    expect(encryptionKey({ SETTINGS_ENCRYPTION_KEY: key.toString('base64') })?.equals(key)).toBe(
      true
    );
    expect(() => encryptionKey({ SETTINGS_ENCRYPTION_KEY: 'too-short' })).toThrow(/64 hex/);
  });
});
