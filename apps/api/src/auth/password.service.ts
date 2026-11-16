import { Injectable } from '@nestjs/common';
import { normalizePassword } from '@jantrik/shared';
import { hash, parseOptions, verify } from '@node-rs/argon2';

// Argon2id (the library default) with OWASP-recommended parameters: 19 MiB, 2 iterations.
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

/**
 * The most a stored hash may make one login spend (P1-J4): 64 MiB, 10 passes, 4 lanes. Hashes
 * Jantrik writes use OPTIONS. Above this, or unreadable, a stored hash is treated as no password:
 * a hash someone wrote into their own row cannot make each login attempt arbitrarily expensive.
 */
const COST_CEILING = { memoryCost: 65_536, timeCost: 10, parallelism: 4 };

/**
 * Whether argon2 may verify against `stored`: readable, within the cost ceiling, and of a normal
 * size (salt 8 to 64 bytes, output 16 to 64 bytes, at most 255 characters in all; Jantrik writes
 * 16 and 32, about 100 characters).
 */
function usableHash(stored: string): boolean {
  if (stored.length > 255) return false;
  try {
    const o = parseOptions(stored);
    return (
      o.memoryCost <= COST_CEILING.memoryCost &&
      o.timeCost <= COST_CEILING.timeCost &&
      o.parallelism <= COST_CEILING.parallelism &&
      o.saltLen >= 8 &&
      o.saltLen <= 64 &&
      o.outputLen >= 16 &&
      o.outputLen <= 64
    );
  } catch {
    return false;
  }
}

/**
 * Password hashing and checking, for staff and platform admins. A staff member's password is set
 * only by PasswordSettingsService (PUT /me/password); a platform admin's by the CLI.
 */
@Injectable()
export class PasswordService {
  private dummyHash?: Promise<string>;

  /** Passwords are hashed and verified NFC-normalised (P1-C): the keyboard's form never matters. */
  hash(password: string): Promise<string> {
    return hash(normalizePassword(password), OPTIONS);
  }

  /**
   * Verify a password. With no stored hash (unknown user, or OTP-only account), or one that is
   * unreadable or above the cost ceiling, it still runs a full argon2 verification against a dummy
   * hash, so response time does not reveal which case it was.
   */
  async verify(storedHash: string | null | undefined, password: string): Promise<boolean> {
    if (!storedHash || !usableHash(storedHash)) {
      this.dummyHash ??= hash('jantrik-dummy-password', OPTIONS);
      await verify(await this.dummyHash, password).catch(() => false);
      return false;
    }
    return verify(storedHash, normalizePassword(password)).catch(() => false);
  }
}
