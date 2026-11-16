import type { RequestContext } from '../common/request-context.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { RequestTransaction } from './request-transaction.service.js';

// Review round 2: run() inside a request that already has its transaction would replace the
// outer transaction and its afterCommit queue in the request context (and wait on the outer
// transaction's locks from a second connection). It refuses instead.

describe('RequestTransaction.run', () => {
  it('refuses to run inside a request transaction (nothing is started)', async () => {
    const withContext = vi.fn();
    const prisma = { client: { $transaction: withContext } } as unknown as PrismaService;
    const context = {
      tx: {},
      requirePrincipal: () => ({ userId: 'u', sessionId: 's', tenantId: 't' }),
    } as unknown as RequestContext;
    const tx = new RequestTransaction(prisma, context, {} as never);
    const fn = vi.fn();
    await expect(tx.run(fn)).rejects.toThrow(/already/);
    expect(fn).not.toHaveBeenCalled();
    expect(withContext).not.toHaveBeenCalled();
  });

  it('checks the session in Redis before opening the transaction, with a deadline (review round 3)', async () => {
    const transaction = vi.fn();
    const prisma = { client: { $transaction: transaction } } as unknown as PrismaService;
    const context = {
      tx: undefined,
      requirePrincipal: () => ({ userId: 'u', sessionId: 's', tenantId: 't' }),
    } as unknown as RequestContext;
    // A Redis that never answers: 503 after the deadline, and no connection was taken.
    const silent = { exists: () => new Promise(() => undefined) };
    const tx = new RequestTransaction(prisma, context, silent as never);
    const failure = await tx.run(vi.fn(), { roles: ['ADMIN'] }).catch((e: unknown) => e);
    expect((failure as { getStatus(): number }).getStatus()).toBe(503);
    expect(transaction).not.toHaveBeenCalled();
  });
});
