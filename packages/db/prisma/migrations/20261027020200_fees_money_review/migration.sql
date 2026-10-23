-- DropForeignKey
ALTER TABLE "fee_dues" DROP CONSTRAINT "fee_dues_tenant_id_concession_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_dues" DROP CONSTRAINT "fee_dues_tenant_id_fee_term_id_fkey";

-- AlterTable
ALTER TABLE "fee_payments" ALTER COLUMN "collected_by_id" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "fee_concessions_tenant_id_id_student_id_fee_head_id_academi_key" ON "fee_concessions"("tenant_id", "id", "student_id", "fee_head_id", "academic_year_id");

-- CreateIndex
CREATE UNIQUE INDEX "fee_terms_tenant_id_id_academic_year_id_key" ON "fee_terms"("tenant_id", "id", "academic_year_id");

-- AddForeignKey
ALTER TABLE "fee_dues" ADD CONSTRAINT "fee_dues_tenant_id_fee_term_id_academic_year_id_fkey" FOREIGN KEY ("tenant_id", "fee_term_id", "academic_year_id") REFERENCES "fee_terms"("tenant_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_dues" ADD CONSTRAINT "fee_dues_tenant_id_concession_id_student_id_fee_head_id_ac_fkey" FOREIGN KEY ("tenant_id", "concession_id", "student_id", "fee_head_id", "academic_year_id") REFERENCES "fee_concessions"("tenant_id", "id", "student_id", "fee_head_id", "academic_year_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ───────────────────────── Hand-written: review of the dues and payment tables ─────────────────────────
-- Plain (SECURITY INVOKER) trigger functions: they read only rows the caller may see under RLS.

-- The collector is now NOT NULL on the column itself.
ALTER TABLE fee_payments DROP CONSTRAINT IF EXISTS fee_payments_collector;

-- Allocations are checked at commit (all of a payment's allocations are written by then):
-- never to a void payment or a cancelled due, never more than the payment.
CREATE FUNCTION fee_payment_allocations_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  payment_status text;
  payment_amount integer;
  allocated bigint;
BEGIN
  SELECT status::text, amount_paisa INTO payment_status, payment_amount
    FROM fee_payments WHERE tenant_id = NEW.tenant_id AND id = NEW.payment_id;
  IF payment_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'fee allocation to a void payment' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM fee_dues
             WHERE tenant_id = NEW.tenant_id AND id = NEW.due_id AND status <> 'OPEN') THEN
    RAISE EXCEPTION 'fee allocation to a cancelled due' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(SUM(principal_paisa + fine_paisa), 0) INTO allocated
    FROM fee_payment_allocations WHERE tenant_id = NEW.tenant_id AND payment_id = NEW.payment_id;
  IF allocated > payment_amount THEN
    RAISE EXCEPTION 'fee allocations add up to more than the payment' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION fee_payment_allocations_check() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER fee_payment_allocations_check
  AFTER INSERT ON fee_payment_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fee_payment_allocations_check();

-- A payment is created ACTIVE; only a void (the UPDATE trigger) makes it VOID.
CREATE FUNCTION fee_payments_insert_active() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'fee payments are created active' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION fee_payments_insert_active() FROM PUBLIC;
CREATE TRIGGER fee_payments_insert_active
  BEFORE INSERT ON fee_payments
  FOR EACH ROW EXECUTE FUNCTION fee_payments_insert_active();

-- A cancelled due stays cancelled, with who and why (history is never rewritten).
CREATE FUNCTION fee_dues_cancel_final() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'a cancelled due cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION fee_dues_cancel_final() FROM PUBLIC;
CREATE TRIGGER fee_dues_cancel_final
  BEFORE UPDATE ON fee_dues
  FOR EACH ROW EXECUTE FUNCTION fee_dues_cancel_final();
