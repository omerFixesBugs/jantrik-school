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
});
