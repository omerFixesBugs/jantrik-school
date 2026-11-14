import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrCreateUser, withTenant, type Prisma, type PrismaClient } from '../src/index.js';
import { appClient, createTenant, randomPhone } from './helpers.js';

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

/** A TIME column's value (Prisma maps it to a Date on 1970-01-01 UTC). */
const time = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00Z`);
/** A time on 2026-10-20 in Asia/Dhaka. */
const at = (hhmm: string) => new Date(`2026-10-20T${hhmm}:00+06:00`);

/** A staff member (membership and profile) of the institute. */
async function addStaff(tx: Tx, tenantId: string, name: string) {
  const userId = await findOrCreateUser(tx, randomPhone(), name);
  await tx.membership.create({ data: { tenantId, userId, role: 'TEACHER' } });
  await tx.staffProfile.create({ data: { tenantId, userId, name, phone: randomPhone() } });
  return userId;
}

/** An institute with an admin, a staff member and the staff member's day on 2026-10-20. */
async function institute(app: PrismaClient) {
  const tenantId = (await createTenant(app)).id;
  return withTenant(app, tenantId, async (tx) => {
    const adminId = await findOrCreateUser(tx, randomPhone(), 'Admin');
    await tx.membership.create({ data: { tenantId, userId: adminId, role: 'ADMIN' } });
    const staffUserId = await addStaff(tx, tenantId, 'Staff');
    const day = await tx.staffAttendanceDay.create({
      data: {
        tenantId,
        userId: staffUserId,
        date: new Date('2026-10-20'),
        status: 'PRESENT',
        inAt: at('08:12'),
        officeStart: time('08:00'),
        officeEnd: time('16:00'),
        lateMinutes: 2,
        source: 'DEVICE',
      },
    });
    return { tenantId, adminId, staffUserId, dayId: day.id };
  });
}

describe('staff_attendance_days: tenant isolation and rules', () => {
  let app: PrismaClient;
  let a: Awaited<ReturnType<typeof institute>>;
  let b: Awaited<ReturnType<typeof institute>>;

  beforeAll(async () => {
    app = appClient();
    a = await institute(app);
    b = await institute(app);
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  const asA = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, a.tenantId, fn);
  const asB = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, b.tenantId, fn);

  /** A valid MANUAL day of A's staff member on `date`, with `over` applied. */
  const manualDay = (
    date: string,
    over: Partial<Prisma.StaffAttendanceDayUncheckedCreateInput> = {},
  ): Prisma.StaffAttendanceDayUncheckedCreateInput => ({
    tenantId: a.tenantId,
    userId: a.staffUserId,
    date: new Date(date),
    status: 'PRESENT',
    inAt: at('08:00'),
    officeStart: time('08:00'),
    officeEnd: time('16:00'),
    source: 'MANUAL',
    reason: 'Forgot to punch',
    updatedById: a.adminId,
    ...over,
  });

  it('each tenant sees only its own rows; no context sees none', async () => {
    const rowsA = await asA((tx) => tx.staffAttendanceDay.findMany());
    expect(rowsA.map((r) => r.id)).toEqual([a.dayId]);
    const rowsB = await asB((tx) => tx.staffAttendanceDay.findMany());
    expect(rowsB.map((r) => r.id)).toEqual([b.dayId]);
    expect(await app.staffAttendanceDay.count()).toBe(0);
  });

  it("another tenant cannot change A's day or write one with A's tenant_id", async () => {
    const changed = await asB((tx) =>
      tx.staffAttendanceDay.updateMany({ where: { id: a.dayId }, data: { lateMinutes: 99 } }),
    );
    expect(changed.count).toBe(0);
    const day = await asA((tx) =>
      tx.staffAttendanceDay.findUniqueOrThrow({ where: { id: a.dayId } }),
    );
    expect(day.lateMinutes).toBe(2);
    await expect(
      asB((tx) => tx.staffAttendanceDay.create({ data: manualDay('2026-10-21') })),
    ).rejects.toThrow(/row-level security/i);
    await expect(
      asA((tx) =>
        tx.$executeRawUnsafe(`UPDATE staff_attendance_days SET tenant_id = '${b.tenantId}'`),
      ),
    ).rejects.toThrow(/row-level security|foreign key/i);
  });

  it("a day cannot belong to another institute's staff member, or to someone without a profile", async () => {
    await expect(
      asB((tx) =>
        tx.staffAttendanceDay.create({
          data: { ...manualDay('2026-10-21'), tenantId: b.tenantId, updatedById: b.adminId },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
    // A's admin has a membership here but no staff profile.
    await expect(
      asA((tx) =>
        tx.staffAttendanceDay.create({ data: manualDay('2026-10-21', { userId: a.adminId }) }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('the app cannot delete staff days (history)', async () => {
    await expect(
      asA((tx) => tx.$executeRawUnsafe('DELETE FROM staff_attendance_days')),
    ).rejects.toThrow(/permission denied/i);
  });

  it('one row per person per day', async () => {
    await expect(
      asA((tx) => tx.staffAttendanceDay.create({ data: manualDay('2026-10-20') })),
    ).rejects.toThrow(/staff_attendance_days_tenant_id_user_id_date_key/);
  });

  it('checks reject bad values', async () => {
    // Each case breaks exactly one CHECK.
    const refused: [Partial<Prisma.StaffAttendanceDayUncheckedCreateInput>, RegExp][] = [
      // MANUAL needs a reason of 3–200 characters and who wrote it.
      [{ reason: null }, /staff_attendance_days_manual_reason/],
      [{ updatedById: null }, /staff_attendance_days_manual_reason/],
      [{ reason: 'ab' }, /staff_attendance_days_manual_reason/],
      [{ reason: '  ab  ' }, /staff_attendance_days_manual_reason/],
      [{ reason: 'x'.repeat(201) }, /staff_attendance_days_manual_reason/],
      // Times.
      [{ outAt: at('07:59') }, /staff_attendance_days_out_after_in/],
      [{ status: 'ABSENT' }, /staff_attendance_days_times_present_only/],
      [{ status: 'LEAVE' }, /staff_attendance_days_times_present_only/],
      [{ inAt: null }, /staff_attendance_days_present_has_in/],
      // The device never writes LEAVE.
      [
        { status: 'LEAVE', inAt: null, source: 'DEVICE', reason: null, updatedById: null },
        /staff_attendance_days_device_no_leave/,
      ],
      // Only an admin's MANUAL day carries a reason.
      [
        { source: 'DEVICE', reason: 'Device was down', updatedById: null },
        /staff_attendance_days_device_no_reason/,
      ],
      [
        { status: 'ABSENT', inAt: null, source: 'DEVICE', reason: 'Absent', updatedById: null },
        /staff_attendance_days_device_no_reason/,
      ],
      // Office hours and minutes.
      [{ officeEnd: time('08:00') }, /staff_attendance_days_office_hours/],
      [{ lateMinutes: -1 }, /staff_attendance_days_late_range/],
      [{ lateMinutes: 1441 }, /staff_attendance_days_late_range/],
      [{ earlyMinutes: -1 }, /staff_attendance_days_early_range/],
      [{ earlyMinutes: 1441 }, /staff_attendance_days_early_range/],
      [{ version: 0 }, /staff_attendance_days_version_positive/],
    ];
    for (const [over, error] of refused) {
      await expect(
        asA((tx) => tx.staffAttendanceDay.create({ data: manualDay('2026-10-22', over) })),
        JSON.stringify(over),
      ).rejects.toThrow(error);
    }
  });

  it('accepts the valid shapes: device ABSENT without times, manual LEAVE and PRESENT', async () => {
    const created = await asA(async (tx) => [
      // A review rejected every punch of a device day: ABSENT, no times, still DEVICE.
      await tx.staffAttendanceDay.create({
        data: manualDay('2026-10-23', {
          status: 'ABSENT',
          inAt: null,
          source: 'DEVICE',
          reason: null,
          updatedById: null,
        }),
      }),
      await tx.staffAttendanceDay.create({
        data: manualDay('2026-10-24', { status: 'LEAVE', inAt: null, reason: 'Sick' }),
      }),
      await tx.staffAttendanceDay.create({
        data: manualDay('2026-10-25', {
          outAt: at('16:30'),
          lateMinutes: 1440,
          earlyMinutes: 0,
        }),
      }),
    ]);
    expect(created.map((d) => [d.status, d.source])).toEqual([
      ['ABSENT', 'DEVICE'],
      ['LEAVE', 'MANUAL'],
      ['PRESENT', 'MANUAL'],
    ]);
    // An admin's change of a device day: MANUAL from then on, with the reason.
    const updated = await asA((tx) =>
      tx.staffAttendanceDay.update({
        where: { id: a.dayId },
        data: {
          status: 'LEAVE',
          inAt: null,
          lateMinutes: 0,
          source: 'MANUAL',
          reason: 'Approved leave',
          updatedById: a.adminId,
          version: { increment: 1 },
        },
      }),
    );
    expect(updated).toMatchObject({ status: 'LEAVE', source: 'MANUAL', version: 2 });
  });

  it('attendance_tracked defaults to NULL and the app may set it', async () => {
    const profile = await asA((tx) =>
      tx.staffProfile.findUniqueOrThrow({
        where: { tenantId_userId: { tenantId: a.tenantId, userId: a.staffUserId } },
      }),
    );
    expect(profile.attendanceTracked).toBeNull();
    const updated = await asA((tx) =>
      tx.staffProfile.update({ where: { id: profile.id }, data: { attendanceTracked: false } }),
    );
    expect(updated.attendanceTracked).toBe(false);
    const other = await asA(async (tx) => {
      const userId = await addStaff(tx, a.tenantId, `Other ${randomUUID().slice(0, 4)}`);
      return tx.staffProfile.findUniqueOrThrow({
        where: { tenantId_userId: { tenantId: a.tenantId, userId } },
      });
    });
    expect(other.attendanceTracked).toBeNull();
  });
});
