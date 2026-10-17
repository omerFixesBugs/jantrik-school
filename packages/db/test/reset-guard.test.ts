import { describe, expect, it } from 'vitest';
import { assertLocalDevDatabase } from '../src/seed/reset-guard.js';

const url = (user: string, host: string, db: string, port = 5432) =>
  `postgresql://${user}:secret@${host}:${port}/${db}`;

const env = (overrides: Record<string, string | undefined> = {}) => ({
  DATABASE_MIGRATION_URL: url('jantrik_owner', 'localhost', 'jantrik'),
  DATABASE_URL: url('jantrik_app', 'localhost', 'jantrik'),
  ...overrides,
});

describe('db:reset guard', () => {
  it('allows the local dev database', () => {
    expect(assertLocalDevDatabase(env())).toEqual({
      host: 'localhost',
      port: '5432',
      database: 'jantrik',
    });
    for (const host of ['127.0.0.1', '[::1]']) {
      expect(() =>
        assertLocalDevDatabase(
          env({
            DATABASE_MIGRATION_URL: url('o', host, 'jantrik'),
            DATABASE_URL: url('a', host, 'jantrik'),
          }),
        ),
      ).not.toThrow();
    }
  });

  it('refuses in production, whatever the URL', () => {
    expect(() => assertLocalDevDatabase(env({ NODE_ENV: 'production' }))).toThrow(/production/);
  });

  it.each(['jantrik_test', 'jantrik_e2e', 'jantrik_prod', 'postgres'])(
    'refuses database %s',
    (db) => {
      expect(() =>
        assertLocalDevDatabase(
          env({
            DATABASE_MIGRATION_URL: url('o', 'localhost', db),
            DATABASE_URL: url('a', 'localhost', db),
          }),
        ),
      ).toThrow(/not the local dev database/);
    },
  );

  it.each(['db.example.com', '10.0.0.5', 'jantrik.internal'])('refuses remote host %s', (host) => {
    expect(() =>
      assertLocalDevDatabase(
        env({
          DATABASE_MIGRATION_URL: url('o', host, 'jantrik'),
          DATABASE_URL: url('a', host, 'jantrik'),
        }),
      ),
    ).toThrow(/not this machine/);
  });

  it('refuses when the two URLs point at different databases', () => {
    expect(() =>
      assertLocalDevDatabase(env({ DATABASE_URL: url('a', 'db.example.com', 'jantrik') })),
    ).toThrow(/different databases/);
    expect(() =>
      assertLocalDevDatabase(env({ DATABASE_URL: url('a', 'localhost', 'jantrik', 5433) })),
    ).toThrow(/different databases/);
  });

  it('refuses missing or malformed URLs', () => {
    expect(() => assertLocalDevDatabase(env({ DATABASE_MIGRATION_URL: undefined }))).toThrow(
      /DATABASE_MIGRATION_URL is not set/,
    );
    expect(() => assertLocalDevDatabase(env({ DATABASE_URL: 'not a url' }))).toThrow(
      /DATABASE_URL is not a valid/,
    );
  });
});
