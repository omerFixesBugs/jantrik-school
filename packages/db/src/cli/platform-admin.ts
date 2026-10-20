import os from 'node:os';
import { hash } from '@node-rs/argon2';
import type { PrismaClient } from '../generated/prisma/client.js';

// `pnpm platform:admin <command>`: create or manage platform admins (Jantrik's own staff) from
// the server shell. Works in production (unlike the seed). Connects as the owner role
// (DATABASE_MIGRATION_URL), never prints a password or a 2FA secret, and records every change in
// platform_audit_logs (actor CLI). See docs/platform.md.

export const USAGE = `Usage: pnpm platform:admin <command> [flags]

  create    --phone <01XXXXXXXXX> --name "<full name>" [--email <email>]
  password  --phone <01XXXXXXXXX>                       (ends their sessions)
  disable   --phone <01XXXXXXXXX> --reason "<why>"      (ends their sessions)
  enable    --phone <01XXXXXXXXX> --reason "<why>"
  reset-2fa --phone <01XXXXXXXXX> --reason "<why>"      (removes the authenticator and backup
                                                          codes, ends sessions; they enrol again
                                                          at the next login)
  list

create and password read the password from stdin with --password-stdin, otherwise they ask for
it (hidden). Passwords are never accepted as an argument.`;

const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };
const MIN_PASSWORD = 12;

export interface CliIo {
  prisma: PrismaClient;
  /** The password (from stdin or a hidden prompt). */
  readPassword: (prompt: string) => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Who ran it, for the audit log. */
  operator: { osUser: string; host: string };
}

export class CliError extends Error {}

/** E.164 for a Bangladeshi mobile number (01…, 8801…, +8801…), or null. */
export function cliPhone(input: string | undefined): string | null {
  const digits = (input ?? '').replace(/[\s-]/g, '');
  const m = /^(?:\+?88)?(01[3-9]\d{8})$/.exec(digits);
  return m ? `+88${m[1]}` : null;
}

const masked = (phone: string) => `${phone.slice(0, 6)}*****${phone.slice(-3)}`;

/** The flags each command accepts (anything else is refused, never ignored). */
const ALLOWED: Record<string, string[]> = {
  list: [],
  create: ['phone', 'name', 'email'],
  password: ['phone'],
  disable: ['phone', 'reason'],
  enable: ['phone', 'reason'],
  'reset-2fa': ['phone', 'reason'],
};

/** How long a new (or reset) admin has to set up the authenticator at the first login. */
export const ENROL_WINDOW_HOURS = 24;
const enrolBy = () => new Date(Date.now() + ENROL_WINDOW_HOURS * 3600 * 1000);

function parseFlags(command: string, args: string[]): Record<string, string | true> {
  const flags: Record<string, string | true> = {};
  const allowed = ALLOWED[command] ?? [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) throw new CliError(`Unexpected argument: ${arg}`);
    const name = arg.slice(2).split('=')[0]!;
    if (name === 'password') {
      throw new CliError('Passwords are never accepted as an argument; use --password-stdin');
    }
    if (arg.includes('=')) throw new CliError(`Write --${name} <value> (without "=")`);
    if (!allowed.includes(name)) throw new CliError(`Unknown flag for ${command}: --${name}`);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) flags[name] = true;
    else {
      flags[name] = next;
      i++;
    }
  }
  return flags;
}

const text = (flags: Record<string, string | true>, name: string, required: boolean) => {
  const v = flags[name];
  if (v === true || (required && (v === undefined || !v.trim()))) {
    throw new CliError(`--${name} is required`);
  }
  return typeof v === 'string' ? v.trim() : undefined;
};

async function newPasswordHash(io: CliIo): Promise<string> {
  const password = await io.readPassword('New password: ');
  if (password.length < MIN_PASSWORD) {
    throw new CliError(`The password must be at least ${MIN_PASSWORD} characters`);
  }
  if (password.length > 256) throw new CliError('The password is too long');
  return hash(password, ARGON2);
}

async function audit(
  tx: Pick<PrismaClient, 'platformAuditLog'>,
  io: CliIo,
  action: string,
  adminId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await tx.platformAuditLog.create({
    data: {
      actor: 'CLI',
      action,
      entity: 'platform_admin',
      entityId: adminId,
      details: { ...details, osUser: io.operator.osUser, host: io.operator.host },
    },
  });
}

