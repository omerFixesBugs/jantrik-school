import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPrismaClient,
  loginPrivilegeProblems,
  loginStartupVerdict,
  readLoginPrivileges,
  type LoginPrivileges,
  type PrismaClient,
} from '../src/index.js';
import { APP_URL, INGEST_URL, OWNER_URL, PLATFORM_URL, superuserUrl } from './env.js';

// Every running service checks its database login at start-up and refuses one that is a
// superuser, bypasses RLS, has REPLICATION or CREATEROLE, or can become a role that does (or one
// of the pg_* roles that pass every grant). These tests make such roles as the superuser and drop them afterwards.

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

  it('reads TEMP: the runtime logins have none, the owner keeps it, a login granted it has it', async () => {
    for (const url of [APP_URL, PLATFORM_URL, INGEST_URL]) {
      const p = await withClient(url, readLoginPrivileges);
      expect({ login: p.login, temp: p.temp }).toEqual({ login: p.login, temp: false });
    }
    expect((await withClient(OWNER_URL, readLoginPrivileges)).temp).toBe(true);
    const url = await tempLogin('');
    const login = new URL(url).username;
    await su.$executeRawUnsafe(`GRANT TEMPORARY ON DATABASE ${database} TO ${login}`);
    try {
      const p = await withClient(url, readLoginPrivileges);
      expect(p.temp).toBe(true);
      expect(loginStartupVerdict(p, { production: true }).problems).toEqual([
        'may create temporary objects (TEMP)',
      ]);
      const elsewhere = loginStartupVerdict(p, { production: false });
      expect(elsewhere.problems).toEqual([]);
      expect(elsewhere.warnings.join(' ')).toMatch(
        /may create temporary objects.*REVOKE TEMPORARY/,
      );
    } finally {
      await su.$executeRawUnsafe(`REVOKE TEMPORARY ON DATABASE ${database} FROM ${login}`);
    }
  });

  it('reads TEMP through a role the login can only SET ROLE to (no INHERIT)', async () => {
    const holder = await tempRole('NOLOGIN');
    await su.$executeRawUnsafe(`GRANT TEMPORARY ON DATABASE ${database} TO ${holder}`);
    const url = await tempLogin('');
    const login = new URL(url).username;
    await su.$executeRawUnsafe(`GRANT ${holder} TO ${login} WITH INHERIT FALSE, SET TRUE`);
    try {
      expect((await withClient(url, readLoginPrivileges)).temp).toBe(true);
    } finally {
      await su.$executeRawUnsafe(`REVOKE TEMPORARY ON DATABASE ${database} FROM ${holder}`);
    }
  });

  it('reads role settings (for every database or this one); only the expected ones pass', async () => {
    // The runtime logins: none, but the receiver's own 5 s statement timeout (decision #79; a
    // volume made before step 11's role script may lack it: its pool sends the same limit).
    expect((await withClient(APP_URL, readLoginPrivileges)).roleSettings).toEqual([]);
    expect((await withClient(PLATFORM_URL, readLoginPrivileges)).roleSettings).toEqual([]);
    const receiver = (await withClient(INGEST_URL, readLoginPrivileges)).roleSettings;
    expect(receiver.filter((s) => s !== 'statement_timeout=5s')).toEqual([]);
    // What an injection could store for its own login (P1-J8 review round 2): it outlives
    // restarts (with a 1 ms timeout even the start-up check fails, which also stops the start).
    // Here a harmless value on a login made for this test.
    const url = await tempLogin('');
    const login = new URL(url).username;
    await su.$executeRawUnsafe(`ALTER ROLE ${login} SET work_mem = '64kB'`);
    await su.$executeRawUnsafe(
      `ALTER ROLE ${login} IN DATABASE ${database} SET statement_timeout = '7min'`,
    );
    try {
      const p = await withClient(url, readLoginPrivileges);
      expect(p.roleSettings).toEqual(['statement_timeout=7min', 'work_mem=64kB']);
      expect(loginStartupVerdict(p, { production: true }).problems).toEqual([
        'has role settings it should not have (statement_timeout=7min, work_mem=64kB)',
      ]);
      expect(
        loginStartupVerdict(p, { production: true, expectedSettings: ['work_mem=64kB'] }).problems,
      ).toEqual(['has role settings it should not have (statement_timeout=7min)']);
      const elsewhere = loginStartupVerdict(p, { production: false });
      expect(elsewhere.problems).toEqual([]);
      expect(elsewhere.warnings.join(' ')).toMatch(/RESET ALL/);
    } finally {
      await su.$executeRawUnsafe(`ALTER ROLE ${login} RESET ALL`);
      await su.$executeRawUnsafe(`ALTER ROLE ${login} IN DATABASE ${database} RESET ALL`);
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

  it('checks the login itself, not a role it switched to when connecting', async () => {
    // A superuser login whose URL sets `-c role=<a plain role>`: the session runs as the plain
    // role (current_user), and SQL can RESET ROLE back to the superuser at any time.
    const plain = await tempRole('NOLOGIN');
    const url = new URL(await tempLogin('SUPERUSER'));
    url.searchParams.set('options', `-c role=${plain}`);
    const [row] = await withClient(
      url.toString(),
      (c) => c.$queryRaw<{ role: string }[]>`SELECT current_user::text AS role`,
    );
    expect(row!.role).toBe(plain);
    const p = await withClient(url.toString(), readLoginPrivileges);
    expect(p.login).toBe(url.username);
    expect(loginPrivilegeProblems(p)).toEqual(['is a superuser']);
  });

  it('refuses a login with REPLICATION (it can stream every row, RLS or not)', async () => {
    const p = await withClient(await tempLogin('REPLICATION'), readLoginPrivileges);
    expect(p.replication).toBe(true);
    expect(loginPrivilegeProblems(p)).toEqual(['has REPLICATION']);
  });

  it('refuses a login with CREATEROLE (no runtime login needs it)', async () => {
    const p = await withClient(await tempLogin('CREATEROLE'), readLoginPrivileges);
    expect(p.createRole).toBe(true);
    expect(loginPrivilegeProblems(p)).toEqual(['has CREATEROLE']);
  });

  it('refuses a login that can become a REPLICATION or CREATEROLE role', async () => {
    for (const attribute of ['REPLICATION', 'CREATEROLE']) {
      const role = await tempRole(`NOLOGIN ${attribute}`);
      const p = await withClient(await tempLogin('', { member: role }), readLoginPrivileges);
      expect(loginPrivilegeProblems(p)).toEqual([`can become ${role}`]);
    }
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
    replication: false,
    createRole: false,
    temp: false,
    roleSettings: [],
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

  it('lists REPLICATION and CREATEROLE', () => {
    expect(loginPrivilegeProblems({ ...safe, replication: true })).toEqual(['has REPLICATION']);
    expect(loginPrivilegeProblems({ ...safe, createRole: true })).toEqual(['has CREATEROLE']);
    expect(
      loginPrivilegeProblems({ ...safe, bypassRls: true, replication: true, createRole: true }),
    ).toEqual(['has BYPASSRLS', 'has REPLICATION', 'has CREATEROLE']);
  });

  it('says only "is a superuser" for a superuser (it can become every role anyway)', () => {
    expect(
      loginPrivilegeProblems({ ...safe, superuser: true, bypassRls: true, canBecome: ['x'] }),
    ).toEqual(['is a superuser']);
  });
});
