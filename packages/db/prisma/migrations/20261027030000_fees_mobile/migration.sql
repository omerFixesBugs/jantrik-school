-- CreateEnum
CREATE TYPE "fee_mobile_account_kind" AS ENUM ('PERSONAL', 'MERCHANT', 'AGENT');

-- CreateEnum
CREATE TYPE "fee_submission_status" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED', 'VOIDED');

-- CreateEnum
CREATE TYPE "fee_submitter" AS ENUM ('GUARDIAN', 'STAFF');

-- CreateTable
CREATE TABLE "fee_mobile_accounts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "method" "fee_payment_method" NOT NULL,
    "phone" TEXT NOT NULL,
    "kind" "fee_mobile_account_kind" NOT NULL,
    "label" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_mobile_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_mobile_submissions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "method" "fee_payment_method" NOT NULL,
    "account_id" UUID NOT NULL,
    "amount_paisa" INTEGER NOT NULL,
    "trx_id" TEXT NOT NULL,
    "sender_phone" TEXT NOT NULL,
    "sent_on" DATE NOT NULL,
    "submitted_by_id" UUID NOT NULL,
    "submitter" "fee_submitter" NOT NULL,
    "status" "fee_submission_status" NOT NULL DEFAULT 'PENDING',
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "reject_reason" TEXT,
    "payment_id" UUID,
    "client_request_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_mobile_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_mobile_submission_dues" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "due_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_mobile_submission_dues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fee_mobile_accounts_tenant_id_is_active_idx" ON "fee_mobile_accounts"("tenant_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "fee_mobile_accounts_tenant_id_id_key" ON "fee_mobile_accounts"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_mobile_accounts_tenant_id_id_method_key" ON "fee_mobile_accounts"("tenant_id", "id", "method");

-- CreateIndex
CREATE UNIQUE INDEX "fee_mobile_accounts_tenant_id_method_phone_key" ON "fee_mobile_accounts"("tenant_id", "method", "phone");

-- CreateIndex
CREATE INDEX "fee_mobile_submissions_tenant_id_status_created_at_idx" ON "fee_mobile_submissions"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "fee_mobile_submissions_tenant_id_student_id_idx" ON "fee_mobile_submissions"("tenant_id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_mobile_submissions_tenant_id_id_key" ON "fee_mobile_submissions"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_mobile_submissions_tenant_id_id_student_id_key" ON "fee_mobile_submissions"("tenant_id", "id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_mobile_submissions_tenant_id_client_request_id_key" ON "fee_mobile_submissions"("tenant_id", "client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_mobile_submissions_open_trx" ON "fee_mobile_submissions"("tenant_id", "method", "trx_id") WHERE (status IN ('PENDING', 'VERIFIED'));

-- CreateIndex
CREATE INDEX "fee_mobile_submission_dues_tenant_id_due_id_idx" ON "fee_mobile_submission_dues"("tenant_id", "due_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_mobile_submission_dues_tenant_id_id_key" ON "fee_mobile_submission_dues"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_mobile_submission_dues_tenant_id_submission_id_due_id_key" ON "fee_mobile_submission_dues"("tenant_id", "submission_id", "due_id");

-- AddForeignKey
ALTER TABLE "fee_mobile_accounts" ADD CONSTRAINT "fee_mobile_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_mobile_submissions" ADD CONSTRAINT "fee_mobile_submissions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_mobile_submissions" ADD CONSTRAINT "fee_mobile_submissions_tenant_id_student_id_fkey" FOREIGN KEY ("tenant_id", "student_id") REFERENCES "students"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_mobile_submissions" ADD CONSTRAINT "fee_mobile_submissions_tenant_id_account_id_method_fkey" FOREIGN KEY ("tenant_id", "account_id", "method") REFERENCES "fee_mobile_accounts"("tenant_id", "id", "method") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_mobile_submissions" ADD CONSTRAINT "fee_mobile_submissions_tenant_id_payment_id_student_id_fkey" FOREIGN KEY ("tenant_id", "payment_id", "student_id") REFERENCES "fee_payments"("tenant_id", "id", "student_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_mobile_submissions" ADD CONSTRAINT "fee_mobile_submissions_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_mobile_submissions" ADD CONSTRAINT "fee_mobile_submissions_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_mobile_submission_dues" ADD CONSTRAINT "fee_mobile_submission_dues_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_mobile_submission_dues" ADD CONSTRAINT "fee_mobile_submission_dues_tenant_id_submission_id_student_fkey" FOREIGN KEY ("tenant_id", "submission_id", "student_id") REFERENCES "fee_mobile_submissions"("tenant_id", "id", "student_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_mobile_submission_dues" ADD CONSTRAINT "fee_mobile_submission_dues_tenant_id_due_id_student_id_fkey" FOREIGN KEY ("tenant_id", "due_id", "student_id") REFERENCES "fee_dues"("tenant_id", "id", "student_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_mobile_submission_dues" ADD CONSTRAINT "fee_mobile_submission_dues_tenant_id_student_id_fkey" FOREIGN KEY ("tenant_id", "student_id") REFERENCES "students"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────────────────────── Hand-written: RLS, grants, checks ─────────────────────────
-- docs/fees.md (manual bKash/Nagad). NULL-safe CHECKs.

ALTER TABLE fee_mobile_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_mobile_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fee_mobile_accounts
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE fee_mobile_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_mobile_submissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fee_mobile_submissions
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE fee_mobile_submission_dues ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_mobile_submission_dues FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fee_mobile_submission_dues
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Accounts are deactivated, never deleted (submissions point at them). Only label, activity and
-- order change; a number is replaced by adding a new account.
GRANT SELECT, INSERT ON fee_mobile_accounts TO jantrik_app;
GRANT UPDATE (label, is_active, sort_order, updated_at) ON fee_mobile_accounts TO jantrik_app;
-- Submissions are history: who sent what, how much and which TrxID never change; only the review.
GRANT SELECT, INSERT ON fee_mobile_submissions TO jantrik_app;
GRANT UPDATE (status, reviewed_by_id, reviewed_at, reject_reason, payment_id, updated_at)
  ON fee_mobile_submissions TO jantrik_app;
GRANT SELECT, INSERT ON fee_mobile_submission_dues TO jantrik_app;

ALTER TABLE fee_mobile_accounts
  ADD CONSTRAINT fee_mobile_accounts_method CHECK (method IN ('BKASH', 'NAGAD')),
  ADD CONSTRAINT fee_mobile_accounts_phone CHECK (phone ~ '^\+8801[3-9][0-9]{8}$'),
  ADD CONSTRAINT fee_mobile_accounts_label
    CHECK (label IS NULL OR char_length(btrim(label)) BETWEEN 1 AND 60);

ALTER TABLE fee_mobile_submissions
  ADD CONSTRAINT fee_mobile_submissions_method CHECK (method IN ('BKASH', 'NAGAD')),
  ADD CONSTRAINT fee_mobile_submissions_trx_id CHECK (trx_id ~ '^[A-Z0-9]{6,20}$'),
  ADD CONSTRAINT fee_mobile_submissions_sender_phone
    CHECK (sender_phone ~ '^\+8801[3-9][0-9]{8}$'),
  ADD CONSTRAINT fee_mobile_submissions_amount CHECK (amount_paisa BETWEEN 1 AND 1000000000),
  ADD CONSTRAINT fee_mobile_submissions_review CHECK (
    (status = 'PENDING' AND reviewed_by_id IS NULL AND reviewed_at IS NULL
       AND reject_reason IS NULL AND payment_id IS NULL)
    OR (status IN ('VERIFIED', 'VOIDED') AND reviewed_by_id IS NOT NULL AND reviewed_at IS NOT NULL
       AND reject_reason IS NULL AND payment_id IS NOT NULL)
    OR (status = 'REJECTED' AND reviewed_by_id IS NOT NULL AND reviewed_at IS NOT NULL
       AND reject_reason IS NOT NULL AND char_length(btrim(reject_reason)) BETWEEN 3 AND 500
       AND payment_id IS NULL));
