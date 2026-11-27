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
 * provider, institute and id and to the row's credentials version (the AAD), so neither a
 * ciphertext copied onto another row nor an older one of the same row put back ever decrypts: a
 * database trigger alone sets the version, one up whenever the ciphertext changes (P7a1-x20).
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
   * last test (P7a-M): new credentials are untested. The last failure goes too (P7a1-x19): it was
   * about the credentials these replace. `actorUserId` null: a command loaded them.
   *
   * The row is locked first, so nothing else can change its ciphertext before this transaction
   * ends: the update below raises the version it read by one (the trigger), and the ciphertext is
   * encrypted as that next version (P7a1-x20). FOR NO KEY UPDATE, the lock the update itself
   * takes: unlike FOR UPDATE, it does not block a foreign key check on the row.
   */
  async save(
    accountId: string,
    creds: SslcommerzCredentials,
    opts: { actorUserId: string | null; now: Date },
  ): Promise<void> {
    const clean = sslcommerzCredentialsSchema.parse(creds);
    const [account] = await this.db.tx.$queryRaw<
      { id: string; tenantId: string; provider: string; version: number }[]
    >`SELECT id, tenant_id AS "tenantId", provider::text AS provider,
        credentials_version AS version
      FROM public.payment_gateway_accounts WHERE id = ${accountId}::uuid
      FOR NO KEY UPDATE`;
    if (!account) throw new PaymentCredentialsError('CREDENTIALS_MISSING');
    const version = account.version + 1;
    const plain = JSON.stringify({ storeId: clean.storeId, storePassword: clean.storePassword });
    const saved = await this.db.tx.paymentGatewayAccount.update({
      where: { id: account.id },
      data: {
        credentialsCiphertext: encryptCredentials(
          plain,
          credentialsAad(account.provider, account.tenantId, account.id, version),
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
        lastFailureCode: null,
        lastFailureAt: null,
      },
      select: { credentialsVersion: true },
    });
    // The trigger's version must be the one encrypted with, or the store could never be read.
    if (saved.credentialsVersion !== version) {
      throw new Error('Payment credentials were not saved as the expected version');
    }
  }

  /**
   * The account's credentials, decrypted. CREDENTIALS_MISSING when none are saved (or the
   * account is not this institute's); CREDENTIALS_UNREADABLE when they cannot be decrypted
   * (another key, another row's ciphertext, an older ciphertext put back): the owner enters them
   * again. The version is the row's, read with the ciphertext in one statement.
   */
  async read(accountId: string): Promise<SslcommerzCredentials> {
    const account = await this.db.tx.paymentGatewayAccount.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        tenantId: true,
        provider: true,
        credentialsVersion: true,
        credentialsCiphertext: true,
      },
    });
    if (!account?.credentialsCiphertext) throw new PaymentCredentialsError('CREDENTIALS_MISSING');
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        decryptCredentials(
          account.credentialsCiphertext,
          credentialsAad(
            account.provider,
            account.tenantId,
            account.id,
            account.credentialsVersion,
          ),
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
