-- CreateEnum
CREATE TYPE "fee_due_status" AS ENUM ('OPEN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "fee_concession_source" AS ENUM ('NONE', 'MANUAL', 'SIBLING');

-- CreateTable
CREATE TABLE "fee_dues" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "fee_head_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "period_key" TEXT NOT NULL,
    "fee_term_id" UUID,
    "period_start" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "amount_paisa" INTEGER NOT NULL,
    "concession_paisa" INTEGER NOT NULL DEFAULT 0,
    "concession_source" "fee_concession_source" NOT NULL DEFAULT 'NONE',
    "concession_id" UUID,
    "fine_type" "fee_fine_type" NOT NULL,
    "fine_amount_paisa" INTEGER NOT NULL,
    "fine_cap_paisa" INTEGER,
    "paid_principal_paisa" INTEGER NOT NULL DEFAULT 0,
    "paid_fine_paisa" INTEGER NOT NULL DEFAULT 0,
    "principal_cleared_on" DATE,
    "fine_waived_paisa" INTEGER NOT NULL DEFAULT 0,
    "fine_waived_all" BOOLEAN NOT NULL DEFAULT false,
    "status" "fee_due_status" NOT NULL DEFAULT 'OPEN',
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_dues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_fine_waivers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "due_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "amount_paisa" INTEGER,
    "reason" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_fine_waivers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fee_dues_tenant_id_academic_year_id_status_due_date_idx" ON "fee_dues"("tenant_id", "academic_year_id", "status", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "fee_dues_tenant_id_id_key" ON "fee_dues"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_dues_tenant_id_id_student_id_key" ON "fee_dues"("tenant_id", "id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_dues_tenant_id_student_id_fee_head_id_academic_year_id__key" ON "fee_dues"("tenant_id", "student_id", "fee_head_id", "academic_year_id", "period_key");

-- CreateIndex
CREATE UNIQUE INDEX "fee_dues_one_time_once" ON "fee_dues"("tenant_id", "student_id", "fee_head_id") WHERE (period_key = 'ONCE');

-- CreateIndex
CREATE INDEX "fee_fine_waivers_tenant_id_due_id_idx" ON "fee_fine_waivers"("tenant_id", "due_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_fine_waivers_tenant_id_id_key" ON "fee_fine_waivers"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "fee_dues" ADD CONSTRAINT "fee_dues_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_dues" ADD CONSTRAINT "fee_dues_tenant_id_student_id_fkey" FOREIGN KEY ("tenant_id", "student_id") REFERENCES "students"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_dues" ADD CONSTRAINT "fee_dues_tenant_id_fee_head_id_fkey" FOREIGN KEY ("tenant_id", "fee_head_id") REFERENCES "fee_heads"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_dues" ADD CONSTRAINT "fee_dues_tenant_id_academic_year_id_fkey" FOREIGN KEY ("tenant_id", "academic_year_id") REFERENCES "academic_years"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_dues" ADD CONSTRAINT "fee_dues_tenant_id_fee_term_id_fkey" FOREIGN KEY ("tenant_id", "fee_term_id") REFERENCES "fee_terms"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_dues" ADD CONSTRAINT "fee_dues_tenant_id_concession_id_fkey" FOREIGN KEY ("tenant_id", "concession_id") REFERENCES "fee_concessions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_dues" ADD CONSTRAINT "fee_dues_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_fine_waivers" ADD CONSTRAINT "fee_fine_waivers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_fine_waivers" ADD CONSTRAINT "fee_fine_waivers_tenant_id_due_id_student_id_fkey" FOREIGN KEY ("tenant_id", "due_id", "student_id") REFERENCES "fee_dues"("tenant_id", "id", "student_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_fine_waivers" ADD CONSTRAINT "fee_fine_waivers_tenant_id_student_id_fkey" FOREIGN KEY ("tenant_id", "student_id") REFERENCES "students"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_fine_waivers" ADD CONSTRAINT "fee_fine_waivers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────────────────────── Hand-written: RLS, grants, checks ─────────────────────────
-- docs/database.md checklist and docs/fees.md. Every CHECK is NULL-safe: a CHECK that evaluates
-- to NULL passes, so nullable columns are tested with IS [NOT] NULL first.

ALTER TABLE fee_dues ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_dues FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fee_dues
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE fee_fine_waivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_fine_waivers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fee_fine_waivers
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Dues are history (we report and collect against them): never deleted. Who, which head, which
-- year, which period and when it fell due are never rewritten; only the money columns (the
-- snapshot when recalculated, the cached totals) and cancellation change.
GRANT SELECT, INSERT ON fee_dues TO jantrik_app;
GRANT UPDATE (
  amount_paisa, concession_paisa, concession_source, concession_id,
  fine_type, fine_amount_paisa, fine_cap_paisa,
  paid_principal_paisa, paid_fine_paisa, principal_cleared_on,
  fine_waived_paisa, fine_waived_all,
  status, cancelled_at, cancelled_by_id, cancel_reason, updated_at
) ON fee_dues TO jantrik_app;
-- Waivers are append-only.
GRANT SELECT, INSERT ON fee_fine_waivers TO jantrik_app;

ALTER TABLE fee_dues
  ADD CONSTRAINT fee_dues_period_key CHECK (
    period_key ~ '^(ONCE|Y|[0-9]{4}-(0[1-9]|1[0-2])|T:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
  ADD CONSTRAINT fee_dues_term CHECK (
    (period_key LIKE 'T:%' AND fee_term_id IS NOT NULL AND period_key = 'T:' || fee_term_id::text)
    OR (period_key NOT LIKE 'T:%' AND fee_term_id IS NULL)),
  ADD CONSTRAINT fee_dues_dates CHECK (due_date >= period_start),
  ADD CONSTRAINT fee_dues_amount CHECK (amount_paisa BETWEEN 0 AND 100000000),
  ADD CONSTRAINT fee_dues_concession CHECK (
    concession_paisa BETWEEN 0 AND amount_paisa
    AND (concession_source = 'NONE') = (concession_paisa = 0)
    AND (concession_source = 'MANUAL') = (concession_id IS NOT NULL)),
  ADD CONSTRAINT fee_dues_fine_rule CHECK (
    (fine_type = 'NONE' AND fine_amount_paisa = 0 AND fine_cap_paisa IS NULL)
    OR (fine_type = 'FLAT' AND fine_amount_paisa BETWEEN 1 AND 10000000 AND fine_cap_paisa IS NULL)
    OR (fine_type = 'PER_DAY' AND fine_amount_paisa BETWEEN 1 AND 10000000
        AND fine_cap_paisa IS NOT NULL AND fine_cap_paisa BETWEEN fine_amount_paisa AND 100000000)),
  -- Never more principal paid than the due is worth (a backstop against allocation bugs).
  ADD CONSTRAINT fee_dues_paid CHECK (
    paid_principal_paisa BETWEEN 0 AND amount_paisa - concession_paisa
    AND paid_fine_paisa >= 0 AND fine_waived_paisa >= 0),
  ADD CONSTRAINT fee_dues_cleared CHECK (
    principal_cleared_on IS NULL OR paid_principal_paisa = amount_paisa - concession_paisa),
  ADD CONSTRAINT fee_dues_cancel CHECK (
    (status = 'OPEN' AND cancelled_at IS NULL AND cancelled_by_id IS NULL AND cancel_reason IS NULL)
    OR (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by_id IS NOT NULL
        AND cancel_reason IS NOT NULL AND char_length(btrim(cancel_reason)) BETWEEN 3 AND 500
        AND paid_principal_paisa = 0 AND paid_fine_paisa = 0));

ALTER TABLE fee_fine_waivers
  ADD CONSTRAINT fee_fine_waivers_amount CHECK (
    amount_paisa IS NULL OR amount_paisa BETWEEN 1 AND 100000000),
  ADD CONSTRAINT fee_fine_waivers_reason CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500);
