-- CreateEnum
CREATE TYPE "exam_kind" AS ENUM ('HALF_YEARLY', 'ANNUAL', 'PRE_TEST', 'TEST', 'CLASS_TEST', 'MODEL_TEST', 'OTHER');

-- CreateEnum
CREATE TYPE "exam_result_mode" AS ENUM ('GPA', 'MARKS');

-- CreateEnum
CREATE TYPE "exam_status" AS ENUM ('SETUP', 'OPEN', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "merit_failed_ranking" AS ENUM ('AFTER_PASSED', 'UNRANKED');

-- CreateEnum
CREATE TYPE "exam_candidate_status" AS ENUM ('ENROLLED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "exams" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "kind" "exam_kind" NOT NULL,
    "name_bn" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "result_mode" "exam_result_mode" NOT NULL,
    "merit_order" TEXT[],
    "failed_ranking" "merit_failed_ranking" NOT NULL,
    "attendance_from" DATE,
    "attendance_to" DATE,
    "status" "exam_status" NOT NULL DEFAULT 'SETUP',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_classes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "exam_id" UUID NOT NULL,
    "class_level_id" UUID NOT NULL,
    "is_published" BOOLEAN NOT NULL DEFAULT false,
    "published_version" INTEGER NOT NULL DEFAULT 0,
    "published_at" TIMESTAMPTZ(3),
    "published_by_id" UUID,
    "unpublished_reason" TEXT,
    "grading_snapshot" JSONB,
    "subject_stats" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_classes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_subjects" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "exam_id" UUID NOT NULL,
    "exam_class_id" UUID NOT NULL,
    "class_level_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "study_group_id" UUID,
    "is_elective" BOOLEAN NOT NULL,
    "pass_rule" "pass_rule" NOT NULL,
    "exam_date" DATE,
    "start_time" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_subject_components" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "exam_subject_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "kind" "component_kind" NOT NULL,
    "name_bn" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "full_marks" INTEGER NOT NULL,
    "pass_marks" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_subject_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_subject_pass_groups" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "exam_subject_id" UUID NOT NULL,
    "kind" "component_kind" NOT NULL,
    "pass_marks" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_subject_pass_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_candidates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "exam_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "class_level_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "study_group_id" UUID,
    "roll" INTEGER,
    "status" "exam_candidate_status" NOT NULL DEFAULT 'ENROLLED',
    "room_id" UUID,
    "seat_no" INTEGER,
    "remarks" TEXT,
    "remarks_by_id" UUID,
    "remarks_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exams_tenant_id_academic_year_id_starts_on_idx" ON "exams"("tenant_id", "academic_year_id", "starts_on");

-- CreateIndex
CREATE UNIQUE INDEX "exams_tenant_id_id_key" ON "exams"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_classes_tenant_id_id_key" ON "exam_classes"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_classes_tenant_id_exam_id_class_level_id_key" ON "exam_classes"("tenant_id", "exam_id", "class_level_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_classes_tenant_id_id_exam_id_class_level_id_key" ON "exam_classes"("tenant_id", "id", "exam_id", "class_level_id");

-- CreateIndex
CREATE INDEX "exam_subjects_tenant_id_exam_id_idx" ON "exam_subjects"("tenant_id", "exam_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_subjects_tenant_id_id_key" ON "exam_subjects"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_subjects_tenant_id_exam_class_id_subject_id_key" ON "exam_subjects"("tenant_id", "exam_class_id", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_subjects_tenant_id_id_exam_id_key" ON "exam_subjects"("tenant_id", "id", "exam_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_subject_components_tenant_id_id_key" ON "exam_subject_components"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_subject_components_tenant_id_exam_subject_id_key_key" ON "exam_subject_components"("tenant_id", "exam_subject_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "exam_subject_components_tenant_id_id_exam_subject_id_key" ON "exam_subject_components"("tenant_id", "id", "exam_subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_subject_pass_groups_tenant_id_id_key" ON "exam_subject_pass_groups"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_subject_pass_groups_tenant_id_exam_subject_id_kind_key" ON "exam_subject_pass_groups"("tenant_id", "exam_subject_id", "kind");

-- CreateIndex
CREATE INDEX "exam_candidates_tenant_id_exam_id_section_id_idx" ON "exam_candidates"("tenant_id", "exam_id", "section_id");

-- CreateIndex
CREATE INDEX "exam_candidates_tenant_id_student_id_idx" ON "exam_candidates"("tenant_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_candidates_tenant_id_id_key" ON "exam_candidates"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_candidates_tenant_id_exam_id_student_id_key" ON "exam_candidates"("tenant_id", "exam_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_candidates_tenant_id_exam_id_room_id_seat_no_key" ON "exam_candidates"("tenant_id", "exam_id", "room_id", "seat_no");

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_tenant_id_academic_year_id_fkey" FOREIGN KEY ("tenant_id", "academic_year_id") REFERENCES "academic_years"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "exam_classes" ADD CONSTRAINT "exam_classes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_classes" ADD CONSTRAINT "exam_classes_tenant_id_exam_id_fkey" FOREIGN KEY ("tenant_id", "exam_id") REFERENCES "exams"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "exam_classes" ADD CONSTRAINT "exam_classes_tenant_id_class_level_id_fkey" FOREIGN KEY ("tenant_id", "class_level_id") REFERENCES "class_levels"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "exam_classes" ADD CONSTRAINT "exam_classes_published_by_id_fkey" FOREIGN KEY ("published_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_subjects" ADD CONSTRAINT "exam_subjects_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_subjects" ADD CONSTRAINT "exam_subjects_tenant_id_exam_class_id_exam_id_class_level__fkey" FOREIGN KEY ("tenant_id", "exam_class_id", "exam_id", "class_level_id") REFERENCES "exam_classes"("tenant_id", "id", "exam_id", "class_level_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "exam_subjects" ADD CONSTRAINT "exam_subjects_tenant_id_subject_id_class_level_id_fkey" FOREIGN KEY ("tenant_id", "subject_id", "class_level_id") REFERENCES "subjects"("tenant_id", "id", "class_level_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "exam_subjects" ADD CONSTRAINT "exam_subjects_tenant_id_study_group_id_fkey" FOREIGN KEY ("tenant_id", "study_group_id") REFERENCES "study_groups"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "exam_subject_components" ADD CONSTRAINT "exam_subject_components_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_subject_components" ADD CONSTRAINT "exam_subject_components_tenant_id_exam_subject_id_fkey" FOREIGN KEY ("tenant_id", "exam_subject_id") REFERENCES "exam_subjects"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "exam_subject_pass_groups" ADD CONSTRAINT "exam_subject_pass_groups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_subject_pass_groups" ADD CONSTRAINT "exam_subject_pass_groups_tenant_id_exam_subject_id_fkey" FOREIGN KEY ("tenant_id", "exam_subject_id") REFERENCES "exam_subjects"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "exam_candidates" ADD CONSTRAINT "exam_candidates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_candidates" ADD CONSTRAINT "exam_candidates_tenant_id_exam_id_fkey" FOREIGN KEY ("tenant_id", "exam_id") REFERENCES "exams"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "exam_candidates" ADD CONSTRAINT "exam_candidates_tenant_id_exam_id_class_level_id_fkey" FOREIGN KEY ("tenant_id", "exam_id", "class_level_id") REFERENCES "exam_classes"("tenant_id", "exam_id", "class_level_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "exam_candidates" ADD CONSTRAINT "exam_candidates_tenant_id_student_id_fkey" FOREIGN KEY ("tenant_id", "student_id") REFERENCES "students"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "exam_candidates" ADD CONSTRAINT "exam_candidates_tenant_id_section_id_class_level_id_fkey" FOREIGN KEY ("tenant_id", "section_id", "class_level_id") REFERENCES "sections"("tenant_id", "id", "class_level_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "exam_candidates" ADD CONSTRAINT "exam_candidates_tenant_id_study_group_id_fkey" FOREIGN KEY ("tenant_id", "study_group_id") REFERENCES "study_groups"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "exam_candidates" ADD CONSTRAINT "exam_candidates_tenant_id_room_id_fkey" FOREIGN KEY ("tenant_id", "room_id") REFERENCES "exam_rooms"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "exam_candidates" ADD CONSTRAINT "exam_candidates_remarks_by_id_fkey" FOREIGN KEY ("remarks_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ───── Step 10, phase B: exam structure (hand-written: RLS, grants, CHECKs) ─────

ALTER TABLE exams ENABLE ROW LEVEL SECURITY;
ALTER TABLE exams FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON exams
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE exam_classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_classes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON exam_classes
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE exam_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_subjects FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON exam_subjects
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE exam_subject_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_subject_components FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON exam_subject_components
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE exam_subject_pass_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_subject_pass_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON exam_subject_pass_groups
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE exam_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON exam_candidates
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Exam setup rows: edited (and, for an exam still in SETUP, removed) by the app; audited.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  exams, exam_classes, exam_subjects, exam_subject_components, exam_subject_pass_groups
TO jantrik_app;
-- Candidates are history: never deleted (a leaver is WITHDRAWN, with their marks kept).
GRANT SELECT, INSERT, UPDATE ON exam_candidates TO jantrik_app;

ALTER TABLE exams
  ADD CONSTRAINT exams_dates CHECK (starts_on <= ends_on),
  ADD CONSTRAINT exams_attendance_window CHECK (
    (attendance_from IS NULL AND attendance_to IS NULL)
    OR (attendance_from IS NOT NULL AND attendance_to IS NOT NULL AND attendance_from <= attendance_to)
  ),
  ADD CONSTRAINT exams_merit_order CHECK (
    cardinality(merit_order) BETWEEN 1 AND 8 AND array_position(merit_order, NULL) IS NULL
  ),
  ADD CONSTRAINT exams_names CHECK (
    length(btrim(name_bn)) BETWEEN 1 AND 120 AND length(btrim(name_en)) BETWEEN 1 AND 120
  );

ALTER TABLE exam_classes
  ADD CONSTRAINT exam_classes_published CHECK (
    published_version >= 0
    AND (NOT is_published OR (published_at IS NOT NULL AND published_version >= 1))
  ),
  ADD CONSTRAINT exam_classes_unpublished_reason CHECK (
    unpublished_reason IS NULL OR length(btrim(unpublished_reason)) BETWEEN 3 AND 500
  );

ALTER TABLE exam_subjects
  ADD CONSTRAINT exam_subjects_start_time CHECK (
    start_time IS NULL OR start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  );

ALTER TABLE exam_subject_components
  ADD CONSTRAINT exam_subject_components_key_format CHECK (key ~ '^[A-Z][A-Z0-9_]{0,19}$'),
  ADD CONSTRAINT exam_subject_components_marks CHECK (
    full_marks BETWEEN 1 AND 1000
    AND (pass_marks IS NULL OR (pass_marks >= 0 AND pass_marks <= full_marks))
  ),
  ADD CONSTRAINT exam_subject_components_names CHECK (
    length(btrim(name_bn)) BETWEEN 1 AND 60 AND length(btrim(name_en)) BETWEEN 1 AND 60
  );
ALTER TABLE exam_subject_pass_groups
  ADD CONSTRAINT exam_subject_pass_groups_marks CHECK (pass_marks >= 0);

ALTER TABLE exam_candidates
  ADD CONSTRAINT exam_candidates_seat CHECK (
    (room_id IS NULL AND seat_no IS NULL) OR (room_id IS NOT NULL AND seat_no IS NOT NULL AND seat_no >= 1)
  ),
  ADD CONSTRAINT exam_candidates_roll CHECK (roll IS NULL OR roll > 0),
  ADD CONSTRAINT exam_candidates_remarks CHECK (remarks IS NULL OR length(remarks) <= 300);
