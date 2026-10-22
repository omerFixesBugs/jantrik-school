-- CreateEnum
CREATE TYPE "fee_head_kind" AS ENUM ('ADMISSION', 'TUITION', 'EXAM', 'SESSION', 'OTHER');

-- CreateEnum
CREATE TYPE "fee_frequency" AS ENUM ('ONE_TIME', 'MONTHLY', 'PER_TERM', 'YEARLY');

-- CreateEnum
CREATE TYPE "fee_fine_type" AS ENUM ('NONE', 'FLAT', 'PER_DAY');

-- CreateEnum
CREATE TYPE "fee_amount_type" AS ENUM ('FIXED', 'PERCENT');

-- CreateEnum
CREATE TYPE "fee_concession_category" AS ENUM ('GENERAL', 'FREE_FULL', 'FREE_HALF', 'SCHOLARSHIP');

-- CreateTable
CREATE TABLE "fee_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "dues_from" DATE,
    "receipt_sms_enabled" BOOLEAN NOT NULL DEFAULT true,
    "sibling_discount_type" "fee_amount_type",
    "sibling_discount_value" INTEGER,
    "sibling_from_child" SMALLINT NOT NULL DEFAULT 2,
    "receipt_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_heads" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name_bn" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "kind" "fee_head_kind" NOT NULL,
    "frequency" "fee_frequency" NOT NULL,
    "due_day" SMALLINT,
    "due_offset_days" SMALLINT NOT NULL DEFAULT 0,
    "one_time_from" DATE,
    "fine_type" "fee_fine_type" NOT NULL DEFAULT 'NONE',
    "fine_amount_paisa" INTEGER NOT NULL DEFAULT 0,
    "fine_cap_paisa" INTEGER,
    "sibling_eligible" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_heads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_terms" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "name_bn" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "opens_on" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_amounts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "fee_head_id" UUID NOT NULL,
    "class_level_id" UUID NOT NULL,
    "study_group_id" UUID,
    "amount_paisa" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_amounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_concessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "fee_head_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "category" "fee_concession_category" NOT NULL,
    "type" "fee_amount_type" NOT NULL,
    "value" INTEGER NOT NULL,
    "reason" TEXT,
    "valid_from" DATE NOT NULL,
    "ended_on" DATE,
    "ended_reason" TEXT,
    "created_by_id" UUID NOT NULL,
    "ended_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_concessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_sibling_groups" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_sibling_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_sibling_members" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "added_by_id" UUID NOT NULL,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by_id" UUID,
    "removed_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_sibling_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fee_settings_tenant_id_key" ON "fee_settings"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_settings_tenant_id_id_key" ON "fee_settings"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "fee_heads_tenant_id_sort_order_idx" ON "fee_heads"("tenant_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "fee_heads_tenant_id_id_key" ON "fee_heads"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_heads_tenant_id_name_bn_key" ON "fee_heads"("tenant_id", "name_bn");

