-- Sprint 1 P5, after the review of PR #21.
-- 1. A promotion row's enrolments must be its own student's, and its new enrolment in its to-year
--    (two unique indexes on enrolments, supersets of the primary key, are the targets).
-- 2. A run none of whose rows is applied may be deleted (with its pending rows), so a draft made
--    by mistake no longer keeps its year, class and merit exam from being deleted.

-- DropForeignKey
ALTER TABLE "promotion_run_students" DROP CONSTRAINT "promotion_run_students_tenant_id_from_enrolment_id_fkey";

-- DropForeignKey
ALTER TABLE "promotion_run_students" DROP CONSTRAINT "promotion_run_students_tenant_id_to_enrolment_id_fkey";

-- CreateIndex
CREATE UNIQUE INDEX "enrolments_tenant_id_id_student_id_key" ON "enrolments"("tenant_id", "id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "enrolments_tenant_id_id_student_id_academic_year_id_key" ON "enrolments"("tenant_id", "id", "student_id", "academic_year_id");

-- AddForeignKey
ALTER TABLE "promotion_run_students" ADD CONSTRAINT "promotion_run_students_tenant_id_from_enrolment_id_student_fkey" FOREIGN KEY ("tenant_id", "from_enrolment_id", "student_id") REFERENCES "enrolments"("tenant_id", "id", "student_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_run_students" ADD CONSTRAINT "promotion_run_students_tenant_id_to_enrolment_id_student_i_fkey" FOREIGN KEY ("tenant_id", "to_enrolment_id", "student_id", "to_year_id") REFERENCES "enrolments"("tenant_id", "id", "student_id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ───────────────────────── Deleting a run ─────────────────────────
GRANT DELETE ON promotion_runs TO jantrik_app;
-- Restrictive, so it holds together with tenant_isolation: never a run with an applied row.
CREATE POLICY promotion_runs_delete_unapplied ON promotion_runs
  AS RESTRICTIVE FOR DELETE
  USING (NOT EXISTS (
    SELECT 1 FROM promotion_run_students r
    WHERE r.tenant_id = promotion_runs.tenant_id
      AND r.run_id = promotion_runs.id
      AND r.applied_at IS NOT NULL
  ));
