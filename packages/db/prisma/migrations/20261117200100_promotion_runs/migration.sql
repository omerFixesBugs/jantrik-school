-- Sprint 1 P5: promotion runs (one per from-year, to-year and from-class) and their rows (one per
-- student). docs/promotion.md, docs/database.md → Promotion.

-- CreateEnum
CREATE TYPE "promotion_roll_strategy" AS ENUM ('MERIT', 'NAME_BN', 'NAME_EN', 'MANUAL', 'KEEP');

-- CreateEnum
CREATE TYPE "promotion_run_status" AS ENUM ('DRAFT', 'APPLYING', 'APPLIED');

-- CreateEnum
CREATE TYPE "promotion_decision" AS ENUM ('PROMOTE', 'REPEAT', 'LEAVE');

-- CreateEnum
CREATE TYPE "promotion_apply_outcome" AS ENUM ('ENROLLED', 'ALREADY_ENROLLED', 'LEFT', 'SKIPPED_DEACTIVATED', 'SKIPPED_LEFT');


-- CreateTable
CREATE TABLE "promotion_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "from_year_id" UUID NOT NULL,
    "to_year_id" UUID NOT NULL,
    "class_level_id" UUID NOT NULL,
    "roll_strategy" "promotion_roll_strategy" NOT NULL,
    "merit_exam_id" UUID,
    "status" "promotion_run_status" NOT NULL DEFAULT 'DRAFT',
    "created_by_id" UUID NOT NULL,
    "applied_by_id" UUID,
    "apply_started_at" TIMESTAMPTZ(3),
    "applied_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_run_students" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "to_year_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "from_enrolment_id" UUID NOT NULL,
    "from_section_id" UUID,
    "from_roll" INTEGER,
    "result_passed" BOOLEAN,
    "merit_position" INTEGER,
    "decision" "promotion_decision" NOT NULL,
    "target_class_level_id" UUID,
    "target_section_id" UUID,
    "target_study_group_id" UUID,
    "leave_status" "student_status",
    "left_on" DATE,
    "leave_reason" TEXT,
    "applied_at" TIMESTAMPTZ(3),
    "apply_outcome" "promotion_apply_outcome",
    "to_enrolment_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_run_students_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "promotion_runs_tenant_id_to_year_id_idx" ON "promotion_runs"("tenant_id", "to_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_runs_tenant_id_id_key" ON "promotion_runs"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_runs_tenant_id_id_to_year_id_key" ON "promotion_runs"("tenant_id", "id", "to_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_runs_tenant_id_from_year_id_to_year_id_class_leve_key" ON "promotion_runs"("tenant_id", "from_year_id", "to_year_id", "class_level_id");

-- CreateIndex
CREATE INDEX "promotion_run_students_tenant_id_run_id_target_section_id_idx" ON "promotion_run_students"("tenant_id", "run_id", "target_section_id");

-- CreateIndex
CREATE INDEX "promotion_run_students_tenant_id_to_year_id_target_class_le_idx" ON "promotion_run_students"("tenant_id", "to_year_id", "target_class_level_id");

-- CreateIndex
CREATE INDEX "promotion_run_students_tenant_id_student_id_idx" ON "promotion_run_students"("tenant_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_run_students_tenant_id_id_key" ON "promotion_run_students"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_run_students_tenant_id_run_id_student_id_key" ON "promotion_run_students"("tenant_id", "run_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_run_students_tenant_id_to_year_id_student_id_key" ON "promotion_run_students"("tenant_id", "to_year_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "exams_tenant_id_id_academic_year_id_key" ON "exams"("tenant_id", "id", "academic_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "sections_tenant_id_id_academic_year_id_class_level_id_key" ON "sections"("tenant_id", "id", "academic_year_id", "class_level_id");

-- AddForeignKey
ALTER TABLE "promotion_runs" ADD CONSTRAINT "promotion_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_runs" ADD CONSTRAINT "promotion_runs_tenant_id_from_year_id_fkey" FOREIGN KEY ("tenant_id", "from_year_id") REFERENCES "academic_years"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_runs" ADD CONSTRAINT "promotion_runs_tenant_id_to_year_id_fkey" FOREIGN KEY ("tenant_id", "to_year_id") REFERENCES "academic_years"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_runs" ADD CONSTRAINT "promotion_runs_tenant_id_class_level_id_fkey" FOREIGN KEY ("tenant_id", "class_level_id") REFERENCES "class_levels"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_runs" ADD CONSTRAINT "promotion_runs_tenant_id_merit_exam_id_from_year_id_fkey" FOREIGN KEY ("tenant_id", "merit_exam_id", "from_year_id") REFERENCES "exams"("tenant_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_runs" ADD CONSTRAINT "promotion_runs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_runs" ADD CONSTRAINT "promotion_runs_applied_by_id_fkey" FOREIGN KEY ("applied_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_run_students" ADD CONSTRAINT "promotion_run_students_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_run_students" ADD CONSTRAINT "promotion_run_students_tenant_id_run_id_to_year_id_fkey" FOREIGN KEY ("tenant_id", "run_id", "to_year_id") REFERENCES "promotion_runs"("tenant_id", "id", "to_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_run_students" ADD CONSTRAINT "promotion_run_students_tenant_id_student_id_fkey" FOREIGN KEY ("tenant_id", "student_id") REFERENCES "students"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_run_students" ADD CONSTRAINT "promotion_run_students_tenant_id_from_enrolment_id_fkey" FOREIGN KEY ("tenant_id", "from_enrolment_id") REFERENCES "enrolments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_run_students" ADD CONSTRAINT "promotion_run_students_tenant_id_from_section_id_fkey" FOREIGN KEY ("tenant_id", "from_section_id") REFERENCES "sections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_run_students" ADD CONSTRAINT "promotion_run_students_tenant_id_target_class_level_id_fkey" FOREIGN KEY ("tenant_id", "target_class_level_id") REFERENCES "class_levels"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_run_students" ADD CONSTRAINT "promotion_run_students_tenant_id_target_section_id_to_year_fkey" FOREIGN KEY ("tenant_id", "target_section_id", "to_year_id", "target_class_level_id") REFERENCES "sections"("tenant_id", "id", "academic_year_id", "class_level_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_run_students" ADD CONSTRAINT "promotion_run_students_tenant_id_target_study_group_id_fkey" FOREIGN KEY ("tenant_id", "target_study_group_id") REFERENCES "study_groups"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promotion_run_students" ADD CONSTRAINT "promotion_run_students_tenant_id_to_enrolment_id_fkey" FOREIGN KEY ("tenant_id", "to_enrolment_id") REFERENCES "enrolments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ───────────────────────── Row-Level Security ─────────────────────────
-- The context function is wrapped in a sub-select so it runs once per statement, not per row.
ALTER TABLE promotion_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotion_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON promotion_runs
  USING (tenant_id = (SELECT app_current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant_id()));

ALTER TABLE promotion_run_students ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotion_run_students FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON promotion_run_students
  USING (tenant_id = (SELECT app_current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant_id()));

-- An applied row never changes again and is never deleted: restrictive policies, so they hold
-- together with tenant_isolation. The UPDATE one has its own WITH CHECK (true): without it the
-- USING expression would also check the new row, and apply could not set applied_at.
CREATE POLICY promotion_rows_delete_pending ON promotion_run_students
  AS RESTRICTIVE FOR DELETE
  USING (applied_at IS NULL);
CREATE POLICY promotion_rows_update_pending ON promotion_run_students
  AS RESTRICTIVE FOR UPDATE
  USING (applied_at IS NULL)
  WITH CHECK (true);

-- ───────────────────────── Grants ─────────────────────────
-- A run is history: no DELETE; its from-year, to-year, class and creator never change.
GRANT SELECT, INSERT ON promotion_runs TO jantrik_app;
GRANT UPDATE (roll_strategy, merit_exam_id, status, applied_by_id, apply_started_at, applied_at,
  last_error, updated_at) ON promotion_runs TO jantrik_app;
-- Rows: the student, run and from-snapshot never change (the merit exam's figures may be taken
-- again while pending); DELETE only while pending (policy above).
GRANT SELECT, INSERT, DELETE ON promotion_run_students TO jantrik_app;
GRANT UPDATE (result_passed, merit_position, decision, target_class_level_id, target_section_id,
  target_study_group_id, leave_status, left_on, leave_reason, applied_at, apply_outcome,
  to_enrolment_id, updated_at) ON promotion_run_students TO jantrik_app;

-- ───────────────────────── CHECKs ─────────────────────────
-- Nullable columns are tested with IS [NOT] NULL first (a NULL CHECK passes).
ALTER TABLE promotion_runs
  ADD CONSTRAINT promotion_runs_years_differ CHECK (from_year_id <> to_year_id),
  ADD CONSTRAINT promotion_runs_merit_needs_exam CHECK (
    roll_strategy <> 'MERIT' OR merit_exam_id IS NOT NULL
  ),
  ADD CONSTRAINT promotion_runs_applied_at CHECK ((status = 'APPLIED') = (applied_at IS NOT NULL)),
  ADD CONSTRAINT promotion_runs_apply_started CHECK (
    status = 'DRAFT' OR (apply_started_at IS NOT NULL AND applied_by_id IS NOT NULL)
  ),
  ADD CONSTRAINT promotion_runs_last_error_code CHECK (
    last_error IS NULL OR last_error ~ '^[A-Z_]{1,40}$'
  );

ALTER TABLE promotion_run_students
  ADD CONSTRAINT promotion_rows_leave CHECK (
    decision <> 'LEAVE' OR (
      leave_status IS NOT NULL AND left_on IS NOT NULL
      AND target_class_level_id IS NULL AND target_section_id IS NULL
      AND target_study_group_id IS NULL
    )
  ),
  ADD CONSTRAINT promotion_rows_stay CHECK (
    decision = 'LEAVE' OR (
      target_class_level_id IS NOT NULL
      AND leave_status IS NULL AND left_on IS NULL AND leave_reason IS NULL
    )
  ),
  ADD CONSTRAINT promotion_rows_leave_status CHECK (
    leave_status IS NULL
    OR leave_status IN ('GRADUATED', 'TRANSFERRED', 'DROPPED_OUT', 'INACTIVE')
  ),
  ADD CONSTRAINT promotion_rows_outcome_when_applied CHECK (
    (applied_at IS NULL) = (apply_outcome IS NULL)
  ),
  ADD CONSTRAINT promotion_rows_enrolment_outcome CHECK (
    apply_outcome IS NULL
    OR apply_outcome NOT IN ('ENROLLED', 'ALREADY_ENROLLED')
    OR to_enrolment_id IS NOT NULL
  ),
  ADD CONSTRAINT promotion_rows_enrolment_only_when_enrolled CHECK (
    to_enrolment_id IS NULL
    OR (apply_outcome IS NOT NULL AND apply_outcome IN ('ENROLLED', 'ALREADY_ENROLLED'))
  ),
  ADD CONSTRAINT promotion_rows_leave_reason_length CHECK (
    leave_reason IS NULL OR char_length(leave_reason) <= 500
  ),
  ADD CONSTRAINT promotion_rows_merit_position CHECK (merit_position IS NULL OR merit_position >= 1);
