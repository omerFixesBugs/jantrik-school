import { withTenant } from '@jantrik/db';
import {
  addDays,
  dateToDb,
  type FeeHeadView,
  type FeeLedger,
  type StudentProfile,
} from '@jantrik/shared';
import { feesSchool, type FeesSchool } from './support/fees.js';
import { bearer, createHarness, http, randomPhone, type Harness } from './support/harness.js';

/**
 * Sprint 1 P3, review focus 5 (money): a child admitted before their first year starts (in
 * December, for January) owes from the year's start; a promoted student is never charged a
 * one-time fee again. The fees school's year started three months before this month, so "the
 * December admission" is a student created 20 days before that start, enrolled in this year only.
 */
describe('fees: the admission date of a student admitted before the year starts', () => {
  let h: Harness;
  let s: FeesSchool;
  let admission: FeeHeadView;

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
  const createdOn = (studentId: string, day: string) =>
    withTenant(h.prisma, s.tenantId, (tx) =>
      tx.student.update({ where: { id: studentId }, data: { createdAt: dateToDb(day) } }),
    );

  beforeAll(async () => {
    h = await createHarness();
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
  });

  afterAll(() => h.close());

  it('admitted in "December": the admission fee is due 15 days after the year starts, the first month on its usual day', async () => {
    const student = await admit('December Admit');
    await createdOn(student.id, addDays(s.yearStart, -20));
    const dues = (await ledger(student.id)).dues;
    const once = dues.find((d) => d.head.id === admission.id);
    expect(once).toMatchObject({ amountPaisa: 500000, dueDate: addDays(s.yearStart, 15) });
    const first = dues.find((d) => d.periodKey === s.yearStart.slice(0, 7));
    // Not extended as for a late joiner (the child was a member from the first day).
    expect(first).toMatchObject({ dueDate: `${s.yearStart.slice(0, 7)}-10` });
  });

  it('a promoted student (enrolled in the year before) is not charged the admission fee again', async () => {
    const student = await admit('Promoted Student');
    await createdOn(student.id, addDays(s.yearStart, -300));
    await withTenant(h.prisma, s.tenantId, async (tx) => {
      const previous = await tx.academicYear.create({
        data: {
          tenantId: s.tenantId,
          name: 'previous',
          startDate: dateToDb(addDays(s.yearStart, -365)),
          endDate: dateToDb(addDays(s.yearStart, -1)),
        },
      });
      await tx.enrolment.create({
        data: {
          tenantId: s.tenantId,
          studentId: student.id,
          academicYearId: previous.id,
          classLevelId: s.class6,
        },
      });
    });
    const dues = (await ledger(student.id)).dues;
    expect(dues.some((d) => d.head.id === admission.id)).toBe(false);
    expect(dues.length).toBeGreaterThan(0);
  });

  it('admitted mid-year: unchanged, the fee is due 15 days after the admission day', async () => {
    const student = await admit('Mid Year Admit');
    const day = addDays(s.yearStart, 40);
    await createdOn(student.id, day);
    const once = (await ledger(student.id)).dues.find((d) => d.head.id === admission.id);
    expect(once).toMatchObject({ dueDate: addDays(day, 15) });
  });
});
