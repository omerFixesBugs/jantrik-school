import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrCreateUser, withTenant, type PrismaClient } from '../src/index.js';
import { appClient, createTenant, randomPhone } from './helpers.js';

/** A tenant with one section, one enrolled student, a teacher and one of every attendance row. */
async function school(app: PrismaClient, instituteTypeKey = 'NCTB_SCHOOL_BN') {
  const tenant = await createTenant(app, { instituteTypeKey });
  const tenantId = tenant.id;
  return withTenant(app, tenantId, async (tx) => {
    const year = await tx.academicYear.findFirstOrThrow({ where: { isCurrent: true } });
    const classLevel = await tx.classLevel.findFirstOrThrow({ orderBy: { sortOrder: 'asc' } });
    const section = await tx.section.create({
      data: { tenantId, academicYearId: year.id, classLevelId: classLevel.id, name: 'A' },
    });
    const student = await tx.student.create({
      data: { tenantId, studentCode: `S-${randomUUID().slice(0, 6)}`, nameEn: 'Student' },
    });
    const teacherId = await findOrCreateUser(tx, randomPhone(), 'Teacher');
    await tx.membership.create({ data: { tenantId, userId: teacherId, role: 'TEACHER' } });
    await tx.sectionTeacher.create({
      data: { tenantId, sectionId: section.id, userId: teacherId, isClassTeacher: true },
    });
    await tx.holiday.create({
      data: {
        tenantId,
        startDate: new Date('2026-12-16'),
        endDate: new Date('2026-12-16'),
        nameBn: 'বিজয় দিবস',
        nameEn: 'Victory Day',
      },
    });
    const session = await tx.attendanceSession.create({
      data: {
        tenantId,
        sectionId: section.id,
        date: new Date('2026-10-18'),
        takenById: teacherId,
        updatedById: teacherId,
        submittedAt: new Date(),
        lastSubmissionId: randomUUID(),
      },
    });
    await tx.attendanceRecord.create({
      data: { tenantId, sessionId: session.id, studentId: student.id, status: 'ABSENT' },
    });
    await tx.smsLog.create({
      data: {
        tenantId,
        phone: randomPhone(),
        purpose: 'ATTENDANCE_ABSENT',
        segments: 1,
        body: 'x',
        localDate: new Date('2026-10-18'),
        dedupeKey: `absent:${student.id}:2026-10-18`,
      },
    });
    return {
      tenantId,
      sectionId: section.id,
      studentId: student.id,
      sessionId: session.id,
      teacherId,
    };
  });
}

const TABLES = [
  'attendanceSettings',
  'holiday',
  'sectionTeacher',
  'attendanceSession',
  'attendanceRecord',
  'smsLog',
] as const;

