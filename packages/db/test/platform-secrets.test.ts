import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  decryptTotpSecret,
  encryptTotpSecret,
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCode,
  normalizeBackupCode,
  platformKeys,
  totpCode,
  totpStep,
  totpUri,
  verifyTotp,
} from '../src/index.js';

// RFC 6238 appendix B (SHA-1): the secret is the ASCII bytes "12345678901234567890"; our 6-digit
// codes are the last 6 digits of the RFC's 8-digit values.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));
const RFC_VECTORS: [number, string][] = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC test vectors', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    for (const [seconds, code] of RFC_VECTORS) {
      expect(totpCode(RFC_SECRET, totpStep(seconds * 1000))).toBe(code);
    }
  });

  it('accepts the previous, current and next step only, and returns the step', () => {
    const secret = generateTotpSecret();
    const now = 1_800_000_000_000;
    const step = totpStep(now);
    expect(verifyTotp(secret, totpCode(secret, step), now)).toBe(step);
    expect(verifyTotp(secret, totpCode(secret, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, totpCode(secret, step - 2), now)).toBeNull();
    expect(verifyTotp(secret, '12345', now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
  });

  it('base32 round-trips; the URI carries issuer, account and secret', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 255, 7]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    const secret = generateTotpSecret();
    expect(base32Decode(secret)).toHaveLength(20);
    const uri = totpUri(secret, '+8801700000001');
    expect(uri.startsWith('otpauth://totp/Jantrik%20Platform%3A%2B8801700000001?')).toBe(true);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('issuer=Jantrik+Platform');
  });
});

describe('platform secrets', () => {
  const keys = platformKeys({ NODE_ENV: 'test', OTP_PEPPER: 'x'.repeat(40) });

  it('TOTP secrets are encrypted (AES-GCM) and tampering is detected', () => {
    const secret = generateTotpSecret();
    const stored = encryptTotpSecret(secret, keys);
    expect(stored).not.toContain(secret);
    expect(encryptTotpSecret(secret, keys)).not.toBe(stored); // random IV
    expect(decryptTotpSecret(stored, keys)).toBe(secret);
    const tampered = `${stored.slice(0, -2)}${stored.endsWith('A') ? 'B' : 'A'}`;
    expect(() => decryptTotpSecret(tampered, keys)).toThrow();
    const other = platformKeys({ PLATFORM_TOTP_KEY: 'y'.repeat(40) });
    expect(() => decryptTotpSecret(stored, other)).toThrow();
  });

  it('PLATFORM_TOTP_KEY is required in production and must be long enough', () => {
    expect(() => platformKeys({ NODE_ENV: 'production', OTP_PEPPER: 'x'.repeat(40) })).toThrow(
      /PLATFORM_TOTP_KEY is required/,
    );
    expect(() => platformKeys({ NODE_ENV: 'production', PLATFORM_TOTP_KEY: 'short' })).toThrow(
      /at least 32/,
    );
    expect(() =>
      platformKeys({ NODE_ENV: 'production', PLATFORM_TOTP_KEY: 'k'.repeat(32) }),
    ).not.toThrow();
  });

  it('10 distinct backup codes; typing variants hash the same; others differ', () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    const [a, b] = codes as [string, string];
    expect(hashBackupCode(a.toLowerCase().replace('-', ' '), keys)).toBe(hashBackupCode(a, keys));
    expect(hashBackupCode(a, keys)).not.toBe(hashBackupCode(b, keys));
    expect(hashBackupCode(a, keys)).toMatch(/^[0-9a-f]{64}$/);
    expect(normalizeBackupCode('O0O0-1111')).toBeNull(); // look-alikes are not in the alphabet
  });
});
