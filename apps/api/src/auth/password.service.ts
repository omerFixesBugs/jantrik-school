import { Injectable } from '@nestjs/common';
import { normalizePassword } from '@jantrik/shared';
import { hash, verify } from '@node-rs/argon2';

// Argon2id (the library default) with OWASP-recommended parameters: 19 MiB, 2 iterations.
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

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
   * Verify a password. With no stored hash (unknown user, or OTP-only account) it still runs a
   * full argon2 verification against a dummy hash, so response time does not reveal whether the
   * account exists.
   */
  async verify(storedHash: string | null | undefined, password: string): Promise<boolean> {
    if (!storedHash) {
      this.dummyHash ??= hash('jantrik-dummy-password', OPTIONS);
      await verify(await this.dummyHash, password).catch(() => false);
      return false;
    }
    return verify(storedHash, normalizePassword(password)).catch(() => false);
  }
}