describe('attendance tables: tenant isolation', () => {
  let app: PrismaClient;
  let a: Awaited<ReturnType<typeof school>>;
  let b: Awaited<ReturnType<typeof school>>;

  beforeAll(async () => {
    app = appClient();
    a = await school(app);
    b = await school(app, 'COACHING');
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  it('provisioning creates attendance settings from the institute type, SMS off', async () => {
    const settingsA = await withTenant(app, a.tenantId, (tx) =>
      tx.attendanceSettings.findUniqueOrThrow({ where: { tenantId: a.tenantId } }),
    );
    expect(settingsA).toMatchObject({
      mode: 'DAILY',
      weeklyOffDays: [5],
      editWindowDays: 0,
      absentSmsEnabled: false,
      absentSmsDelayMinutes: 10,
      dailySmsCap: null,
      leaveCountsAsAbsent: false,
    });
    const settingsB = await withTenant(app, b.tenantId, (tx) =>
      tx.attendanceSettings.findUniqueOrThrow({ where: { tenantId: b.tenantId } }),
    );
    expect(settingsB.mode).toBe('PER_SESSION'); // coaching centre
  });

  it.each(TABLES)('%s: each tenant sees only its own rows', async (model) => {
    const count = (tenantId: string) =>
      withTenant(app, tenantId, (tx) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (tx[model] as any).findMany({ select: { tenantId: true } }),
      ) as Promise<{ tenantId: string }[]>;
    const rowsA = await count(a.tenantId);
    expect(rowsA.length).toBeGreaterThan(0);
    expect(rowsA.every((r) => r.tenantId === a.tenantId)).toBe(true);
    const rowsB = await count(b.tenantId);
    expect(rowsB.every((r) => r.tenantId === b.tenantId)).toBe(true);
  });

  it('no context sees no attendance rows', async () => {
    expect(await app.attendanceRecord.count()).toBe(0);
    expect(await app.smsLog.count()).toBe(0);
  });

  it("a record cannot point at another tenant's student or session", async () => {
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.attendanceRecord.create({
          data: {
            tenantId: a.tenantId,
            sessionId: a.sessionId,
            studentId: b.studentId,
            status: 'PRESENT',
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.attendanceRecord.create({
          data: {
            tenantId: a.tenantId,
            sessionId: b.sessionId,
            studentId: a.studentId,
            status: 'PRESENT',
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("a session or teacher assignment cannot point at another tenant's section", async () => {
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.attendanceSession.create({
          data: {
            tenantId: a.tenantId,
            sectionId: b.sectionId,
            date: new Date('2026-10-19'),
            takenById: a.teacherId,
            updatedById: a.teacherId,
            submittedAt: new Date(),
            lastSubmissionId: randomUUID(),
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.sectionTeacher.create({
          data: { tenantId: a.tenantId, sectionId: b.sectionId, userId: a.teacherId },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('one register per section, date and period; one class teacher per section', async () => {
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.attendanceSession.create({
          data: {
            tenantId: a.tenantId,
            sectionId: a.sectionId,
            date: new Date('2026-10-18'),
            takenById: a.teacherId,
            updatedById: a.teacherId,
            submittedAt: new Date(),
            lastSubmissionId: randomUUID(),
          },
        }),
      ),
    ).rejects.toThrow(/unique/i);
    await expect(
      withTenant(app, a.tenantId, async (tx) => {
        const other = await findOrCreateUser(tx, randomPhone(), 'Other');
        await tx.sectionTeacher.create({
          data: {
            tenantId: a.tenantId,
            sectionId: a.sectionId,
            userId: other,
            isClassTeacher: true,
          },
        });
      }),
    ).rejects.toThrow(/unique/i);
  });

  it('sms_logs: one row per dedupe key per tenant; rows without a key are not limited', async () => {
    const row = (dedupeKey: string | null) => ({
      tenantId: a.tenantId,
      phone: randomPhone(),
      purpose: 'ATTENDANCE_ABSENT' as const,
      segments: 1,
      body: 'x',
      localDate: new Date('2026-10-18'),
      dedupeKey,
    });
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.smsLog.create({ data: row(`absent:${a.studentId}:2026-10-18`) }),
      ),
    ).rejects.toThrow(/unique/i);
    await withTenant(app, a.tenantId, (tx) =>
      tx.smsLog.createMany({ data: [row(null), row(null)] }),
    );
  });

  it('attendance history and SMS logs cannot be deleted by the app role', async () => {
    for (const table of ['attendance_records', 'attendance_sessions', 'sms_logs']) {
      await expect(
        withTenant(app, a.tenantId, (tx) => tx.$executeRawUnsafe(`DELETE FROM ${table}`)),
      ).rejects.toThrow(/permission denied/i);
    }
  });

  it('checks reject bad values', async () => {
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.attendanceSettings.update({
          where: { tenantId: a.tenantId },
          data: { weeklyOffDays: [0] },
        }),
      ),
    ).rejects.toThrow(/attendance_settings_off_days_valid/);
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.holiday.create({
          data: {
            tenantId: a.tenantId,
            startDate: new Date('2026-12-17'),
            endDate: new Date('2026-12-16'),
            nameBn: 'x',
            nameEn: 'x',
          },
        }),
      ),
    ).rejects.toThrow(/holidays_date_order/);
  });

  it('a DEVICE register may have no taker; a MANUAL one must name both', async () => {
    const register = (
      date: string,
      data: {
        source?: 'MANUAL' | 'DEVICE';
        takenById: string | null;
        updatedById: string | null;
      },
    ) =>
      withTenant(app, a.tenantId, (tx) =>
        tx.attendanceSession.create({
          data: {
            tenantId: a.tenantId,
            sectionId: a.sectionId,
            date: new Date(date),
            submittedAt: new Date(),
            lastSubmissionId: randomUUID(),
            ...data,
          },
        }),
      );
    const device = await register('2026-10-20', {
      source: 'DEVICE',
      takenById: null,
      updatedById: null,
    });
    expect(device).toMatchObject({ source: 'DEVICE', takenById: null, updatedById: null });
    // Its records are the device's; the app may mark one MANUAL (a teacher's correction).
    await withTenant(app, a.tenantId, async (tx) => {
      const record = await tx.attendanceRecord.create({
        data: {
          tenantId: a.tenantId,
          sessionId: device.id,
          studentId: a.studentId,
          status: 'PRESENT',
          source: 'DEVICE',
        },
      });
      const updated = await tx.attendanceRecord.update({
        where: { id: record.id },
        data: { status: 'ABSENT', source: 'MANUAL' },
      });
      expect(updated.source).toBe('MANUAL');
    });

    await expect(
      register('2026-10-21', { takenById: null, updatedById: a.teacherId }),
    ).rejects.toThrow(/attendance_sessions_taker/);
    await expect(
      register('2026-10-21', { takenById: a.teacherId, updatedById: null }),
    ).rejects.toThrow(/attendance_sessions_updater/);
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.attendanceSession.update({ where: { id: a.sessionId }, data: { updatedById: null } }),
      ),
    ).rejects.toThrow(/attendance_sessions_updater/);
    // A register with no taker cannot become MANUAL without one.
    await expect(
      withTenant(app, a.tenantId, (tx) =>
        tx.attendanceSession.update({ where: { id: device.id }, data: { source: 'MANUAL' } }),
      ),
    ).rejects.toThrow(/attendance_sessions_taker/);
  });

  it('registers and records default to MANUAL', async () => {
    const session = await withTenant(app, a.tenantId, (tx) =>
      tx.attendanceSession.findUniqueOrThrow({
        where: { id: a.sessionId },
        include: { records: true },
      }),
    );
    expect(session.source).toBe('MANUAL');
    expect(session.records.map((r) => r.source)).toEqual(['MANUAL']);
  });

  it('entry and exit SMS purposes exist', async () => {
    const result = await withTenant(app, a.tenantId, (tx) =>
      tx.smsLog.createMany({
        data: (['ATTENDANCE_ENTRY', 'ATTENDANCE_EXIT'] as const).map((purpose) => ({
          tenantId: a.tenantId,
          phone: randomPhone(),
          purpose,
          segments: 1,
          body: 'x',
          localDate: new Date('2026-10-18'),
        })),
      }),
    );
    expect(result.count).toBe(2);
  });
});

describe('platform_sms_logs: insert-only for the app role', () => {
  let app: PrismaClient;

  beforeAll(() => {
    app = appClient();
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  const row = () => ({
    phone: randomPhone(),
    purpose: 'OTP' as const,
    status: 'SENT' as const,
    segments: 1,
  });

  it('can insert (plain INSERT, no RETURNING)', async () => {
    await expect(app.platformSmsLog.createMany({ data: [row()] })).resolves.toEqual({ count: 1 });
  });

  it('cannot read, update or delete', async () => {
    await expect(app.$queryRaw`SELECT * FROM platform_sms_logs`).rejects.toThrow(
      /permission denied/i,
    );
    await expect(app.platformSmsLog.count()).rejects.toThrow(/permission denied/i);
    await expect(app.$executeRaw`UPDATE platform_sms_logs SET status = 'FAILED'`).rejects.toThrow(
      /permission denied/i,
    );
    await expect(app.$executeRaw`DELETE FROM platform_sms_logs`).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('create() (INSERT … RETURNING) is refused, so nobody accidentally reads rows back', async () => {
    await expect(app.platformSmsLog.create({ data: row() })).rejects.toThrow(/permission denied/i);
  });

  it('rejects malformed phone numbers', async () => {
    await expect(
      app.platformSmsLog.createMany({ data: [{ ...row(), phone: '01711000000' }] }),
    ).rejects.toThrow(/platform_sms_logs_phone_bd_format/);
  });
});
