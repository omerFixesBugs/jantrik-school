import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { healthResponseSchema } from '@jantrik/shared';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

// Runs without Docker: the Prisma client is replaced by a mock.
describe('GET /health (e2e)', () => {
  let app: INestApplication;
  const queryRaw = vi.fn();

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({
        // The check runs its SELECT 1 in a transaction (P1-J8 review round 2).
        client: {
          $queryRaw: queryRaw,
          $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({ $queryRaw: queryRaw }),
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    queryRaw.mockReset();
  });

  it('returns 200 and db "up" when the database responds', async () => {
    queryRaw.mockResolvedValue([{ ok: 1 }]);

    const res = await request(app.getHttpServer()).get('/health').expect(200);

    expect(healthResponseSchema.parse(res.body)).toMatchObject({ status: 'ok', db: 'up' });
  });

  it('returns 503 and db "down" when the database is unreachable', async () => {
    queryRaw.mockRejectedValue(new Error('connection refused'));

    const res = await request(app.getHttpServer()).get('/health').expect(503);

    expect(healthResponseSchema.parse(res.body)).toMatchObject({ status: 'error', db: 'down' });
  });
});
