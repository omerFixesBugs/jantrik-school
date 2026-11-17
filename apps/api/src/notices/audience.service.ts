import { Injectable } from '@nestjs/common';
import type { Prisma } from '@jantrik/db';
import type { BroadcastRecipients, NoticeTargetRef } from '@jantrik/shared';
import { Db } from '../tenancy/db.service.js';
import { STAFF_ROLES } from './notices.service.js';

export interface Audience {
  /** Phones to send to, deduplicated (one SMS per phone). */
  phones: string[];
  /** Students (guardian recipients) or staff with no usable phone. */
  withoutPhone: number;
  /** Phone occurrences merged away (two siblings sharing a phone → 1). */
  mergedPhones: number;
}

const NO_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Who a broadcast reaches, resolved at the moment it is asked (preview) or sent (S19):
 * - PRIMARY_GUARDIANS: the primary guardian's phone of each targeted ACTIVE, not deleted student
 *   enrolled in the current year;
 * - ALL_GUARDIANS: every linked guardian's phone of those students;
 * - STAFF: the login phone of every ACTIVE staff member, once per person (P6-H).
 * Runs in the institute's RLS context (the request's or the job's).
 */
@Injectable()
export class AudienceService {
  constructor(private readonly db: Db) {}

  async resolve(recipients: BroadcastRecipients, targets: NoticeTargetRef[]): Promise<Audience> {
    return recipients === 'STAFF' ? this.staff() : this.guardians(recipients, targets);
  }

  private async staff(): Promise<Audience> {
    const members = await this.db.tx.membership.findMany({
      where: { status: 'ACTIVE', role: { in: [...STAFF_ROLES] } },
      select: { userId: true, user: { select: { phone: true } } },
      distinct: ['userId'],
    });
    return countPhones(members.map((m) => (m.user.phone ? [m.user.phone] : [])));
  }

  private async guardians(
    recipients: Exclude<BroadcastRecipients, 'STAFF'>,
    targets: NoticeTargetRef[],
  ): Promise<Audience> {
    const tx = this.db.tx;
    const year = await tx.academicYear.findFirst({
      where: { isCurrent: true },
      select: { id: true },
    });
    const enrolment: Prisma.EnrolmentWhereInput = {
      academicYearId: year?.id ?? NO_ID,
      ...(targets.length
        ? {
            OR: targets.map((t) => ({
              classLevelId: t.classLevelId,
              ...(t.sectionId ? { sectionId: t.sectionId } : {}),
            })),
          }
        : {}),
    };
    const students = await tx.student.findMany({
      where: { deletedAt: null, status: 'ACTIVE', enrolments: { some: enrolment } },
      select: {
        guardians: {
          where: recipients === 'PRIMARY_GUARDIANS' ? { isPrimary: true } : {},
          select: { guardian: { select: { phone: true } } },
        },
      },
    });
    return countPhones(
      students.map((s) => [
        ...new Set(s.guardians.flatMap((g) => (g.guardian.phone ? [g.guardian.phone] : []))),
      ]),
    );
  }
}

/** One list of phones per student (or staff member): an empty list counts as "without phone". */
function countPhones(perPerson: string[][]): Audience {
  const all = perPerson.flat();
  const phones = [...new Set(all)];
  return {
    phones,
    withoutPhone: perPerson.filter((p) => p.length === 0).length,
    mergedPhones: all.length - phones.length,
  };
}
