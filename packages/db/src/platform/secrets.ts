import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
} from 'node:crypto';

// Platform 2FA secrets at rest. TOTP secrets are encrypted (they must be readable to check a
// code); backup codes are only kept as HMACs. Both keys come from PLATFORM_TOTP_KEY.

export interface PlatformKeys {
  /** AES-256-GCM key for TOTP secrets. */
  encryption: Buffer;
  /** HMAC-SHA256 key for backup codes. */
  hmac: Buffer;
}

/**
 * Keys from PLATFORM_TOTP_KEY (at least 32 characters). Required in production; elsewhere a
 * key derived from OTP_PEPPER is used when it is not set, so development and tests need no
 * extra variable.
 */
export function platformKeys(env: {
  NODE_ENV?: string;
  PLATFORM_TOTP_KEY?: string;
  OTP_PEPPER?: string;
}): PlatformKeys {
  let root = env.PLATFORM_TOTP_KEY;
  if (!root) {
    if (env.NODE_ENV === 'production') throw new Error('PLATFORM_TOTP_KEY is required');
    if (!env.OTP_PEPPER) throw new Error('PLATFORM_TOTP_KEY (or OTP_PEPPER) is required');
    root = `dev-platform-totp:${env.OTP_PEPPER}`;
  }
  if (root.length < 32) throw new Error('PLATFORM_TOTP_KEY must be at least 32 characters');
  const derive = (purpose: string) => createHash('sha256').update(`${purpose}:${root}`).digest();
  return { encryption: derive('totp-encryption'), hmac: derive('backup-code-hmac') };
}

/** "v1." + base64url(iv | tag | ciphertext). */
export function encryptTotpSecret(secret: string, keys: PlatformKeys): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys.encryption, iv);
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
}

export function decryptTotpSecret(stored: string, keys: PlatformKeys): string {
  if (!stored.startsWith('v1.')) throw new Error('Unknown TOTP secret format');
  const raw = Buffer.from(stored.slice(3), 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', keys.encryption, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

// Backup codes: 10 × "XXXX-XXXX" from an alphabet without look-alikes (no 0/O, 1/I/L, U).
const BACKUP_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const BACKUP_CODE_COUNT = 10;

export function generateBackupCodes(): string[] {
  return Array.from({ length: BACKUP_CODE_COUNT }, () => {
    const chars = Array.from(
      { length: 8 },
      () => BACKUP_ALPHABET[randomInt(BACKUP_ALPHABET.length)],
    );
    return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
  });
}

/** Typed backup code → canonical form (case, spaces and dashes ignored), or null. */
export function normalizeBackupCode(input: string): string | null {
  const clean = input.toUpperCase().replace(/[\s-]/g, '');
  if (clean.length !== 8 || [...clean].some((c) => !BACKUP_ALPHABET.includes(c))) return null;
  return clean;
}

export function hashBackupCode(code: string, keys: PlatformKeys): string {
  const canonical = normalizeBackupCode(code) ?? code;
  return createHmac('sha256', keys.hmac).update(canonical).digest('hex');
}

/** SHA-256 hex of a session token (only the hash is stored). */
export function hashPlatformToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
