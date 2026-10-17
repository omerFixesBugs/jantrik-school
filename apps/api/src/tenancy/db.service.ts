import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { TenantTx } from '@jantrik/db';
import { RequestContext } from '../common/request-context.js';

/**
 * The database for services: the current request's transaction, already scoped by RLS to the
 * caller's tenant and user. Services never set the tenant themselves.
 *
 *   constructor(private readonly db: Db) {}
 *   list() { return this.db.tx.student.findMany(); }
 */
@Injectable()
export class Db {
  constructor(private readonly context: RequestContext) {}

  get tx(): TenantTx {
    const tx = this.context.tx;
    if (!tx) {
      throw new InternalServerErrorException(
        'No request transaction: Db.tx is only available in authenticated requests',
      );
    }
    return tx;
  }
}
