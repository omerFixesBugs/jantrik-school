import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { normalizePassword } from '@jantrik/shared';
import { hash, verify } from '@node-rs/argon2';

// Argon2id (the library default) with OWASP-recommended parameters: 19 MiB, 2 iterations.
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

/**
 * The most a stored hash may make one staff login spend (P1-J4): 64 MiB, 10 passes, 4 lanes.
 * Hashes Jantrik writes use OPTIONS; above this a stored hash is treated as unusable.
 */
const LOGIN_COST_CEILING = { memoryCost: 65_536, timeCost: 10, parallelism: 4 };

/** The login lookup's `password_params`: argon2id, version 19, m, t, p and the salt (no digest). */
const PARAMS = /^\$argon2id\$v=19\$m=(\d{1,10}),t=(\d{1,10}),p=(\d{1,3})\$([A-Za-z0-9+/]{11,64})$/;

/** The salt of the login's dummy hash (unknown user, no password, unusable parameters). */
const DUMMY_SALT = Buffer.from('jantrik-dummy-salt-16b').subarray(0, 16);

/** A digest no stored hash has: what the dummy path returns. */
const NO_MATCH = Buffer.alloc(32);

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/** argon2 options from the login lookup's parameters, or null when they are missing or unusable. */
function loginOptions(params: string | null | undefined) {
  const m = params ? PARAMS.exec(params) : null;
  if (!m) return null;
  const [memoryCost, timeCost, parallelism] = [m[1], m[2], m[3]].map(Number) as [
    number,
    number,
    number,
  ];
  const usable =
    timeCost >= 1 &&
    parallelism >= 1 &&
    memoryCost >= 8 * parallelism &&
    memoryCost <= LOGIN_COST_CEILING.memoryCost &&
    timeCost <= LOGIN_COST_CEILING.timeCost &&
    parallelism <= LOGIN_COST_CEILING.parallelism;
  return usable ? { memoryCost, timeCost, parallelism, salt: Buffer.from(m[4]!, 'base64') } : null;
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
   * Verify a password against a stored hash (platform admins). With no stored hash it still runs
   * a full argon2 verification against a dummy hash, so response time does not reveal whether the
   * account exists. Staff logins use `loginDigest` instead: their hashes never leave the database.
   */
  async verify(storedHash: string | null | undefined, password: string): Promise<boolean> {
    if (!storedHash) {
      this.dummyHash ??= hash('jantrik-dummy-password', OPTIONS);
      await verify(await this.dummyHash, password).catch(() => false);
      return false;
    }
    return verify(storedHash, normalizePassword(password)).catch(() => false);
  }

  /**
   * A staff login's half of the password check (P1-J): the argon2 hash of `password` under the
   * stored hash's parameters and salt (the login lookup's `password_params`), as the SHA-256 the
   * database compares with `auth_my_password_matches`. The stored hash never reaches the API.
   *
   * Always exactly one hash: with no parameters (unknown user, no password) or unusable ones, it
   * hashes with today's cost and a dummy salt and returns a digest that matches nothing, so the
   * time does not tell the cases apart.
   */
  async loginDigest(params: string | null | undefined, password: string): Promise<Buffer> {
    const options = loginOptions(params);
    const candidate = await hash(
      normalizePassword(password),
      options ?? { ...OPTIONS, salt: DUMMY_SALT },
    ).catch(() => null);
    // The salt must come back exactly as stored (it does for every hash this library wrote).
    if (!options || !candidate?.startsWith(`${params}$`)) return NO_MATCH;
    return sha256(candidate);
  }
}
