
-- CreateTable
CREATE TABLE "exam_results" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "exam_id" UUID NOT NULL,
    "exam_class_id" UUID NOT NULL,
    "class_level_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "roll" INTEGER,
    "total_h" INTEGER NOT NULL,
    "full_marks" INTEGER NOT NULL,
    "percent_h" INTEGER NOT NULL,
    "gpa_h" INTEGER,
    "gpa_wo_optional_h" INTEGER,
    "letter" TEXT,
    "passed" BOOLEAN NOT NULL,
    "failed_subjects" INTEGER NOT NULL,
    "class_position" INTEGER,
    "section_position" INTEGER,
    "attendance_present" INTEGER,
    "attendance_total" INTEGER,
    "attendance_percent_h" INTEGER,
    "remarks" TEXT,
    "subjects" JSONB NOT NULL,
    "published_version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exam_results_tenant_id_student_id_idx" ON "exam_results"("tenant_id", "student_id");

-- CreateIndex
CREATE INDEX "exam_results_tenant_id_exam_id_idx" ON "exam_results"("tenant_id", "exam_id");

-- CreateIndex
CREATE INDEX "exam_results_tenant_id_section_id_idx" ON "exam_results"("tenant_id", "section_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_results_tenant_id_id_key" ON "exam_results"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_results_tenant_id_exam_class_id_student_id_key" ON "exam_results"("tenant_id", "exam_class_id", "student_id");

-- AddForeignKey
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_tenant_id_exam_class_id_exam_id_class_level_i_fkey" FOREIGN KEY ("tenant_id", "exam_class_id", "exam_id", "class_level_id") REFERENCES "exam_classes"("tenant_id", "id", "exam_id", "class_level_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_tenant_id_exam_id_student_id_fkey" FOREIGN KEY ("tenant_id", "exam_id", "student_id") REFERENCES "exam_candidates"("tenant_id", "exam_id", "student_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "exam_results" ADD CONSTRAINT "exam_results_tenant_id_section_id_class_level_id_fkey" FOREIGN KEY ("tenant_id", "section_id", "class_level_id") REFERENCES "sections"("tenant_id", "id", "class_level_id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ───── Step 10, phase D: published results (hand-written: RLS, grants, CHECKs) ─────

ALTER TABLE exam_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_results FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON exam_results
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- A snapshot rebuilt on every publish (each publish is audited); removed rows are students no
-- longer on the roster.
GRANT SELECT, INSERT, UPDATE, DELETE ON exam_results TO jantrik_app;

ALTER TABLE exam_results
  ADD CONSTRAINT exam_results_marks CHECK (
    total_h >= 0 AND full_marks >= 0 AND percent_h BETWEEN 0 AND 10000 AND failed_subjects >= 0
  ),
  ADD CONSTRAINT exam_results_gpa CHECK (
    (gpa_h IS NULL OR gpa_h >= 0) AND (gpa_wo_optional_h IS NULL OR gpa_wo_optional_h >= 0)
  ),
  ADD CONSTRAINT exam_results_positions CHECK (
    (class_position IS NULL OR class_position >= 1)
    AND (section_position IS NULL OR section_position >= 1)
  ),
  ADD CONSTRAINT exam_results_version CHECK (published_version >= 1),
  ADD CONSTRAINT exam_results_attendance CHECK (
    (attendance_present IS NULL AND attendance_total IS NULL AND attendance_percent_h IS NULL)
    OR (
      attendance_present IS NOT NULL AND attendance_total IS NOT NULL
      AND attendance_present BETWEEN 0 AND attendance_total
      AND (attendance_percent_h IS NULL OR attendance_percent_h BETWEEN 0 AND 10000)
    )
  ),
  ADD CONSTRAINT exam_results_remarks CHECK (remarks IS NULL OR length(remarks) <= 300);
