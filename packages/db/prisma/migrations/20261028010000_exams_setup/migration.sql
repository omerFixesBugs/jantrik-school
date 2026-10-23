-- CreateEnum
CREATE TYPE "subject_choice_kind" AS ENUM ('COMPULSORY', 'OPTIONAL');

-- AlterTable
ALTER TABLE "subjects" ADD COLUMN     "pass_rule" "pass_rule" NOT NULL DEFAULT 'PER_COMPONENT';

-- CreateTable
CREATE TABLE "subject_components" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "kind" "component_kind" NOT NULL,
    "name_bn" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "full_marks" INTEGER NOT NULL,
    "pass_marks" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "source_template_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subject_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subject_pass_groups" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "kind" "component_kind" NOT NULL,
    "pass_marks" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subject_pass_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "section_subject_teachers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "class_level_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "section_subject_teachers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_subject_choices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "kind" "subject_choice_kind" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_subject_choices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_rooms" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "rows" INTEGER NOT NULL,
    "cols" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exam_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subject_components_tenant_id_id_key" ON "subject_components"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "subject_components_tenant_id_subject_id_key_key" ON "subject_components"("tenant_id", "subject_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "subject_pass_groups_tenant_id_id_key" ON "subject_pass_groups"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "subject_pass_groups_tenant_id_subject_id_kind_key" ON "subject_pass_groups"("tenant_id", "subject_id", "kind");

-- CreateIndex
CREATE INDEX "section_subject_teachers_tenant_id_user_id_idx" ON "section_subject_teachers"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "section_subject_teachers_tenant_id_id_key" ON "section_subject_teachers"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "section_subject_teachers_tenant_id_section_id_subject_id_us_key" ON "section_subject_teachers"("tenant_id", "section_id", "subject_id", "user_id");

-- CreateIndex
CREATE INDEX "student_subject_choices_tenant_id_subject_id_idx" ON "student_subject_choices"("tenant_id", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_subject_choices_tenant_id_id_key" ON "student_subject_choices"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "student_subject_choices_tenant_id_academic_year_id_student__key" ON "student_subject_choices"("tenant_id", "academic_year_id", "student_id", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_subject_choices_one_optional" ON "student_subject_choices"("tenant_id", "academic_year_id", "student_id") WHERE (kind = 'OPTIONAL'::subject_choice_kind);

-- CreateIndex
CREATE UNIQUE INDEX "exam_rooms_tenant_id_id_key" ON "exam_rooms"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "exam_rooms_tenant_id_name_key" ON "exam_rooms"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "sections_tenant_id_id_class_level_id_key" ON "sections"("tenant_id", "id", "class_level_id");

-- CreateIndex
CREATE UNIQUE INDEX "subjects_tenant_id_id_class_level_id_key" ON "subjects"("tenant_id", "id", "class_level_id");

-- AddForeignKey
ALTER TABLE "subject_components" ADD CONSTRAINT "subject_components_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_components" ADD CONSTRAINT "subject_components_tenant_id_subject_id_fkey" FOREIGN KEY ("tenant_id", "subject_id") REFERENCES "subjects"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_components" ADD CONSTRAINT "subject_components_source_template_id_fkey" FOREIGN KEY ("source_template_id") REFERENCES "template_subject_components"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_pass_groups" ADD CONSTRAINT "subject_pass_groups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_pass_groups" ADD CONSTRAINT "subject_pass_groups_tenant_id_subject_id_fkey" FOREIGN KEY ("tenant_id", "subject_id") REFERENCES "subjects"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_subject_teachers" ADD CONSTRAINT "section_subject_teachers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_subject_teachers" ADD CONSTRAINT "section_subject_teachers_tenant_id_section_id_class_level__fkey" FOREIGN KEY ("tenant_id", "section_id", "class_level_id") REFERENCES "sections"("tenant_id", "id", "class_level_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "section_subject_teachers" ADD CONSTRAINT "section_subject_teachers_tenant_id_subject_id_class_level__fkey" FOREIGN KEY ("tenant_id", "subject_id", "class_level_id") REFERENCES "subjects"("tenant_id", "id", "class_level_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "section_subject_teachers" ADD CONSTRAINT "section_subject_teachers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_subject_choices" ADD CONSTRAINT "student_subject_choices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_subject_choices" ADD CONSTRAINT "student_subject_choices_tenant_id_academic_year_id_student_fkey" FOREIGN KEY ("tenant_id", "academic_year_id", "student_id") REFERENCES "enrolments"("tenant_id", "academic_year_id", "student_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "student_subject_choices" ADD CONSTRAINT "student_subject_choices_tenant_id_subject_id_fkey" FOREIGN KEY ("tenant_id", "subject_id") REFERENCES "subjects"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "exam_rooms" ADD CONSTRAINT "exam_rooms_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───── Step 10, phase A: exam setup tables (hand-written: RLS, grants, CHECKs) ─────

ALTER TABLE subject_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE subject_components FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON subject_components
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE subject_pass_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE subject_pass_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON subject_pass_groups
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE section_subject_teachers ENABLE ROW LEVEL SECURITY;
ALTER TABLE section_subject_teachers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON section_subject_teachers
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE student_subject_choices ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_subject_choices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON student_subject_choices
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE exam_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_rooms FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON exam_rooms
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Setup data: the app edits and removes it (every change is audited by the service).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  subject_components, subject_pass_groups, section_subject_teachers, student_subject_choices,
  exam_rooms
TO jantrik_app;

ALTER TABLE subject_components
  ADD CONSTRAINT subject_components_key_format CHECK (key ~ '^[A-Z][A-Z0-9_]{0,19}$'),
  ADD CONSTRAINT subject_components_marks CHECK (
    full_marks BETWEEN 1 AND 1000
    AND (pass_marks IS NULL OR (pass_marks >= 0 AND pass_marks <= full_marks))
  ),
  ADD CONSTRAINT subject_components_names CHECK (
    length(btrim(name_bn)) BETWEEN 1 AND 60 AND length(btrim(name_en)) BETWEEN 1 AND 60
  );
ALTER TABLE subject_pass_groups
  ADD CONSTRAINT subject_pass_groups_marks CHECK (pass_marks >= 0);
ALTER TABLE exam_rooms
  ADD CONSTRAINT exam_rooms_size CHECK (rows >= 1 AND cols >= 1 AND rows * cols <= 500),
  ADD CONSTRAINT exam_rooms_name CHECK (length(btrim(name)) BETWEEN 1 AND 60);
