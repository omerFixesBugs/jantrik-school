import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { verify } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CliError, runPlatformAdminCli, type CliIo } from '../src/cli/platform-admin.js';
import type { PrismaClient } from '../src/index.js';
import { OWNER_URL } from './env.js';
import { ownerClient, randomPhone } from './helpers.js';

// `pnpm platform:admin`: bootstraps platform admins from the server shell (also in production).
describe('platform admin CLI', () => {
  let owner: PrismaClient;
  const lines: string[] = [];
  const io = (password = 'a-long-enough-password'): CliIo => ({
    prisma: owner,
    readPassword: async () => password,
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    operator: { osUser: 'tester', host: 'test-host' },
  });
  const local = (e164: string) => `0${e164.slice(4)}`;
  const auditOf = (adminId: string) =>
    owner.platformAuditLog.findMany({
      where: { entityId: adminId },
      orderBy: { createdAt: 'asc' },
    });

  beforeAll(() => {
    owner = ownerClient();
  });

  afterAll(async () => {
    await owner.$disconnect();
  });

  it('create: explicit flags, a strong password from stdin/prompt only, audited, nothing secret printed', async () => {
    const phone = randomPhone();
    await expect(runPlatformAdminCli(['create', '--phone', local(phone)], io())).rejects.toThrow(
      /--name is required/,
    );
    await expect(
      runPlatformAdminCli(
        ['create', '--phone', local(phone), '--name', 'X', '--password', 'p'],
        io(),
      ),
    ).rejects.toThrow(/never accepted as an argument/);
    await expect(
      runPlatformAdminCli(['create', '--phone', local(phone), '--name', 'X'], io('short')),
    ).rejects.toThrow(/at least 12/);
    await expect(
      runPlatformAdminCli(['create', '--phone', '12345', '--name', 'X'], io()),
    ).rejects.toBeInstanceOf(CliError);

    lines.length = 0;
    await runPlatformAdminCli(
      [
        'create',
        '--phone',
        local(phone),
        '--name',
        'Rahim Uddin',
        '--email',
        `Rahim.${phone.slice(-6)}@Jantrik.APP`,
      ],
      io('correct horse battery'),
    );
    expect(lines.join('\n')).not.toContain('correct horse battery');
    expect(lines.join('\n')).not.toContain(phone); // masked
    const admin = await owner.platformAdmin.findUniqueOrThrow({ where: { phone } });
    expect(admin).toMatchObject({
      name: 'Rahim Uddin',
      email: `rahim.${phone.slice(-6)}@jantrik.app`,
      isActive: true,
    });
    expect(admin.totpSecret).toBeNull(); // enrols at the first login
    expect(await verify(admin.passwordHash, 'correct horse battery')).toBe(true);
    const [entry] = await auditOf(admin.id);
    expect(entry).toMatchObject({ actor: 'CLI', action: 'ADMIN_CREATE', adminId: null });
    expect(entry!.details).toMatchObject({ osUser: 'tester', host: 'test-host', phone });
    await expect(
      runPlatformAdminCli(['create', '--phone', local(phone), '--name', 'Again'], io()),
    ).rejects.toThrow(/already exists/);
  });

  it('disable  enable / reset-2fa / password need a reason (except password), end sessions, are audited', async () => {
    const phone = randomPhone();
    await runPlatformAdminCli(['create', '--phone', phone, '--name', 'Karim'], io());
    const admin = await owner.platformAdmin.update({
      where: { phone },
      data: { totpSecret: 'v1.x', totpEnabledAt: new Date(), totpLastStep: 5n },
    });
    await owner.platformAdminBackupCode.create({
      data: { adminId: admin.id, codeHash: 'a'.repeat(64) },
    });
    const session = () =>
      owner.platformSession.create({
        data: {
          adminId: admin.id,
          tokenHash: Math.random().toString(16).slice(2).padEnd(64, '0').slice(0, 64),
          idleExpiresAt: new Date(Date.now() + 60_000),
          expiresAt: new Date(Date.now() + 120_000),
        },
      });

    await expect(runPlatformAdminCli(['disable', '--phone', phone], io())).rejects.toThrow(
      /--reason is required/,
    );
    const s1 = await session();
    await runPlatformAdminCli(['disable', '--phone', phone, '--reason', 'left the team'], io());
    expect(await owner.platformAdmin.findUniqueOrThrow({ where: { phone } })).toMatchObject({
      isActive: false,
    });
    expect(await owner.platformSession.findUniqueOrThrow({ where: { id: s1.id } })).toMatchObject({
      revokeReason: 'DISABLED',
    });
    await runPlatformAdminCli(['enable', '--phone', phone, '--reason', 'came back'], io());

    const s2 = await session();
    await runPlatformAdminCli(['reset-2fa', '--phone', phone, '--reason', 'lost phone'], io());
    const reset = await owner.platformAdmin.findUniqueOrThrow({ where: { phone } });
    expect(reset).toMatchObject({
      totpSecret: null,
      totpEnabledAt: null,
      totpLastStep: null,
      isActive: true,
    });
    expect(await owner.platformAdminBackupCode.count({ where: { adminId: admin.id } })).toBe(0);
    expect(await owner.platformSession.findUniqueOrThrow({ where: { id: s2.id } })).toMatchObject({
      revokeReason: 'RESET_2FA',
    });

    const s3 = await session();
    await runPlatformAdminCli(['password', '--phone', phone], io('another long password'));
    expect(
      await verify(
        (await owner.platformAdmin.findUniqueOrThrow({ where: { phone } })).passwordHash,
        'another long password',
      ),
    ).toBe(true);
    expect(
      (await owner.platformSession.findUniqueOrThrow({ where: { id: s3.id } })).revokedAt,
    ).not.toBeNull();

    const actions = (await auditOf(admin.id)).map((a) => a.action);
    expect(actions).toEqual([
      'ADMIN_CREATE',
      'ADMIN_DISABLE',
      'ADMIN_ENABLE',
      'ADMIN_RESET_2FA',
      'ADMIN_PASSWORD',
    ]);
    const resetEntry = (await auditOf(admin.id)).find((a) => a.action === 'ADMIN_RESET_2FA')!;
    expect(resetEntry.details).toMatchObject({
      reason: 'lost phone',
      backupCodesRemoved: 1,
      sessionsEnded: 1,
    });
  });

  it('flags are strict: unknown flags and --flag=value are refused, never ignored', async () => {
    const phone = local(randomPhone());
    await expect(
      runPlatformAdminCli(['create', '--phone', phone, '--name', 'X', '--nmae', 'typo'], io()),
    ).rejects.toThrow(/Unknown flag for create: --nmae/);
    await expect(
      runPlatformAdminCli(['create', '--phone', phone, '--name', 'X', '--password=secret'], io()),
    ).rejects.toThrow(/never accepted as an argument/);
    await expect(
      runPlatformAdminCli(['create', `--phone=${phone}`, '--name', 'X'], io()),
    ).rejects.toThrow(/without "="/);
    await expect(
      runPlatformAdminCli(['disable', '--phone', phone, '--name', 'X'], io()),
    ).rejects.toThrow(/Unknown flag/);
    await expect(runPlatformAdminCli(['delete', '--phone', phone], io())).rejects.toThrow(
      /Unknown command/,
    );
  });

  it('create and reset-2fa open a 24-hour window to set up the authenticator', async () => {
    const phone = randomPhone();
    await runPlatformAdminCli(['create', '--phone', phone, '--name', 'Window'], io());
    const within = (d: Date | null) => (d!.getTime() - Date.now()) / 3_600_000;
    let admin = await owner.platformAdmin.findUniqueOrThrow({ where: { phone } });
    expect(within(admin.totpEnrolBy)).toBeGreaterThan(23.9);
    expect(within(admin.totpEnrolBy)).toBeLessThanOrEqual(24);
    await owner.platformAdmin.update({
      where: { phone },
      data: { totpSecret: 'v1.x', totpEnabledAt: new Date(), totpEnrolBy: null },
    });
    await runPlatformAdminCli(['reset-2fa', '--phone', phone, '--reason', 'new phone'], io());
    admin = await owner.platformAdmin.findUniqueOrThrow({ where: { phone } });
    expect(admin.totpSecret).toBeNull();
    expect(within(admin.totpEnrolBy)).toBeGreaterThan(23.9);
  });

  it('list shows masked phones and 2FA state only', async () => {
    lines.length = 0;
    await runPlatformAdminCli(['list'], io());
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^\+8801\d\*{5}\d{3} \| /);
  });

  it('the real command: password from stdin, never echoed, exits 0', () => {
    const phone = randomPhone();
    const cwd = path.resolve(import.meta.dirname, '..');
    const run = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/cli/main.ts',
        'create',
        '--phone',
        phone,
        '--name',
        'Stdin Admin',
        '--password-stdin',
      ],
      {
        cwd,
        input: 'a password from stdin\n',
        env: { ...process.env, DATABASE_MIGRATION_URL: OWNER_URL },
        encoding: 'utf8',
      },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout + run.stderr).not.toContain('a password from stdin');
    expect(run.stdout).toContain('Created platform admin Stdin Admin');
  });
});
