-- Sprint 1 P3a, after its review (docs/decisions-pending.md → "Sprint 1, P3", P3-a12 to P3-a17).

-- M1 (money): the admission date a student's dues count from, recorded only when a child is
-- admitted (by staff or from an application) into a year that has not started and is not
-- current yet: that year's start (decision P3-K). NULL for everyone else, including every
-- existing student, so their dues stay exactly as they were.
ALTER TABLE "students" ADD COLUMN "admission_date_for_dues" DATE;

-- S3: one application per birth registration number per cycle, not withdrawn (the duplicate
-- rule), also when two phones submit the same child at the same moment.
DROP INDEX IF EXISTS "admission_applications_birth_reg_idx";
CREATE UNIQUE INDEX "admission_applications_birth_reg_live"
  ON "admission_applications"("tenant_id", "cycle_id", "birth_registration_no")
  WHERE (birth_registration_no IS NOT NULL AND status <> 'WITHDRAWN');

-- N2: updates by column only (the creator and the institute never change).
REVOKE UPDATE ON admission_cycle_classes FROM jantrik_app;
GRANT UPDATE (seats, is_open, updated_at) ON admission_cycle_classes TO jantrik_app;
REVOKE UPDATE ON admission_cycles FROM jantrik_app;
GRANT UPDATE (academic_year_id, name_bn, name_en, status, opens_at, closes_at, public_note_bn,
              public_note_en, requires_test, collect_photo, fields, updated_at)
  ON admission_cycles TO jantrik_app;
