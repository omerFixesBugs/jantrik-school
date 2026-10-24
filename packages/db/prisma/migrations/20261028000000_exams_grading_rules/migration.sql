-- CreateEnum
CREATE TYPE "gpa_rounding" AS ENUM ('TRUNCATE', 'ROUND_HALF_UP');

-- CreateEnum
CREATE TYPE "pass_rule" AS ENUM ('PER_COMPONENT', 'COMBINED');

-- CreateEnum
CREATE TYPE "component_kind" AS ENUM ('CQ', 'MCQ', 'PRACTICAL', 'WRITTEN', 'ORAL', 'OTHER');

-- AlterTable
ALTER TABLE "grading_scheme_templates" ADD COLUMN     "compulsory_fail_zero" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "gpa_decimals" SMALLINT NOT NULL DEFAULT 2,
ADD COLUMN     "gpa_max" DECIMAL(3,2) NOT NULL DEFAULT 5.00,
ADD COLUMN     "gpa_rounding" "gpa_rounding" NOT NULL DEFAULT 'TRUNCATE',
ADD COLUMN     "optional_bonus_above" DECIMAL(3,2) DEFAULT 2.00;

-- AlterTable
ALTER TABLE "grading_schemes" ADD COLUMN     "compulsory_fail_zero" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "gpa_decimals" SMALLINT NOT NULL DEFAULT 2,
ADD COLUMN     "gpa_max" DECIMAL(3,2) NOT NULL DEFAULT 5.00,
ADD COLUMN     "gpa_rounding" "gpa_rounding" NOT NULL DEFAULT 'TRUNCATE',
ADD COLUMN     "optional_bonus_above" DECIMAL(3,2) DEFAULT 2.00;

-- AlterTable
ALTER TABLE "template_subjects" ADD COLUMN     "pass_rule" "pass_rule" NOT NULL DEFAULT 'PER_COMPONENT';

-- CreateTable
CREATE TABLE "template_subject_components" (
    "id" UUID NOT NULL,
    "template_subject_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "kind" "component_kind" NOT NULL,
    "name_bn" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "full_marks" INTEGER NOT NULL,
    "pass_marks" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_subject_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_subject_pass_groups" (
    "id" UUID NOT NULL,
    "template_subject_id" UUID NOT NULL,
    "kind" "component_kind" NOT NULL,
    "pass_marks" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_subject_pass_groups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "template_subject_components_template_subject_id_key_key" ON "template_subject_components"("template_subject_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "template_subject_pass_groups_template_subject_id_kind_key" ON "template_subject_pass_groups"("template_subject_id", "kind");

-- AddForeignKey
ALTER TABLE "template_subject_components" ADD CONSTRAINT "template_subject_components_template_subject_id_fkey" FOREIGN KEY ("template_subject_id") REFERENCES "template_subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_subject_pass_groups" ADD CONSTRAINT "template_subject_pass_groups_template_subject_id_fkey" FOREIGN KEY ("template_subject_id") REFERENCES "template_subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ───── Step 10: GPA rules on grading schemes; NCTB marks templates (hand-written) ─────

-- Global reference data: read-only for the app (written by the seed as the owner).
GRANT SELECT ON template_subject_components, template_subject_pass_groups TO jantrik_app;

ALTER TABLE grading_scheme_templates
  ADD CONSTRAINT grading_scheme_templates_gpa_rules CHECK (
    gpa_max > 0 AND gpa_decimals BETWEEN 0 AND 2
    AND (optional_bonus_above IS NULL OR (optional_bonus_above >= 0 AND optional_bonus_above <= gpa_max))
  );
ALTER TABLE grading_schemes
  ADD CONSTRAINT grading_schemes_gpa_rules CHECK (
    gpa_max > 0 AND gpa_decimals BETWEEN 0 AND 2
    AND (optional_bonus_above IS NULL OR (optional_bonus_above >= 0 AND optional_bonus_above <= gpa_max))
  );

ALTER TABLE template_subject_components
  ADD CONSTRAINT template_subject_components_key_format CHECK (key ~ '^[A-Z][A-Z0-9_]{0,19}$'),
  ADD CONSTRAINT template_subject_components_marks CHECK (
    full_marks BETWEEN 1 AND 1000
    AND (pass_marks IS NULL OR (pass_marks >= 0 AND pass_marks <= full_marks))
  );
ALTER TABLE template_subject_pass_groups
  ADD CONSTRAINT template_subject_pass_groups_marks CHECK (pass_marks >= 0);
