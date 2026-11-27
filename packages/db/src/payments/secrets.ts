import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Payment gateway credentials at rest (sprint 1 P7a, docs/payments.md → Credentials). An
// institute's store ID and password are kept as one AES-256-GCM ciphertext, bound to the account
// they belong to by the additional data (AAD), so a ciphertext copied onto another institute's or
// another account's row never decrypts. The key comes from PAYMENT_CREDENTIALS_KEY, its own
// secret (the platform 2FA key's shape: platform/secrets.ts).

export interface PaymentKeys {
  /** AES-256-GCM key for gateway credentials. */
  encryption: Buffer;
}

/**
 * The key from PAYMENT_CREDENTIALS_KEY (at least 32 characters). Required in production;
 * elsewhere a key derived from OTP_PEPPER is used when it is not set (not the one the platform
 * derives), so development and tests need no extra variable.
 */
export function paymentKeys(env: {
  NODE_ENV?: string | undefined;
  PAYMENT_CREDENTIALS_KEY?: string | undefined;
  OTP_PEPPER?: string | undefined;
}): PaymentKeys {
  let root = env.PAYMENT_CREDENTIALS_KEY;
  if (!root) {
    if (env.NODE_ENV === 'production') throw new Error('PAYMENT_CREDENTIALS_KEY is required');
    if (!env.OTP_PEPPER) throw new Error('PAYMENT_CREDENTIALS_KEY (or OTP_PEPPER) is required');
    root = `dev-payment-credentials:${env.OTP_PEPPER}`;
  }
  if (root.length < 32) throw new Error('PAYMENT_CREDENTIALS_KEY must be at least 32 characters');
  return {
    encryption: createHash('sha256').update(`payment-credentials-encryption:${root}`).digest(),
  };
}

/** The additional data that binds a ciphertext to one account of one institute. */
export const credentialsAad = (provider: string, tenantId: string, accountId: string): string =>
  `payments:${provider}:${tenantId}:${accountId}`;

/** "v1." + base64url(iv | tag | ciphertext). */
export function encryptCredentials(plain: string, aad: string, keys: PaymentKeys): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys.encryption, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
}

/**
 * The plaintext, or an error that names nothing (another key, another account, a changed byte or
 * an unknown format all look the same).
 */
export function decryptCredentials(stored: string, aad: string, keys: PaymentKeys): string {
  const unreadable = () => new Error('Payment credentials cannot be decrypted');
  if (!stored.startsWith('v1.')) throw unreadable();
  const raw = Buffer.from(stored.slice(3), 'base64url');
  if (raw.length < 29) throw unreadable();
  try {
    const decipher = createDecipheriv('aes-256-gcm', keys.encryption, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    throw unreadable();
  }
}
