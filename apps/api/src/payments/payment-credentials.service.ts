import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  credentialsAad,
  decryptCredentials,
  encryptCredentials,
  paymentKeys,
  type PaymentKeys,
} from '@jantrik/db';
import { sslcommerzCredentialsSchema, type SslcommerzCredentials } from '@jantrik/shared';
import type { Env } from '../config/env.js';
import { Db } from '../tenancy/db.service.js';

/** The key version every ciphertext is written with (rotation is a later decision). */
const KEY_VERSION = 1;

export type PaymentCredentialsErrorCode = 'CREDENTIALS_MISSING' | 'CREDENTIALS_UNREADABLE';

/** A fixed code and nothing else: no value, no ciphertext, no cause. */
export class PaymentCredentialsError extends Error {
  constructor(readonly code: PaymentCredentialsErrorCode) {
    super(code);
    this.name = 'PaymentCredentialsError';
  }
}

/**
 * The only reader and writer of an institute's encrypted gateway credentials (sprint 1 P7a,
 * docs/payments.md → Credentials; credentials-scan.spec.ts fails if another file names the
 * column). The store ID and password are one AES-256-GCM ciphertext bound to the account's
 * provider, institute and id (the AAD), so a ciphertext copied onto another row never decrypts.
 * Runs in the caller's transaction (a request or a TenantJobRunner job): RLS scopes it.
 * Decrypted values exist only in memory, for one call to the gateway.
 */
@Injectable()
export class PaymentCredentialsService {
  private readonly keys: PaymentKeys;

  constructor(
    private readonly db: Db,
    config: ConfigService<Env, true>,
  ) {
    this.keys = paymentKeys({
      NODE_ENV: config.get('NODE_ENV', { infer: true }),
      PAYMENT_CREDENTIALS_KEY: config.get('PAYMENT_CREDENTIALS_KEY', { infer: true }),
      OTP_PEPPER: config.get('OTP_PEPPER', { infer: true }),
    });
  }

  /** The store ID's last 4 characters: what the owner is shown. */
  hint(storeId: string): string {
    return storeId.slice(-4);
  }

  /**
   * Encrypt the credentials onto the account, and in the same update switch it off and clear its
   * last test (P7a-M): new credentials are untested. `actorUserId` null: a command loaded them.
   */
  async save(
    accountId: string,
    creds: SslcommerzCredentials,
    opts: { actorUserId: string | null; now: Date },
  ): Promise<void> {
    const clean = sslcommerzCredentialsSchema.parse(creds);
    const account = await this.db.tx.paymentGatewayAccount.findUnique({
      where: { id: accountId },
      select: { id: true, tenantId: true, provider: true },
    });
    if (!account) throw new PaymentCredentialsError('CREDENTIALS_MISSING');
    const plain = JSON.stringify({ storeId: clean.storeId, storePassword: clean.storePassword });
    await this.db.tx.paymentGatewayAccount.update({
      where: { id: account.id },
      data: {
        credentialsCiphertext: encryptCredentials(
          plain,
          credentialsAad(account.provider, account.tenantId, account.id),
          this.keys,
        ),
        credentialsHint: this.hint(clean.storeId),
        keyVersion: KEY_VERSION,
        credentialsUpdatedAt: opts.now,
        credentialsUpdatedById: opts.actorUserId,
        enabled: false,
        lastTestAt: null,
        lastTestResult: null,
        lastTestedById: null,
      },
      select: { id: true },
    });
  }

  /**
   * The account's credentials, decrypted. CREDENTIALS_MISSING when none are saved (or the
   * account is not this institute's); CREDENTIALS_UNREADABLE when they cannot be decrypted
   * (another key, another row's ciphertext): the owner enters them again.
   */
  async read(accountId: string): Promise<SslcommerzCredentials> {
    const account = await this.db.tx.paymentGatewayAccount.findUnique({
      where: { id: accountId },
      select: { id: true, tenantId: true, provider: true, credentialsCiphertext: true },
    });
    if (!account?.credentialsCiphertext) throw new PaymentCredentialsError('CREDENTIALS_MISSING');
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        decryptCredentials(
          account.credentialsCiphertext,
          credentialsAad(account.provider, account.tenantId, account.id),
          this.keys,
        ),
      );
    } catch {
      throw new PaymentCredentialsError('CREDENTIALS_UNREADABLE');
    }
    const creds = sslcommerzCredentialsSchema.safeParse(parsed);
    if (!creds.success) throw new PaymentCredentialsError('CREDENTIALS_UNREADABLE');
    return creds.data;
  }
}
