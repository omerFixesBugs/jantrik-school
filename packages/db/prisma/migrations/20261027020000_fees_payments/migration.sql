-- CreateEnum
CREATE TYPE "fee_payment_method" AS ENUM ('CASH', 'BKASH', 'NAGAD');

-- CreateEnum
CREATE TYPE "fee_payment_channel" AS ENUM ('COUNTER', 'MOBILE_MANUAL');

-- CreateEnum
CREATE TYPE "fee_payment_status" AS ENUM ('ACTIVE', 'VOID');

-- CreateTable
CREATE TABLE "fee_receipt_counters" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "next_value" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_receipt_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "receipt_year" INTEGER NOT NULL,
    "receipt_no" INTEGER NOT NULL,
    "method" "fee_payment_method" NOT NULL,
    "channel" "fee_payment_channel" NOT NULL,
    "amount_paisa" INTEGER NOT NULL,
    "paid_on" DATE NOT NULL,
    "recorded_on" DATE NOT NULL,
    "trx_id" TEXT,
    "sender_phone" TEXT,
    "collected_by_id" UUID,
    "client_request_id" UUID NOT NULL,
    "status" "fee_payment_status" NOT NULL DEFAULT 'ACTIVE',
    "voided_at" TIMESTAMPTZ(3),
    "voided_by_id" UUID,
    "void_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_payment_allocations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "due_id" UUID NOT NULL,
    "principal_paisa" INTEGER NOT NULL,
    "fine_paisa" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fee_receipt_counters_tenant_id_id_key" ON "fee_receipt_counters"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_receipt_counters_tenant_id_year_key" ON "fee_receipt_counters"("tenant_id", "year");

-- CreateIndex
CREATE INDEX "fee_payments_tenant_id_student_id_idx" ON "fee_payments"("tenant_id", "student_id");

-- CreateIndex
CREATE INDEX "fee_payments_tenant_id_recorded_on_idx" ON "fee_payments"("tenant_id", "recorded_on");

-- CreateIndex
CREATE UNIQUE INDEX "fee_payments_tenant_id_id_key" ON "fee_payments"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_payments_tenant_id_id_student_id_key" ON "fee_payments"("tenant_id", "id", "student_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_payments_tenant_id_receipt_year_receipt_no_key" ON "fee_payments"("tenant_id", "receipt_year", "receipt_no");

