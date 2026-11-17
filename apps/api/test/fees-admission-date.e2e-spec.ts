import { withTenant } from '@jantrik/db';
import {
  addDays,
  dateToDb,
  type FeeHeadView,
  type FeeLedger,
  type StudentProfile,
} from '@jantrik/shared';
import { FakeClock } from './support/clock.js';
import { feesSchool, type FeesSchool } from './support/fees.js';
import { bearer, createHarness, http, randomPhone, type Harness } from './support/harness.js';

/**
 * Sprint 1 P3, review focus 5 (money), as fixed after the review (M1): a child admitted into a
 * year that has not started and is not current yet (in December, for January) owes from that
 * year's start; the date is recorded at admission (students.admission_date_for_dues). Every other
 * student keeps the creation day exactly as before: an import or an existing student created
 * before the year starts gets no one-time fee it did not get before.
 *
 * The fees school's year Y started three months before this month and is current. To admit "in
 * December" the test makes the year before Y current, moves the API's clock to 20 days before Y
 * starts, admits into Y, then makes Y current again.
 */
describe('fees: the admission date of a child admitted before the year starts', () => {
  const clock = new FakeClock();
  let h: Harness;
  let s: FeesSchool;
  let admission: FeeHeadView;
  let previousYearId: string;

  const api = (token: string) => ({
    get: (path: string) => http(h).get(path).set(bearer(token)),
    post: (path: string, body: object = {}) => http(h).post(path).set(bearer(token)).send(body),
    put: (path: string, body: object) => http(h).put(path).set(bearer(token)).send(body),
  });
  const ledger = async (studentId: string) =>
    (await api(s.tokens.accountant).get(`/fees/students/${studentId}/ledger`).expect(200))
      .body as FeeLedger;
  const admit = async (name: string) =>
    (
      await api(s.tokens.admin)
        .post('/students', {
          nameEn: name,
          gender: 'FEMALE',
          guardians: [
            { phone: randomPhone(), nameBn: 'রহিম', relation: 'FATHER', isPrimary: true },
          ],
          enrolment: {
            academicYearId: s.yearId,
            classLevelId: s.class6,
            sectionId: s.sectionId,
            roll: null,
          },
        })
        .expect(201)
    ).body as StudentProfile;
  const stored = (studentId: string) =>
    withTenant(h.prisma, s.tenantId, (tx) =>
      tx.student.findUniqueOrThrow({
        where: { id: studentId },
        select: { admissionDateForDues: true },
      }),
    );
  const currentYear = (yearId: string) =>
    withTenant(h.prisma, s.tenantId, async (tx) => {
      await tx.academicYear.updateMany({ data: { isCurrent: false } });
      await tx.academicYear.update({ where: { id: yearId }, data: { isCurrent: true } });
    });
  const createdOn = (studentId: string, day: string) =>
    withTenant(h.prisma, s.tenantId, (tx) =>
      tx.student.update({ where: { id: studentId }, data: { createdAt: dateToDb(day) } }),
    );

  beforeAll(async () => {
    h = await createHarness({ clock });
    s = await feesSchool(h);
    const admin = api(s.tokens.admin);
    // The owner sets the admission fee to apply from the new year (the case that charged a
    // December admission nothing at all before).
    admission = (
      await admin
        .post('/fees/heads', {
          nameBn: 'ভর্তি ফি',
          nameEn: 'Admission fee',
          kind: 'ADMISSION',
          frequency: 'ONE_TIME',
          dueOffsetDays: 15,
          oneTimeFrom: s.yearStart,
        })
        .expect(201)
    ).body as FeeHeadView;
    const tuition = (
      await admin
        .post('/fees/heads', {
          nameBn: 'মাসিক বেতন',
          nameEn: 'Monthly tuition',
          kind: 'TUITION',
          frequency: 'MONTHLY',
          dueDay: 10,
          fine: { type: 'PER_DAY', amountPaisa: 1000, capPaisa: 10000 },
        })
        .expect(201)
    ).body as FeeHeadView;
    await admin
      .put('/fees/amounts', {
        academicYearId: s.yearId,
        amounts: [
          { feeHeadId: admission.id, classLevelId: s.class6, amountPaisa: 500000 },
          { feeHeadId: tuition.id, classLevelId: s.class6, amountPaisa: 100000 },
        ],
      })
      .expect(200);
    await admin
      .put('/fees/settings', {
        duesFrom: s.yearStart,
        receiptSmsEnabled: false,
        sibling: null,
        receiptNote: null,
      })
      .expect(200);
    previousYearId = await withTenant(h.prisma, s.tenantId, async (tx) => {
      const y = await tx.academicYear.create({
        data: {
          tenantId: s.tenantId,
          name: 'previous',
          startDate: dateToDb(addDays(s.yearStart, -365)),
          endDate: dateToDb(addDays(s.yearStart, -1)),
        },
      });
      return y.id;
    });
  });

  afterAll(() => h.close());

  it('admitted 20 days before the year starts, into that year (not current yet): the date is recorded, the fee is due 15 days after the start, the first month on its usual day', async () => {
    await currentYear(previousYearId);
    clock.set(`${addDays(s.yearStart, -20)}T06:00:00.000Z`);
    let student: StudentProfile;
    try {
      student = await admit('December Admit');
    } finally {
      await currentYear(s.yearId);
      clock.set(new Date());
    }
    expect((await stored(student.id)).admissionDateForDues).toEqual(dateToDb(s.yearStart));
    const dues = (await ledger(student.id)).dues;
    const once = dues.find((d) => d.head.id === admission.id);
    expect(once).toMatchObject({ amountPaisa: 500000, dueDate: addDays(s.yearStart, 15) });
    const first = dues.find((d) => d.periodKey === s.yearStart.slice(0, 7));
    // Not extended as for a late joiner (the child was a member from the first day).
    expect(first).toMatchObject({ dueDate: `${s.yearStart.slice(0, 7)}-10` });
  });

  it("the review's case: a student created before the year starts with nothing recorded (an import, or an institute's first year, current from the day it was made) gets no back-dated fee", async () => {
    // Admitted into the CURRENT year before it starts (an institute's first year): not recorded.
    clock.set(`${addDays(s.yearStart, -20)}T06:00:00.000Z`);
    let student: StudentProfile;
    try {
      student = await admit('First Year Before Start');
    } finally {
      clock.set(new Date());
    }
    expect((await stored(student.id)).admissionDateForDues).toBeNull();
    // As an import: created before the year's start, enrolled in this year only.
    await createdOn(student.id, addDays(s.yearStart, -16));
    const dues = (await ledger(student.id)).dues;
    // The fee "from the year's start" does not reach a student created before it: as before.
    expect(dues.some((d) => d.head.id === admission.id)).toBe(false);
    expect(dues.length).toBeGreaterThan(0);
  });

  it('admitted mid-year: unchanged, the fee is due 15 days after the admission day', async () => {
    const student = await admit('Mid Year Admit');
    expect((await stored(student.id)).admissionDateForDues).toBeNull();
    const day = addDays(s.yearStart, 40);
    await createdOn(student.id, day);
    const once = (await ledger(student.id)).dues.find((d) => d.head.id === admission.id);
    expect(once).toMatchObject({ dueDate: addDays(day, 15) });
  });
});
