-- Sprint 1 P3a (docs/admission.md): admission cycles, the classes they take, applications (history,
-- never deleted), applicant photos until approval, and the per-year application numbers.

-- CreateEnum
CREATE TYPE "admission_cycle_status" AS ENUM ('DRAFT', 'OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "admission_application_status" AS ENUM ('SUBMITTED', 'SHORTLISTED', 'SELECTED', 'WAITLISTED', 'REJECTED', 'ADMITTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "admission_source" AS ENUM ('ONLINE', 'STAFF');

-- CreateTable
CREATE TABLE "admission_cycles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "name_bn" TEXT NOT NULL,
    "name_en" TEXT,
    "status" "admission_cycle_status" NOT NULL DEFAULT 'DRAFT',
    "opens_at" TIMESTAMPTZ(3) NOT NULL,
    "closes_at" TIMESTAMPTZ(3) NOT NULL,
    "public_note_bn" TEXT,
    "public_note_en" TEXT,
    "requires_test" BOOLEAN NOT NULL DEFAULT false,
    "collect_photo" BOOLEAN NOT NULL DEFAULT false,
    "fields" JSONB NOT NULL DEFAULT '{}',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admission_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admission_cycle_classes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "cycle_id" UUID NOT NULL,
    "class_level_id" UUID NOT NULL,
    "study_group_id" UUID,
    "seats" INTEGER,
    "is_open" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admission_cycle_classes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admission_applications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "cycle_id" UUID NOT NULL,
    "cycle_class_id" UUID NOT NULL,
    "application_no" TEXT NOT NULL,
    "source" "admission_source" NOT NULL,
    "name_bn" TEXT,
    "name_en" TEXT,
    "name_key" TEXT NOT NULL,
    "date_of_birth" DATE NOT NULL,
    "gender" "gender" NOT NULL,
    "religion" "religion",
    "blood_group" "blood_group",
    "birth_registration_no" TEXT,
    "previous_institute" TEXT,
    "present_address" TEXT,
    "permanent_address" TEXT,
    "father_name_bn" TEXT,
    "father_name_en" TEXT,
    "mother_name_bn" TEXT,
    "mother_name_en" TEXT,
    "guardian_name_bn" TEXT,
    "guardian_name_en" TEXT,
    "guardian_relation" "guardian_relation" NOT NULL,
    "guardian_occupation" TEXT,
    "phone" TEXT NOT NULL,
    "status" "admission_application_status" NOT NULL DEFAULT 'SUBMITTED',
    "status_reason" TEXT,
    "status_by" UUID,
    "status_at" TIMESTAMPTZ(3),
    "staff_note" TEXT,
    "student_id" UUID,
    "approval_problem" TEXT,
    "approval_problem_at" TIMESTAMPTZ(3),
    "submitted_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admission_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admission_application_photos" (
    "tenant_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "sha256" TEXT NOT NULL,
    "width" SMALLINT NOT NULL,
    "height" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admission_application_photos_pkey" PRIMARY KEY ("tenant_id","application_id")
);

-- CreateTable
CREATE TABLE "admission_counters" (
    "tenant_id" UUID NOT NULL,
    "year" SMALLINT NOT NULL,
    "last_no" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admission_counters_pkey" PRIMARY KEY ("tenant_id","year")
);

-- CreateIndex
CREATE INDEX "admission_cycles_tenant_id_academic_year_id_status_idx" ON "admission_cycles"("tenant_id", "academic_year_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "admission_cycles_tenant_id_id_key" ON "admission_cycles"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "admission_cycle_classes_tenant_id_cycle_id_idx" ON "admission_cycle_classes"("tenant_id", "cycle_id");

-- CreateIndex
CREATE UNIQUE INDEX "admission_cycle_classes_tenant_id_id_key" ON "admission_cycle_classes"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "admission_cycle_classes_tenant_id_id_cycle_id_key" ON "admission_cycle_classes"("tenant_id", "id", "cycle_id");

-- CreateIndex
CREATE UNIQUE INDEX "admission_cycle_classes_tenant_id_cycle_id_class_level_id_s_key" ON "admission_cycle_classes"("tenant_id", "cycle_id", "class_level_id", "study_group_id");

-- CreateIndex
CREATE UNIQUE INDEX "admission_cycle_classes_one_without_group" ON "admission_cycle_classes"("tenant_id", "cycle_id", "class_level_id") WHERE (study_group_id IS NULL);

-- CreateIndex
CREATE INDEX "admission_applications_tenant_id_cycle_id_status_idx" ON "admission_applications"("tenant_id", "cycle_id", "status");

-- CreateIndex
CREATE INDEX "admission_applications_tenant_id_phone_idx" ON "admission_applications"("tenant_id", "phone");

-- CreateIndex
CREATE INDEX "admission_applications_birth_reg_idx" ON "admission_applications"("tenant_id", "cycle_id", "birth_registration_no") WHERE (birth_registration_no IS NOT NULL);

-- CreateIndex
CREATE INDEX "admission_applications_tenant_id_cycle_class_id_idx" ON "admission_applications"("tenant_id", "cycle_class_id");

-- CreateIndex
CREATE UNIQUE INDEX "admission_applications_tenant_id_id_key" ON "admission_applications"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "admission_applications_tenant_id_application_no_key" ON "admission_applications"("tenant_id", "application_no");

-- CreateIndex
CREATE UNIQUE INDEX "admission_applications_tenant_id_student_id_key" ON "admission_applications"("tenant_id", "student_id");

-- AddForeignKey
ALTER TABLE "admission_cycles" ADD CONSTRAINT "admission_cycles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "admission_cycles" ADD CONSTRAINT "admission_cycles_tenant_id_academic_year_id_fkey" FOREIGN KEY ("tenant_id", "academic_year_id") REFERENCES "academic_years"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "admission_cycle_classes" ADD CONSTRAINT "admission_cycle_classes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "admission_cycle_classes" ADD CONSTRAINT "admission_cycle_classes_tenant_id_cycle_id_fkey" FOREIGN KEY ("tenant_id", "cycle_id") REFERENCES "admission_cycles"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "admission_cycle_classes" ADD CONSTRAINT "admission_cycle_classes_tenant_id_class_level_id_fkey" FOREIGN KEY ("tenant_id", "class_level_id") REFERENCES "class_levels"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "admission_cycle_classes" ADD CONSTRAINT "admission_cycle_classes_tenant_id_study_group_id_fkey" FOREIGN KEY ("tenant_id", "study_group_id") REFERENCES "study_groups"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "admission_applications" ADD CONSTRAINT "admission_applications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "admission_applications" ADD CONSTRAINT "admission_applications_tenant_id_cycle_id_fkey" FOREIGN KEY ("tenant_id", "cycle_id") REFERENCES "admission_cycles"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "admission_applications" ADD CONSTRAINT "admission_applications_tenant_id_cycle_class_id_cycle_id_fkey" FOREIGN KEY ("tenant_id", "cycle_class_id", "cycle_id") REFERENCES "admission_cycle_classes"("tenant_id", "id", "cycle_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "admission_applications" ADD CONSTRAINT "admission_applications_tenant_id_student_id_fkey" FOREIGN KEY ("tenant_id", "student_id") REFERENCES "students"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "admission_application_photos" ADD CONSTRAINT "admission_application_photos_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "admission_application_photos" ADD CONSTRAINT "admission_application_photos_tenant_id_application_id_fkey" FOREIGN KEY ("tenant_id", "application_id") REFERENCES "admission_applications"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "admission_counters" ADD CONSTRAINT "admission_counters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ───────────────────────── Rules (CHECK) ─────────────────────────
ALTER TABLE admission_cycles
  ADD CONSTRAINT admission_cycles_name_bn CHECK (char_length(name_bn) BETWEEN 1 AND 80),
  ADD CONSTRAINT admission_cycles_name_en CHECK (name_en IS NULL OR char_length(name_en) BETWEEN 1 AND 80),
  ADD CONSTRAINT admission_cycles_window CHECK (closes_at > opens_at),
  ADD CONSTRAINT admission_cycles_note_bn CHECK (public_note_bn IS NULL OR char_length(public_note_bn) <= 1000),
  ADD CONSTRAINT admission_cycles_note_en CHECK (public_note_en IS NULL OR char_length(public_note_en) <= 1000),
  -- Only the known optional fields, each HIDDEN, OPTIONAL or REQUIRED (packages/shared/src/admission.ts).
  ADD CONSTRAINT admission_cycles_fields CHECK (
    jsonb_typeof(fields) = 'object'
    AND (fields - ARRAY['photo', 'religion', 'blood_group', 'birth_registration_no',
                        'previous_institute', 'present_address', 'permanent_address',
                        'father_name', 'mother_name', 'guardian_occupation']) = '{}'::jsonb
    AND NOT jsonb_path_exists(fields, '$.* ? (@ != "HIDDEN" && @ != "OPTIONAL" && @ != "REQUIRED")')
  );

ALTER TABLE admission_cycle_classes
  ADD CONSTRAINT admission_cycle_classes_seats CHECK (seats IS NULL OR seats BETWEEN 1 AND 5000);

-- Lengths follow the student fields' (packages/shared/src/students.ts), so an approved
-- application always fits a student.
ALTER TABLE admission_applications
  ADD CONSTRAINT admission_applications_no CHECK (application_no ~ '^[0-9]{4}-[0-9]{4,6}$'),
  ADD CONSTRAINT admission_applications_name CHECK (name_bn IS NOT NULL OR name_en IS NOT NULL),
  ADD CONSTRAINT admission_applications_name_bn CHECK (name_bn IS NULL OR char_length(name_bn) BETWEEN 1 AND 120),
  ADD CONSTRAINT admission_applications_name_en CHECK (name_en IS NULL OR char_length(name_en) BETWEEN 1 AND 120),
  ADD CONSTRAINT admission_applications_name_key CHECK (char_length(name_key) BETWEEN 1 AND 240),
  ADD CONSTRAINT admission_applications_dob CHECK (date_of_birth BETWEEN DATE '1920-01-01' AND DATE '2100-01-01'),
  ADD CONSTRAINT admission_applications_birth_reg CHECK (birth_registration_no IS NULL OR birth_registration_no ~ '^[0-9]{17}$'),
  ADD CONSTRAINT admission_applications_previous_institute CHECK (previous_institute IS NULL OR char_length(previous_institute) <= 150),
  ADD CONSTRAINT admission_applications_present_address CHECK (present_address IS NULL OR char_length(present_address) <= 300),
  ADD CONSTRAINT admission_applications_permanent_address CHECK (permanent_address IS NULL OR char_length(permanent_address) <= 300),
  ADD CONSTRAINT admission_applications_parent_names CHECK (
    (father_name_bn IS NULL OR char_length(father_name_bn) <= 120)
    AND (father_name_en IS NULL OR char_length(father_name_en) <= 120)
    AND (mother_name_bn IS NULL OR char_length(mother_name_bn) <= 120)
    AND (mother_name_en IS NULL OR char_length(mother_name_en) <= 120)
  ),
  ADD CONSTRAINT admission_applications_guardian_name CHECK (guardian_name_bn IS NOT NULL OR guardian_name_en IS NOT NULL),
  ADD CONSTRAINT admission_applications_guardian_names CHECK (
    (guardian_name_bn IS NULL OR char_length(guardian_name_bn) <= 120)
    AND (guardian_name_en IS NULL OR char_length(guardian_name_en) <= 120)
  ),
  ADD CONSTRAINT admission_applications_occupation CHECK (guardian_occupation IS NULL OR char_length(guardian_occupation) <= 120),
  ADD CONSTRAINT admission_applications_phone CHECK (phone ~ '^\+8801[3-9][0-9]{8}$'),
  ADD CONSTRAINT admission_applications_reason CHECK (status_reason IS NULL OR char_length(status_reason) <= 500),
  ADD CONSTRAINT admission_applications_reason_required CHECK (status NOT IN ('REJECTED', 'WITHDRAWN') OR status_reason IS NOT NULL),
  ADD CONSTRAINT admission_applications_status_by CHECK ((status_by IS NULL) = (status_at IS NULL)),
  ADD CONSTRAINT admission_applications_staff_note CHECK (staff_note IS NULL OR char_length(staff_note) <= 2000),
  ADD CONSTRAINT admission_applications_admitted CHECK ((status = 'ADMITTED') = (student_id IS NOT NULL)),
  ADD CONSTRAINT admission_applications_problem CHECK (
    approval_problem IS NULL
    OR approval_problem IN ('GUARDIAN_CHOICE_REQUIRED', 'STUDENT_LIMIT', 'SECTION_FULL', 'DUPLICATE', 'INACTIVE', 'INVALID')
  ),
  ADD CONSTRAINT admission_applications_problem_at CHECK ((approval_problem IS NULL) = (approval_problem_at IS NULL));

ALTER TABLE admission_application_photos
  ADD CONSTRAINT admission_application_photos_mime CHECK (mime = 'image/jpeg'),
  ADD CONSTRAINT admission_application_photos_size CHECK (octet_length(bytes) BETWEEN 1 AND 204800),
  ADD CONSTRAINT admission_application_photos_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT admission_application_photos_box CHECK (width BETWEEN 1 AND 800 AND height BETWEEN 1 AND 800);

ALTER TABLE admission_counters
  ADD CONSTRAINT admission_counters_year CHECK (year BETWEEN 2000 AND 2100),
  ADD CONSTRAINT admission_counters_last_no CHECK (last_no BETWEEN 0 AND 999999);

-- ───────────────────────── Row-Level Security (docs/database.md → Checklist) ─────────────────────────
ALTER TABLE admission_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE admission_cycles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON admission_cycles
  USING (tenant_id = (SELECT app_current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant_id()));

ALTER TABLE admission_cycle_classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE admission_cycle_classes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON admission_cycle_classes
  USING (tenant_id = (SELECT app_current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant_id()));

ALTER TABLE admission_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE admission_applications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON admission_applications
  USING (tenant_id = (SELECT app_current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant_id()));

ALTER TABLE admission_application_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE admission_application_photos FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON admission_application_photos
  USING (tenant_id = (SELECT app_current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant_id()));

ALTER TABLE admission_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE admission_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON admission_counters
  USING (tenant_id = (SELECT app_current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant_id()));

-- ───────────────────────── Grants ─────────────────────────
-- Cycles are closed, never deleted (applications point at them). A cycle's class may be removed
-- while it has no application (the applications' FK refuses otherwise).
GRANT SELECT, INSERT, UPDATE ON admission_cycles TO jantrik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON admission_cycle_classes TO jantrik_app;
-- Applications are history: no DELETE, and the number, source, cycle and submission time never
-- change (a class may move only within the cycle: the composite FK).
GRANT SELECT, INSERT ON admission_applications TO jantrik_app;
GRANT UPDATE (name_bn, name_en, name_key, date_of_birth, gender, religion, blood_group,
              birth_registration_no, previous_institute, present_address, permanent_address,
              father_name_bn, father_name_en, mother_name_bn, mother_name_en,
              guardian_name_bn, guardian_name_en, guardian_relation, guardian_occupation, phone,
              cycle_class_id, status, status_reason, status_by, status_at, staff_note, student_id,
              approval_problem, approval_problem_at, updated_at)
  ON admission_applications TO jantrik_app;
-- A photo is inserted once and deleted when approval moves it to the student.
GRANT SELECT, INSERT, DELETE ON admission_application_photos TO jantrik_app;
GRANT SELECT, INSERT, UPDATE ON admission_counters TO jantrik_app;