-- CreateIndex
CREATE INDEX "fee_terms_tenant_id_academic_year_id_idx" ON "fee_terms"("tenant_id", "academic_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_terms_tenant_id_id_key" ON "fee_terms"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_terms_tenant_id_academic_year_id_name_bn_key" ON "fee_terms"("tenant_id", "academic_year_id", "name_bn");

-- CreateIndex
CREATE INDEX "fee_amounts_tenant_id_academic_year_id_class_level_id_idx" ON "fee_amounts"("tenant_id", "academic_year_id", "class_level_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_amounts_tenant_id_id_key" ON "fee_amounts"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_amounts_class_default" ON "fee_amounts"("tenant_id", "academic_year_id", "fee_head_id", "class_level_id") WHERE (study_group_id IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "fee_amounts_group_override" ON "fee_amounts"("tenant_id", "academic_year_id", "fee_head_id", "class_level_id", "study_group_id") WHERE (study_group_id IS NOT NULL);

-- CreateIndex
CREATE INDEX "fee_concessions_tenant_id_student_id_idx" ON "fee_concessions"("tenant_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_concessions_tenant_id_id_key" ON "fee_concessions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_concessions_one_active" ON "fee_concessions"("tenant_id", "student_id", "fee_head_id", "academic_year_id") WHERE (ended_on IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "fee_sibling_groups_tenant_id_id_key" ON "fee_sibling_groups"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "fee_sibling_members_tenant_id_group_id_idx" ON "fee_sibling_members"("tenant_id", "group_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_sibling_members_tenant_id_id_key" ON "fee_sibling_members"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_sibling_members_one_family" ON "fee_sibling_members"("tenant_id", "student_id") WHERE (removed_at IS NULL);

-- AddForeignKey
ALTER TABLE "fee_settings" ADD CONSTRAINT "fee_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_heads" ADD CONSTRAINT "fee_heads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_terms" ADD CONSTRAINT "fee_terms_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_terms" ADD CONSTRAINT "fee_terms_tenant_id_academic_year_id_fkey" FOREIGN KEY ("tenant_id", "academic_year_id") REFERENCES "academic_years"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_amounts" ADD CONSTRAINT "fee_amounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_amounts" ADD CONSTRAINT "fee_amounts_tenant_id_academic_year_id_fkey" FOREIGN KEY ("tenant_id", "academic_year_id") REFERENCES "academic_years"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_amounts" ADD CONSTRAINT "fee_amounts_tenant_id_fee_head_id_fkey" FOREIGN KEY ("tenant_id", "fee_head_id") REFERENCES "fee_heads"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_amounts" ADD CONSTRAINT "fee_amounts_tenant_id_class_level_id_fkey" FOREIGN KEY ("tenant_id", "class_level_id") REFERENCES "class_levels"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_amounts" ADD CONSTRAINT "fee_amounts_tenant_id_study_group_id_fkey" FOREIGN KEY ("tenant_id", "study_group_id") REFERENCES "study_groups"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_tenant_id_student_id_fkey" FOREIGN KEY ("tenant_id", "student_id") REFERENCES "students"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_tenant_id_fee_head_id_fkey" FOREIGN KEY ("tenant_id", "fee_head_id") REFERENCES "fee_heads"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_tenant_id_academic_year_id_fkey" FOREIGN KEY ("tenant_id", "academic_year_id") REFERENCES "academic_years"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_ended_by_id_fkey" FOREIGN KEY ("ended_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_sibling_groups" ADD CONSTRAINT "fee_sibling_groups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_sibling_groups" ADD CONSTRAINT "fee_sibling_groups_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_sibling_members" ADD CONSTRAINT "fee_sibling_members_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_sibling_members" ADD CONSTRAINT "fee_sibling_members_tenant_id_group_id_fkey" FOREIGN KEY ("tenant_id", "group_id") REFERENCES "fee_sibling_groups"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_sibling_members" ADD CONSTRAINT "fee_sibling_members_tenant_id_student_id_fkey" FOREIGN KEY ("tenant_id", "student_id") REFERENCES "students"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_sibling_members" ADD CONSTRAINT "fee_sibling_members_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_sibling_members" ADD CONSTRAINT "fee_sibling_members_removed_by_id_fkey" FOREIGN KEY ("removed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────────────────────── Hand-written: RLS, grants, checks ─────────────────────────
-- See docs/database.md → "Checklist: adding a tenant-owned table" and docs/fees.md.

ALTER TABLE fee_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fee_settings
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE fee_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_heads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fee_heads
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE fee_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_terms FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fee_terms
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE fee_amounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_amounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fee_amounts
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE fee_concessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_concessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fee_concessions
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE fee_sibling_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_sibling_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fee_sibling_groups
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE fee_sibling_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_sibling_members FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fee_sibling_members
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Amounts and unused terms may be deleted (dues reference terms with ON DELETE RESTRICT).
GRANT SELECT, INSERT, UPDATE, DELETE ON fee_amounts, fee_terms TO jantrik_app;
-- Heads are deactivated, concessions ended, family members removed, settings reset: kept as
-- history (audited), never deleted.
GRANT SELECT, INSERT, UPDATE
  ON fee_settings, fee_heads, fee_concessions, fee_sibling_groups, fee_sibling_members
  TO jantrik_app;

-- Checks. Money ceilings: ৳10 lakh per fee amount, ৳1 lakh per fine step.
ALTER TABLE fee_settings
  ADD CONSTRAINT fee_settings_dues_from_first_of_month
    CHECK (dues_from IS NULL OR extract(day FROM dues_from) = 1),
  ADD CONSTRAINT fee_settings_sibling_rule CHECK (
    (sibling_discount_type IS NULL AND sibling_discount_value IS NULL)
    OR (sibling_discount_type = 'PERCENT' AND sibling_discount_value BETWEEN 1 AND 100)
    OR (sibling_discount_type = 'FIXED' AND sibling_discount_value BETWEEN 1 AND 100000000)),
  ADD CONSTRAINT fee_settings_sibling_from_child CHECK (sibling_from_child BETWEEN 2 AND 10),
  ADD CONSTRAINT fee_settings_receipt_note_length
    CHECK (receipt_note IS NULL OR char_length(receipt_note) BETWEEN 1 AND 200);

ALTER TABLE fee_heads
  ADD CONSTRAINT fee_heads_names_present CHECK (
    btrim(name_bn) <> '' AND btrim(name_en) <> ''
    AND char_length(name_bn) <= 100 AND char_length(name_en) <= 100),
  ADD CONSTRAINT fee_heads_due_day CHECK (
    (frequency = 'MONTHLY' AND due_day BETWEEN 1 AND 28)
    OR (frequency <> 'MONTHLY' AND due_day IS NULL)),
  ADD CONSTRAINT fee_heads_due_offset_range CHECK (due_offset_days BETWEEN 0 AND 365),
  ADD CONSTRAINT fee_heads_one_time_from CHECK (one_time_from IS NULL OR frequency = 'ONE_TIME'),
  ADD CONSTRAINT fee_heads_fine_rule CHECK (
    (fine_type = 'NONE' AND fine_amount_paisa = 0 AND fine_cap_paisa IS NULL)
    OR (fine_type = 'FLAT' AND fine_amount_paisa BETWEEN 1 AND 10000000 AND fine_cap_paisa IS NULL)
    OR (fine_type = 'PER_DAY' AND fine_amount_paisa BETWEEN 1 AND 10000000
        AND fine_cap_paisa BETWEEN fine_amount_paisa AND 100000000));

ALTER TABLE fee_terms
  ADD CONSTRAINT fee_terms_names_present CHECK (
    btrim(name_bn) <> '' AND btrim(name_en) <> ''
    AND char_length(name_bn) <= 100 AND char_length(name_en) <= 100),
  ADD CONSTRAINT fee_terms_date_order CHECK (due_date >= opens_on);

ALTER TABLE fee_amounts
  ADD CONSTRAINT fee_amounts_amount_range CHECK (amount_paisa BETWEEN 1 AND 100000000);

ALTER TABLE fee_concessions
  ADD CONSTRAINT fee_concessions_value_range CHECK (
    (type = 'PERCENT' AND value BETWEEN 1 AND 100)
    OR (type = 'FIXED' AND value BETWEEN 1 AND 100000000)),
  ADD CONSTRAINT fee_concessions_category_rule CHECK (
    (category <> 'FREE_FULL' OR (type = 'PERCENT' AND value = 100))
    AND (category <> 'FREE_HALF' OR (type = 'PERCENT' AND value = 50))
    AND (category <> 'SCHOLARSHIP' OR char_length(btrim(reason)) BETWEEN 3 AND 500)),
  ADD CONSTRAINT fee_concessions_reason_length
    CHECK (reason IS NULL OR char_length(reason) <= 500),
  ADD CONSTRAINT fee_concessions_end CHECK (
    (ended_on IS NULL AND ended_by_id IS NULL AND ended_reason IS NULL)
    OR (ended_on IS NOT NULL AND ended_by_id IS NOT NULL AND ended_on >= valid_from
        AND char_length(btrim(ended_reason)) BETWEEN 3 AND 500));

ALTER TABLE fee_sibling_members
  ADD CONSTRAINT fee_sibling_members_removal CHECK (
    (removed_at IS NULL AND removed_by_id IS NULL AND removed_reason IS NULL)
    OR (removed_at IS NOT NULL AND removed_by_id IS NOT NULL
        AND char_length(btrim(removed_reason)) BETWEEN 3 AND 500));
