import { randomUUID } from 'node:crypto';
import { addDays, dateToDb, isoWeekday, todayIn, type IsoDate } from '@jantrik/shared';
import type { AttendanceStatus } from '../generated/prisma/client.js';
import type { TenantTx } from '../tenancy/context.js';

/** Working days of demo history before the seed date (today itself is left to take live). */
export const PAST_ATTENDANCE_DAYS = 30;

/** Deterministic 0–1 from a string (FNV-1a), so every seed gives the same demo history. */
function unit(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x1_0000_0000;
}

/** Mostly present; a few students are absent more often than the rest (so reports show them). */
function demoStatus(studentCode: string, date: IsoDate): AttendanceStatus {
  const often = unit(`often:${studentCode}`) < 0.15;
  const r = unit(`${studentCode}:${date}`);
  const absent = often ? 0.22 : 0.05;
  if (r < absent) return 'ABSENT';
  if (r < absent + 0.04) return 'LATE';
  if (r < absent + 0.07) return 'LEAVE';
  return 'PRESENT';
}

/**
 * Demo attendance history: one register per section per working day (off days and holidays
 * skipped) for the calendar `PAST_ATTENDANCE_DAYS` before today, taken by the section's class
 * teacher. Absent SMS are never queued for it (only live submits for today send SMS).
 */
export async function seedPastAttendance(tx: TenantTx, tenantId: string): Promise<number> {
  const tenant = await tx.tenant.findFirstOrThrow({
    select: { timezone: true, attendanceSettings: { select: { mode: true, weeklyOffDays: true } } },
  });
  const settings = tenant.attendanceSettings;
  const offDays = settings?.weeklyOffDays ?? [5];
  const periodNo = settings?.mode === 'PER_SESSION' ? 1 : 0;
  const holidays = await tx.holiday.findMany({ select: { startDate: true, endDate: true } });
  const isHoliday = (d: IsoDate) =>
    holidays.some((h) => dateToDb(d) >= h.startDate && dateToDb(d) <= h.endDate);

  const today = todayIn(tenant.timezone);
  const dates: IsoDate[] = [];
  for (let d = addDays(today, -1); dates.length < PAST_ATTENDANCE_DAYS; d = addDays(d, -1)) {
    if (d < `${today.slice(0, 4)}-01-01`) break; // stay inside this academic year
    if (!offDays.includes(isoWeekday(d)) && !isHoliday(d)) dates.push(d);
  }

  const sections = await tx.section.findMany({
    select: {
      id: true,
      teachers: {
        orderBy: { isClassTeacher: 'desc' },
        take: 1,
        select: { userId: true },
      },
      enrolments: { select: { student: { select: { id: true, studentCode: true } } } },
    },
  });
  let sessions = 0;
  for (const section of sections) {
    const teacherId = section.teachers[0]?.userId;
    if (!teacherId || section.enrolments.length === 0) continue;
    for (const date of dates) {
      // Taken around 9:15 Dhaka time.
      const submittedAt = new Date(`${date}T03:15:00Z`);
      const session = await tx.attendanceSession.create({
        data: {
          tenantId,
          sectionId: section.id,
          date: dateToDb(date),
          periodNo,
          takenById: teacherId,
          updatedById: teacherId,
          submittedAt,
          lastSubmissionId: randomUUID(),
        },
        select: { id: true },
      });
      await tx.attendanceRecord.createMany({
        data: section.enrolments.map(({ student }) => ({
          tenantId,
          sessionId: session.id,
          studentId: student.id,
          status: demoStatus(student.studentCode, date),
        })),
      });
      sessions += 1;
    }
  }
  return sessions;
}
