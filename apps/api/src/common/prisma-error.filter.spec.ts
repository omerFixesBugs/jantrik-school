import { Logger, type ArgumentsHost, type HttpServer } from '@nestjs/common';
import { Prisma } from '@jantrik/db';
import { BUSY_RETRY_AFTER_SEC, PrismaErrorFilter, isLockTimeout } from './prisma-error.filter.js';

// Only a lock wait that ran out (Postgres 55P03, the punch lock's lock_timeout) is 409 BUSY with
// Retry-After. A transaction that ran past its own time limit (P2028) stays a logged 500: it
// would fail again, and a BUSY would hide it.

const known = (message: string, code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test', meta });

/** The lock timeout as Prisma 7 with the pg adapter raises it (measured in T12). */
const lockTimeout = () =>
  known(
    'Invalid `prisma.$executeRaw()` invocation:\n\nRaw query failed. Code: `55P03`. Message: `canceling statement due to lock timeout`',
    'P2010',
    {
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '55P03',
          originalMessage: 'canceling statement due to lock timeout',
          kind: 'postgres',
          code: '55P03',
          message: 'canceling statement due to lock timeout',
        },
      },
    },
  );

/** Prisma's expired interactive transaction. */
const expired = () =>
  known(
    'Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 15000 ms, however 15012 ms passed since the start of the transaction. Consider increasing the interactive transaction timeout or doing less work in the transaction.',
    'P2028',
  );

/** Runs the filter against a fake HTTP response; returns what it answered. */
function answer(error: Prisma.PrismaClientKnownRequestError) {
  const headers = new Map<string, string>();
  const response = { setHeader: (name: string, value: string) => headers.set(name, value) };
  const replies: { body: unknown; status: number }[] = [];
  const adapter = {
    isHeadersSent: () => false,
    reply: (_res: unknown, body: unknown, status: number) => replies.push({ body, status }),
    end: () => undefined,
  } as unknown as HttpServer;
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
    getArgByIndex: (i: number) => [{}, response][i],
  } as unknown as ArgumentsHost;
  new PrismaErrorFilter(adapter).catch(error, host);
  return { reply: replies[0]!, retryAfter: headers.get('Retry-After') ?? null };
}

describe('PrismaErrorFilter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a lock wait that ran out (55P03) is 409 BUSY with Retry-After', () => {
    expect(isLockTimeout(lockTimeout())).toBe(true);
    expect(answer(lockTimeout())).toEqual({
      reply: {
        status: 409,
        body: {
          statusCode: 409,
          code: 'BUSY',
          message: 'Busy right now; try again in a moment',
        },
      },
      retryAfter: String(BUSY_RETRY_AFTER_SEC),
    });
  });

  it('an expired transaction (P2028) is not BUSY: it stays a 500 and is logged', () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const error = expired();
    expect(isLockTimeout(error)).toBe(false);
    expect(answer(error)).toEqual({
      reply: { status: 500, body: { statusCode: 500, message: 'Internal server error' } },
      retryAfter: null,
    });
    expect(logged).toHaveBeenCalledWith(error);
  });

  it('unique and foreign key violations keep their 409s', () => {
    expect(answer(known('Unique constraint failed', 'P2002')).reply).toMatchObject({
      status: 409,
      body: { code: 'DUPLICATE' },
    });
    expect(answer(known('Foreign key constraint failed', 'P2003')).reply).toMatchObject({
      status: 409,
      body: { code: 'REFERENCE_CONFLICT' },
    });
  });
});
