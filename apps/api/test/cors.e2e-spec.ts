import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

// CORS as main.ts sets it up (configureApp). The web app is on another origin and every call
// sends Authorization or X-Jantrik-Client, so each one is preflighted; browsers may cache the
// answer for 2 h (docs/plans/step-12-auth.md, part B). The Prisma client is a mock.
describe('CORS (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({ client: { $queryRaw: vi.fn() } })
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("answers an allowed origin's preflight and lets the browser cache it for 2 hours", async () => {
    const res = await request(app.getHttpServer())
      .options('/auth/refresh')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-jantrik-client')
      .expect(204);

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-max-age']).toBe('7200');
  });

  it('the public admission form may send its phone token header (sprint 1 P3b)', async () => {
    const res = await request(app.getHttpServer())
      .options('/public/admission/some-school/applications')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-admission-token')
      .expect(204);
    expect(res.headers['access-control-allow-headers']?.toLowerCase()).toContain(
      'x-admission-token',
    );
  });

  it('gives any other origin no CORS headers, so it has nothing to cache', async () => {
    const res = await request(app.getHttpServer())
      .options('/auth/refresh')
      .set('Origin', 'https://elsewhere.example')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(res.headers['access-control-max-age']).toBeUndefined();
  });
});
