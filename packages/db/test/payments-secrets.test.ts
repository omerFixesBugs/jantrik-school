import { describe, expect, it } from 'vitest';
import {
  credentialsAad,
  decryptCredentials,
  encryptCredentials,
  paymentKeys,
  platformKeys,
} from '../src/index.js';

// Payment gateway credentials at rest (sprint 1 P7a, docs/payments.md): AES-256-GCM with the
// account's identity as additional data, under a key of their own (PAYMENT_CREDENTIALS_KEY).

const dev = { NODE_ENV: 'development', OTP_PEPPER: 'x'.repeat(40) };
const json = JSON.stringify({ storeId: 'teststore0001', storePassword: 'sentinel-Pw@ssl' });
const aadA = credentialsAad('SSLCOMMERZ', '0190a000-0000-7000-8000-00000000000a', 'acc-a');

describe('payment credentials key', () => {
  it('development and tests derive one from OTP_PEPPER: stable, and not the platform key', () => {
    const a = paymentKeys(dev);
    const b = paymentKeys({ ...dev });
    expect(a.encryption).toEqual(b.encryption);
    expect(a.encryption).toHaveLength(32);
    expect(a.encryption.equals(platformKeys(dev).encryption)).toBe(false);
    expect(a.encryption.equals(platformKeys(dev).hmac)).toBe(false);
    // Another pepper, another key.
    const other = paymentKeys({ ...dev, OTP_PEPPER: 'z'.repeat(40) });
    expect(a.encryption.equals(other.encryption)).toBe(false);
  });

  it('PAYMENT_CREDENTIALS_KEY is required in production and at least 32 characters', () => {
    expect(() => paymentKeys({ NODE_ENV: 'production', OTP_PEPPER: 'x'.repeat(40) })).toThrow(
      /PAYMENT_CREDENTIALS_KEY is required/,
    );
    expect(() =>
      paymentKeys({ NODE_ENV: 'production', PAYMENT_CREDENTIALS_KEY: 'k'.repeat(31) }),
    ).toThrow(/at least 32/);
    expect(() => paymentKeys({ NODE_ENV: 'test' })).toThrow(/PAYMENT_CREDENTIALS_KEY/);
    const set = paymentKeys({ NODE_ENV: 'production', PAYMENT_CREDENTIALS_KEY: 'k'.repeat(32) });
    expect(set.encryption.equals(paymentKeys(dev).encryption)).toBe(false);
  });

  it('the AAD names the provider, the institute and the account', () => {
    expect(aadA).toBe('payments:SSLCOMMERZ:0190a000-0000-7000-8000-00000000000a:acc-a');
  });
});

describe('payment credentials at rest', () => {
  const keys = paymentKeys(dev);

  it('round-trips; two encryptions of one value differ (a random IV)', () => {
    const stored = encryptCredentials(json, aadA, keys);
    expect(stored).toMatch(/^v1\.[A-Za-z0-9_-]{40,2000}$/);
    expect(stored).not.toContain('sentinel');
    expect(encryptCredentials(json, aadA, keys)).not.toBe(stored);
    expect(decryptCredentials(stored, aadA, keys)).toBe(json);
  });

  it('fails for another account, another institute, another key or a changed byte', () => {
    const stored = encryptCredentials(json, aadA, keys);
    const otherAccount = credentialsAad(
      'SSLCOMMERZ',
      '0190a000-0000-7000-8000-00000000000a',
      'acc-b',
    );
    const otherTenant = credentialsAad(
      'SSLCOMMERZ',
      '0190a000-0000-7000-8000-00000000000b',
      'acc-a',
    );
    expect(() => decryptCredentials(stored, otherAccount, keys)).toThrow();
    expect(() => decryptCredentials(stored, otherTenant, keys)).toThrow();
    const otherKey = paymentKeys({ NODE_ENV: 'test', PAYMENT_CREDENTIALS_KEY: 'q'.repeat(40) });
    expect(() => decryptCredentials(stored, aadA, otherKey)).toThrow();
    const tampered = `${stored.slice(0, -2)}${stored.endsWith('A') ? 'B' : 'A'}`;
    expect(() => decryptCredentials(tampered, aadA, keys)).toThrow();
    expect(() => decryptCredentials('v2.abc', aadA, keys)).toThrow();
    expect(() => decryptCredentials('v1.', aadA, keys)).toThrow();
  });

  it('an error names no secret', () => {
    const stored = encryptCredentials(json, aadA, keys);
    const otherKey = paymentKeys({ NODE_ENV: 'test', PAYMENT_CREDENTIALS_KEY: 'q'.repeat(40) });
    let thrown: unknown;
    try {
      decryptCredentials(stored, aadA, otherKey);
    } catch (error) {
      thrown = error;
    }
    const text = `${String(thrown)} ${JSON.stringify(thrown)} ${(thrown as Error).stack ?? ''}`;
    expect(text).not.toContain('sentinel');
    expect(text).not.toContain(stored);
  });
});