-- CreateIndex
CREATE UNIQUE INDEX "fee_payments_tenant_id_client_request_id_key" ON "fee_payments"("tenant_id", "client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_payments_live_trx" ON "fee_payments"("tenant_id", "method", "trx_id") WHERE (status = 'ACTIVE' AND trx_id IS NOT NULL);

-- CreateIndex
CREATE INDEX "fee_payment_allocations_tenant_id_due_id_idx" ON "fee_payment_allocations"("tenant_id", "due_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_payment_allocations_tenant_id_id_key" ON "fee_payment_allocations"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_payment_allocations_tenant_id_payment_id_due_id_key" ON "fee_payment_allocations"("tenant_id", "payment_id", "due_id");

-- AddForeignKey
ALTER TABLE "fee_receipt_counters" ADD CONSTRAINT "fee_receipt_counters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_tenant_id_student_id_fkey" FOREIGN KEY ("tenant_id", "student_id") REFERENCES "students"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_collected_by_id_fkey" FOREIGN KEY ("collected_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_voided_by_id_fkey" FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_payment_allocations" ADD CONSTRAINT "fee_payment_allocations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_payment_allocations" ADD CONSTRAINT "fee_payment_allocations_tenant_id_payment_id_student_id_fkey" FOREIGN KEY ("tenant_id", "payment_id", "student_id") REFERENCES "fee_payments"("tenant_id", "id", "student_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_payment_allocations" ADD CONSTRAINT "fee_payment_allocations_tenant_id_due_id_student_id_fkey" FOREIGN KEY ("tenant_id", "due_id", "student_id") REFERENCES "fee_dues"("tenant_id", "id", "student_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_payment_allocations" ADD CONSTRAINT "fee_payment_allocations_tenant_id_student_id_fkey" FOREIGN KEY ("tenant_id", "student_id") REFERENCES "students"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────────────────────── Hand-written: RLS, grants, checks, void-only trigger ─────────────────────────
-- docs/database.md checklist and docs/fees.md (Payments and receipts). NULL-safe CHECKs.

ALTER TABLE fee_receipt_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_receipt_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fee_receipt_counters
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE fee_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fee_payments
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE fee_payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_payment_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fee_payment_allocations
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Counters are upserted, never deleted (a deleted counter would reuse receipt numbers).
GRANT SELECT, INSERT, UPDATE ON fee_receipt_counters TO jantrik_app;
-- Payments: never edited or deleted. The only change is a void (these columns, once: trigger).
GRANT SELECT, INSERT ON fee_payments TO jantrik_app;
GRANT UPDATE (status, voided_at, voided_by_id, void_reason, updated_at) ON fee_payments TO jantrik_app;
-- Allocations are append-only: a void flips the payment, the allocations stay as history.
GRANT SELECT, INSERT ON fee_payment_allocations TO jantrik_app;

-- A void is final: ACTIVE → VOID once, nothing else (not even the reason afterwards).
CREATE FUNCTION fee_payments_void_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.status = 'ACTIVE' AND NEW.status = 'VOID' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'fee payments can only be voided, once' USING ERRCODE = 'check_violation';
END
$$;
REVOKE ALL ON FUNCTION fee_payments_void_only() FROM PUBLIC;
CREATE TRIGGER fee_payments_void_only
  BEFORE UPDATE ON fee_payments
  FOR EACH ROW EXECUTE FUNCTION fee_payments_void_only();

ALTER TABLE fee_receipt_counters
  ADD CONSTRAINT fee_receipt_counters_year_range CHECK (year BETWEEN 2000 AND 2200),
  ADD CONSTRAINT fee_receipt_counters_next_positive CHECK (next_value >= 1);

ALTER TABLE fee_payments
  -- ৳1 crore at most in one payment.
  ADD CONSTRAINT fee_payments_amount CHECK (amount_paisa BETWEEN 1 AND 1000000000),
  ADD CONSTRAINT fee_payments_receipt_no CHECK (receipt_no >= 1),
  ADD CONSTRAINT fee_payments_receipt_year
    CHECK (receipt_year = EXTRACT(YEAR FROM recorded_on)::int),
  ADD CONSTRAINT fee_payments_dates CHECK (paid_on <= recorded_on),
  ADD CONSTRAINT fee_payments_trx_id CHECK (trx_id IS NULL OR trx_id ~ '^[A-Z0-9]{6,20}$'),
  ADD CONSTRAINT fee_payments_sender_phone
    CHECK (sender_phone IS NULL OR sender_phone ~ '^\+8801[3-9][0-9]{8}$'),
  -- Cash at the counter has no TrxID; a bKash/Nagad transfer has both the TrxID and the sender.
  ADD CONSTRAINT fee_payments_channel CHECK (
    (channel = 'COUNTER' AND method = 'CASH' AND trx_id IS NULL AND sender_phone IS NULL)
    OR (channel = 'MOBILE_MANUAL' AND method IN ('BKASH', 'NAGAD')
        AND trx_id IS NOT NULL AND sender_phone IS NOT NULL)),
  ADD CONSTRAINT fee_payments_collector CHECK (collected_by_id IS NOT NULL),
  ADD CONSTRAINT fee_payments_void CHECK (
    (status = 'ACTIVE' AND voided_at IS NULL AND voided_by_id IS NULL AND void_reason IS NULL)
    OR (status = 'VOID' AND voided_at IS NOT NULL AND voided_by_id IS NOT NULL
        AND void_reason IS NOT NULL AND char_length(btrim(void_reason)) BETWEEN 3 AND 500));

ALTER TABLE fee_payment_allocations
  ADD CONSTRAINT fee_payment_allocations_amounts CHECK (
    principal_paisa >= 0 AND fine_paisa >= 0 AND principal_paisa + fine_paisa > 0);
