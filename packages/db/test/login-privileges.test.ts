import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPrismaClient,
  loginPrivilegeProblems,
  readLoginPrivileges,
  type LoginPrivileges,
  type PrismaClient,
} from '../src/index.js';
import { APP_URL, INGEST_URL, OWNER_URL, PLATFORM_URL, superuserUrl } from './env.js';

// Every running service checks its database login at start-up and refuses one that is a
// superuser, bypasses RLS, or can become a role that does (or one of the pg_* roles that pass
// every grant). These tests make such roles as the superuser and drop them afterwards.

async function withClient<T>(url: string, fn: (c: PrismaClient) => Promise<T>): Promise<T> {
  const client = createPrismaClient(url);
  try {
    return await fn(client);
  } finally {
    await client.$disconnect();
  }
}

describe('login privileges', () => {
  let su: PrismaClient;
  const made: string[] = [];
  const database = new URL(APP_URL).pathname.slice(1);

  /** A role made for this test run (dropped in afterAll). */
  async function tempRole(attributes: string): Promise<string> {
    const name = `p0_role_${randomBytes(6).toString('hex')}`;
    await su.$executeRawUnsafe(`CREATE ROLE ${name} ${attributes}`);
    made.push(name);
    return name;
  }

  /** A login made for this test run, optionally a member of `member`; returns its URL. */
  async function tempLogin(attributes: string, opts: { member?: string } = {}): Promise<string> {
    const password = randomBytes(18).toString('hex');
    const name = await tempRole(`LOGIN ${attributes} PASSWORD '${password}'`);
    await su.$executeRawUnsafe(`GRANT CONNECT ON DATABASE ${database} TO ${name}`);
    if (opts.member) await su.$executeRawUnsafe(`GRANT ${opts.member} TO ${name}`);
    const url = new URL(APP_URL);
    url.username = name;
    url.password = password;
    return url.toString();
  }

  beforeAll(() => {
    su = createPrismaClient(superuserUrl());
  });

  afterAll(async () => {
    for (const name of made.reverse()) {
      await su.$executeRawUnsafe(`REVOKE CONNECT ON DATABASE ${database} FROM ${name}`);
      await su.$executeRawUnsafe(`DROP ROLE IF EXISTS ${name}`);
    }
    await su.$disconnect();
  });

  it('the runtime logins (app, platform, receiver) and the owner have none', async () => {
    for (const url of [APP_URL, PLATFORM_URL, INGEST_URL, OWNER_URL]) {
      const p = await withClient(url, readLoginPrivileges);
      expect(loginPrivilegeProblems(p)).toEqual([]);
    }
  });

  it('names the login it checked', async () => {
    const p = await withClient(APP_URL, readLoginPrivileges);
    expect(p.login).toBe(new URL(APP_URL).username);
  });

  it('refuses the Postgres superuser', async () => {
    const p = await withClient(superuserUrl(), readLoginPrivileges);
    expect(p.superuser).toBe(true);
    expect(loginPrivilegeProblems(p)).toEqual(['is a superuser']);
  });

  it('refuses a login with BYPASSRLS', async () => {
    const p = await withClient(await tempLogin('BYPASSRLS'), readLoginPrivileges);
    expect(p.bypassRls).toBe(true);
    expect(loginPrivilegeProblems(p)).toEqual(['has BYPASSRLS']);
  });

  it('refuses a login that can become a superuser role', async () => {
    const role = await tempRole('NOLOGIN SUPERUSER');
    const p = await withClient(await tempLogin('', { member: role }), readLoginPrivileges);
    expect(loginPrivilegeProblems(p)).toEqual([`can become ${role}`]);
  });

  it('refuses a login that can become a BYPASSRLS role', async () => {
    const role = await tempRole('NOLOGIN BYPASSRLS');
    const p = await withClient(await tempLogin('', { member: role }), readLoginPrivileges);
    expect(loginPrivilegeProblems(p)).toEqual([`can become ${role}`]);
  });

  it('refuses a login that can become pg_read_all_data', async () => {
    const url = await tempLogin('', { member: 'pg_read_all_data' });
    const p = await withClient(url, readLoginPrivileges);
    expect(loginPrivilegeProblems(p)).toEqual(['can become pg_read_all_data']);
  });
});

describe('loginPrivilegeProblems', () => {
  const safe: LoginPrivileges = {
    login: 'jantrik_app',
    superuser: false,
    bypassRls: false,
    canBecome: [],
  };

  it('lists nothing for a plain login', () => {
    expect(loginPrivilegeProblems(safe)).toEqual([]);
  });

  it('lists BYPASSRLS and each role the login can become', () => {
    expect(loginPrivilegeProblems({ ...safe, bypassRls: true, canBecome: ['a', 'b'] })).toEqual([
      'has BYPASSRLS',
      'can become a',
      'can become b',
    ]);
  });

  it('says only "is a superuser" for a superuser (it can become every role anyway)', () => {
    expect(
      loginPrivilegeProblems({ ...safe, superuser: true, bypassRls: true, canBecome: ['x'] }),
    ).toEqual(['is a superuser']);
  });
});