/** Runs one command. Throws CliError for a usage problem (the caller exits 1). */
export async function runPlatformAdminCli(argv: string[], io: CliIo): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') {
    io.out(USAGE);
    return;
  }
  if (!ALLOWED[command])
    throw new CliError(`Unknown command: ${command}

${USAGE}`);
  const flags = parseFlags(command, rest);
  const { prisma } = io;

  if (command === 'list') {
    const admins = await prisma.platformAdmin.findMany({
      orderBy: { createdAt: 'asc' },
      select: { name: true, phone: true, isActive: true, totpEnabledAt: true, lastLoginAt: true },
    });
    for (const a of admins) {
      io.out(
        [
          masked(a.phone),
          a.name,
          a.isActive ? 'active' : 'disabled',
          a.totpEnabledAt ? '2FA on' : '2FA not set up',
          `last login: ${a.lastLoginAt?.toISOString() ?? 'never'}`,
        ].join(' | '),
      );
    }
    if (admins.length === 0) io.out('No platform admins yet.');
    return;
  }

  const phone = cliPhone(text(flags, 'phone', true));
  if (!phone) throw new CliError('--phone must be a Bangladeshi mobile number (01XXXXXXXXX)');

  if (command === 'create') {
    const name = text(flags, 'name', true)!;
    if (name.length > 100) throw new CliError('--name is too long');
    const email = text(flags, 'email', false)?.toLowerCase() ?? null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new CliError('--email is invalid');
    if (await prisma.platformAdmin.findUnique({ where: { phone } })) {
      throw new CliError('A platform admin with this phone already exists');
    }
    if (email && (await prisma.platformAdmin.findUnique({ where: { email } }))) {
      throw new CliError('A platform admin with this email already exists');
    }
    const passwordHash = await newPasswordHash(io);
    await prisma.$transaction(async (tx) => {
      const admin = await tx.platformAdmin.create({
        data: { name, phone, email, passwordHash, totpEnrolBy: enrolBy() },
      });
      await audit(tx, io, 'ADMIN_CREATE', admin.id, { phone, name, email });
    });
    io.out(`Created platform admin ${name} (${masked(phone)}).`);
    io.out(
      `They set up their authenticator app at the first login (/platform/login), within ${ENROL_WINDOW_HOURS} hours.`,
    );
    return;
  }

  const admin = await prisma.platformAdmin.findUnique({ where: { phone } });
  if (!admin) throw new CliError('No platform admin with this phone');
  const endSessions = (
    tx: Pick<PrismaClient, 'platformSession'>,
    reason: 'DISABLED' | 'RESET_2FA' | 'LOGOUT',
  ) =>
    tx.platformSession.updateMany({
      where: { adminId: admin.id, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });

  if (command === 'password') {
    const passwordHash = await newPasswordHash(io);
    await prisma.$transaction(async (tx) => {
      await tx.platformAdmin.update({ where: { id: admin.id }, data: { passwordHash } });
      const { count } = await endSessions(tx, 'LOGOUT');
      await audit(tx, io, 'ADMIN_PASSWORD', admin.id, { phone, sessionsEnded: count });
    });
    io.out(`Password changed for ${admin.name} (${masked(phone)}); their sessions were ended.`);
    return;
  }

  const reason = text(flags, 'reason', true)!;
  if (reason.length > 300) throw new CliError('--reason is too long');

  if (command === 'disable' || command === 'enable') {
    const isActive = command === 'enable';
    await prisma.$transaction(async (tx) => {
      await tx.platformAdmin.update({ where: { id: admin.id }, data: { isActive } });
      const { count } = isActive ? { count: 0 } : await endSessions(tx, 'DISABLED');
      await audit(tx, io, isActive ? 'ADMIN_ENABLE' : 'ADMIN_DISABLE', admin.id, {
        phone,
        reason,
        sessionsEnded: count,
      });
    });
    io.out(`${isActive ? 'Enabled' : 'Disabled'} ${admin.name} (${masked(phone)}).`);
    return;
  }

  if (command === 'reset-2fa') {
    await prisma.$transaction(async (tx) => {
      await tx.platformAdmin.update({
        where: { id: admin.id },
        data: { totpSecret: null, totpEnabledAt: null, totpLastStep: null, totpEnrolBy: enrolBy() },
      });
      const codes = await tx.platformAdminBackupCode.deleteMany({ where: { adminId: admin.id } });
      const { count } = await endSessions(tx, 'RESET_2FA');
      await audit(tx, io, 'ADMIN_RESET_2FA', admin.id, {
        phone,
        reason,
        backupCodesRemoved: codes.count,
        sessionsEnded: count,
      });
    });
    io.out(
      `2FA reset for ${admin.name} (${masked(phone)}); they set it up again at the next login, within ${ENROL_WINDOW_HOURS} hours.`,
    );
    return;
  }

  throw new CliError(`Unknown command: ${command}\n\n${USAGE}`);
}

/** The person running the command, for the audit log. */
export const operator = () => ({ osUser: os.userInfo().username, host: os.hostname() });
