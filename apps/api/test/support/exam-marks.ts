import { randomUUID } from 'node:crypto';
import type { ExamDetail, MarkSheetView } from '@jantrik/shared';
import { bearer, http, type Harness } from './harness.js';

/** What to type for one cell: (subject code, component key, student id, roll) → '56' / 'a'. */
export type MarkFn = (code: string, key: string, studentId: string, roll: number | null) => string;

/** As an admin, fill and submit every sheet of an exam's classes, then lock them all. */
export async function fillAndLock(
  h: Harness,
  token: string,
  exam: ExamDetail,
  sectionsByClass: Record<string, string[]>,
  value: MarkFn,
): Promise<void> {
  for (const ec of exam.classes) {
    for (const sectionId of sectionsByClass[ec.classLevel.id] ?? []) {
      for (const es of ec.subjects) {
        const view = (
          await http(h)
            .get('/exams/sheets')
            .query({ examSubjectId: es.id, sectionId })
            .set(bearer(token))
            .expect(200)
        ).body as MarkSheetView;
        if (view.students.length === 0) continue;
        await http(h)
          .put('/exams/sheets')
          .set(bearer(token))
          .send({
            examSubjectId: es.id,
            sectionId,
            submissionId: randomUUID(),
            baseVersion: view.sheet.version,
            action: 'SUBMIT',
            entries: view.students.flatMap((st) =>
              view.examSubject.components.map((c) => ({
                studentId: st.studentId,
                key: c.key,
                value: value(es.subject.code, c.key, st.studentId, st.roll),
              })),
            ),
          })
          .expect(200);
      }
    }
    await http(h)
      .post(`/exams/${exam.id}/classes/${ec.id}/lock-all`)
      .set(bearer(token))
      .expect(200);
  }
}
