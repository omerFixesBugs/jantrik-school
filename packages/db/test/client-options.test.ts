import { createServer, type Socket } from 'node:net';
import type * as AdapterPg from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPrismaClient } from '../src/index.js';

/** What each PrismaPg was built with (the real adapter still does the work). */
const configs = vi.hoisted(() => [] as unknown[]);
vi.mock('@prisma/adapter-pg', async (importOriginal) => {
  const real = await importOriginal<typeof AdapterPg>();
  class RecordingPrismaPg extends real.PrismaPg {
    constructor(...args: ConstructorParameters<typeof real.PrismaPg>) {
      configs.push(args[0]);
      super(...args);
    }
  }
  return { ...real, PrismaPg: RecordingPrismaPg };
});

describe('createPrismaClient pool options', () => {
  it("passes only the connection string by default (node-postgres' own defaults)", () => {
    configs.length = 0;
    createPrismaClient('postgresql://u:p@127.0.0.1:1/x');
    expect(configs).toEqual([{ connectionString: 'postgresql://u:p@127.0.0.1:1/x' }]);
  });

  it('passes the connection timeout and keep-alive (with its first probe delay) when given', () => {
    configs.length = 0;
    createPrismaClient('postgresql://u:p@127.0.0.1:1/x', {
      connectionTimeoutMillis: 5000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 30_000,
    });
    expect(configs).toEqual([
      {
        connectionString: 'postgresql://u:p@127.0.0.1:1/x',
        connectionTimeoutMillis: 5000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 30_000,
      },
    ]);
  });

  describe('against a server that accepts and never answers', () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => sockets.add(socket));
    let port = 0;
    beforeAll(async () => {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as { port: number }).port;
    });
    afterAll(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    });

    it('a connection that never opens fails after connectionTimeoutMillis', async () => {
      const client = createPrismaClient(`postgresql://u:p@127.0.0.1:${port}/silent`, {
        connectionTimeoutMillis: 300,
      });
      const started = Date.now();
      try {
        await expect(client.$queryRaw`SELECT 1`).rejects.toThrow();
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(sockets.size).toBeGreaterThan(0);
      } finally {
        await client.$disconnect().catch(() => undefined);
      }
    });
  });
});
