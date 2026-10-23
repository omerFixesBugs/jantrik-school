-- DropForeignKey
ALTER TABLE "fee_amounts" DROP CONSTRAINT "fee_amounts_tenant_id_academic_year_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_amounts" DROP CONSTRAINT "fee_amounts_tenant_id_class_level_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_amounts" DROP CONSTRAINT "fee_amounts_tenant_id_fee_head_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_amounts" DROP CONSTRAINT "fee_amounts_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_amounts" DROP CONSTRAINT "fee_amounts_tenant_id_study_group_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_concessions" DROP CONSTRAINT "fee_concessions_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_concessions" DROP CONSTRAINT "fee_concessions_ended_by_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_concessions" DROP CONSTRAINT "fee_concessions_tenant_id_academic_year_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_concessions" DROP CONSTRAINT "fee_concessions_tenant_id_fee_head_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_concessions" DROP CONSTRAINT "fee_concessions_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_concessions" DROP CONSTRAINT "fee_concessions_tenant_id_student_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_dues" DROP CONSTRAINT "fee_dues_cancelled_by_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_dues" DROP CONSTRAINT "fee_dues_tenant_id_academic_year_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_dues" DROP CONSTRAINT "fee_dues_tenant_id_concession_id_student_id_fee_head_id_ac_fkey";

-- DropForeignKey
ALTER TABLE "fee_dues" DROP CONSTRAINT "fee_dues_tenant_id_fee_head_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_dues" DROP CONSTRAINT "fee_dues_tenant_id_fee_term_id_academic_year_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_dues" DROP CONSTRAINT "fee_dues_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_dues" DROP CONSTRAINT "fee_dues_tenant_id_student_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_fine_waivers" DROP CONSTRAINT "fee_fine_waivers_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_fine_waivers" DROP CONSTRAINT "fee_fine_waivers_tenant_id_due_id_student_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_fine_waivers" DROP CONSTRAINT "fee_fine_waivers_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_fine_waivers" DROP CONSTRAINT "fee_fine_waivers_tenant_id_student_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_heads" DROP CONSTRAINT "fee_heads_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_mobile_accounts" DROP CONSTRAINT "fee_mobile_accounts_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_mobile_submission_dues" DROP CONSTRAINT "fee_mobile_submission_dues_tenant_id_due_id_student_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_mobile_submission_dues" DROP CONSTRAINT "fee_mobile_submission_dues_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_mobile_submission_dues" DROP CONSTRAINT "fee_mobile_submission_dues_tenant_id_student_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_mobile_submission_dues" DROP CONSTRAINT "fee_mobile_submission_dues_tenant_id_submission_id_student_fkey";

-- DropForeignKey
ALTER TABLE "fee_mobile_submissions" DROP CONSTRAINT "fee_mobile_submissions_reviewed_by_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_mobile_submissions" DROP CONSTRAINT "fee_mobile_submissions_submitted_by_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_mobile_submissions" DROP CONSTRAINT "fee_mobile_submissions_tenant_id_account_id_method_fkey";

-- DropForeignKey
ALTER TABLE "fee_mobile_submissions" DROP CONSTRAINT "fee_mobile_submissions_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_mobile_submissions" DROP CONSTRAINT "fee_mobile_submissions_tenant_id_payment_id_student_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_mobile_submissions" DROP CONSTRAINT "fee_mobile_submissions_tenant_id_student_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_payment_allocations" DROP CONSTRAINT "fee_payment_allocations_tenant_id_due_id_student_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_payment_allocations" DROP CONSTRAINT "fee_payment_allocations_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_payment_allocations" DROP CONSTRAINT "fee_payment_allocations_tenant_id_payment_id_student_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_payment_allocations" DROP CONSTRAINT "fee_payment_allocations_tenant_id_student_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_payments" DROP CONSTRAINT "fee_payments_collected_by_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_payments" DROP CONSTRAINT "fee_payments_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_payments" DROP CONSTRAINT "fee_payments_tenant_id_student_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_payments" DROP CONSTRAINT "fee_payments_voided_by_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_receipt_counters" DROP CONSTRAINT "fee_receipt_counters_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_settings" DROP CONSTRAINT "fee_settings_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_sibling_groups" DROP CONSTRAINT "fee_sibling_groups_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_sibling_groups" DROP CONSTRAINT "fee_sibling_groups_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_sibling_members" DROP CONSTRAINT "fee_sibling_members_added_by_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_sibling_members" DROP CONSTRAINT "fee_sibling_members_removed_by_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_sibling_members" DROP CONSTRAINT "fee_sibling_members_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_sibling_members" DROP CONSTRAINT "fee_sibling_members_tenant_id_group_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_sibling_members" DROP CONSTRAINT "fee_sibling_members_tenant_id_student_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_terms" DROP CONSTRAINT "fee_terms_tenant_id_academic_year_id_fkey";

-- DropForeignKey
ALTER TABLE "fee_terms" DROP CONSTRAINT "fee_terms_tenant_id_fkey";

-- AddForeignKey
ALTER TABLE "fee_settings" ADD CONSTRAINT "fee_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_heads" ADD CONSTRAINT "fee_heads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_terms" ADD CONSTRAINT "fee_terms_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_terms" ADD CONSTRAINT "fee_terms_tenant_id_academic_year_id_fkey" FOREIGN KEY ("tenant_id", "academic_year_id") REFERENCES "academic_years"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_amounts" ADD CONSTRAINT "fee_amounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_amounts" ADD CONSTRAINT "fee_amounts_tenant_id_academic_year_id_fkey" FOREIGN KEY ("tenant_id", "academic_year_id") REFERENCES "academic_years"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_amounts" ADD CONSTRAINT "fee_amounts_tenant_id_fee_head_id_fkey" FOREIGN KEY ("tenant_id", "fee_head_id") REFERENCES "fee_heads"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_amounts" ADD CONSTRAINT "fee_amounts_tenant_id_class_level_id_fkey" FOREIGN KEY ("tenant_id", "class_level_id") REFERENCES "class_levels"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_amounts" ADD CONSTRAINT "fee_amounts_tenant_id_study_group_id_fkey" FOREIGN KEY ("tenant_id", "study_group_id") REFERENCES "study_groups"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_tenant_id_student_id_fkey" FOREIGN KEY ("tenant_id", "student_id") REFERENCES "students"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_tenant_id_fee_head_id_fkey" FOREIGN KEY ("tenant_id", "fee_head_id") REFERENCES "fee_heads"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_tenant_id_academic_year_id_fkey" FOREIGN KEY ("tenant_id", "academic_year_id") REFERENCES "academic_years"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_concessions" ADD CONSTRAINT "fee_concessions_ended_by_id_fkey" FOREIGN KEY ("ended_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_sibling_groups" ADD CONSTRAINT "fee_sibling_groups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_sibling_groups" ADD CONSTRAINT "fee_sibling_groups_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_sibling_members" ADD CONSTRAINT "fee_sibling_members_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_sibling_members" ADD CONSTRAINT "fee_sibling_members_tenant_id_group_id_fkey" FOREIGN KEY ("tenant_id", "group_id") REFERENCES "fee_sibling_groups"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_sibling_members" ADD CONSTRAINT "fee_sibling_members_tenant_id_student_id_fkey" FOREIGN KEY ("tenant_id", "student_id") REFERENCES "students"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_sibling_members" ADD CONSTRAINT "fee_sibling_members_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_sibling_members" ADD CONSTRAINT "fee_sibling_members_removed_by_id_fkey" FOREIGN KEY ("removed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_dues" ADD CONSTRAINT "fee_dues_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_dues" ADD CONSTRAINT "fee_dues_tenant_id_student_id_fkey" FOREIGN KEY ("tenant_id", "student_id") REFERENCES "students"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_dues" ADD CONSTRAINT "fee_dues_tenant_id_fee_head_id_fkey" FOREIGN KEY ("tenant_id", "fee_head_id") REFERENCES "fee_heads"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_dues" ADD CONSTRAINT "fee_dues_tenant_id_academic_year_id_fkey" FOREIGN KEY ("tenant_id", "academic_year_id") REFERENCES "academic_years"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_dues" ADD CONSTRAINT "fee_dues_tenant_id_fee_term_id_academic_year_id_fkey" FOREIGN KEY ("tenant_id", "fee_term_id", "academic_year_id") REFERENCES "fee_terms"("tenant_id", "id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_dues" ADD CONSTRAINT "fee_dues_tenant_id_concession_id_student_id_fee_head_id_ac_fkey" FOREIGN KEY ("tenant_id", "concession_id", "student_id", "fee_head_id", "academic_year_id") REFERENCES "fee_concessions"("tenant_id", "id", "student_id", "fee_head_id", "academic_year_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_dues" ADD CONSTRAINT "fee_dues_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_fine_waivers" ADD CONSTRAINT "fee_fine_waivers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_fine_waivers" ADD CONSTRAINT "fee_fine_waivers_tenant_id_due_id_student_id_fkey" FOREIGN KEY ("tenant_id", "due_id", "student_id") REFERENCES "fee_dues"("tenant_id", "id", "student_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_fine_waivers" ADD CONSTRAINT "fee_fine_waivers_tenant_id_student_id_fkey" FOREIGN KEY ("tenant_id", "student_id") REFERENCES "students"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_fine_waivers" ADD CONSTRAINT "fee_fine_waivers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_receipt_counters" ADD CONSTRAINT "fee_receipt_counters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_tenant_id_student_id_fkey" FOREIGN KEY ("tenant_id", "student_id") REFERENCES "students"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_collected_by_id_fkey" FOREIGN KEY ("collected_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_payments" ADD CONSTRAINT "fee_payments_voided_by_id_fkey" FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_payment_allocations" ADD CONSTRAINT "fee_payment_allocations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_payment_allocations" ADD CONSTRAINT "fee_payment_allocations_tenant_id_payment_id_student_id_fkey" FOREIGN KEY ("tenant_id", "payment_id", "student_id") REFERENCES "fee_payments"("tenant_id", "id", "student_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_payment_allocations" ADD CONSTRAINT "fee_payment_allocations_tenant_id_due_id_student_id_fkey" FOREIGN KEY ("tenant_id", "due_id", "student_id") REFERENCES "fee_dues"("tenant_id", "id", "student_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_payment_allocations" ADD CONSTRAINT "fee_payment_allocations_tenant_id_student_id_fkey" FOREIGN KEY ("tenant_id", "student_id") REFERENCES "students"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_mobile_accounts" ADD CONSTRAINT "fee_mobile_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_mobile_submissions" ADD CONSTRAINT "fee_mobile_submissions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_mobile_submissions" ADD CONSTRAINT "fee_mobile_submissions_tenant_id_student_id_fkey" FOREIGN KEY ("tenant_id", "student_id") REFERENCES "students"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_mobile_submissions" ADD CONSTRAINT "fee_mobile_submissions_tenant_id_account_id_method_fkey" FOREIGN KEY ("tenant_id", "account_id", "method") REFERENCES "fee_mobile_accounts"("tenant_id", "id", "method") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_mobile_submissions" ADD CONSTRAINT "fee_mobile_submissions_tenant_id_payment_id_student_id_fkey" FOREIGN KEY ("tenant_id", "payment_id", "student_id") REFERENCES "fee_payments"("tenant_id", "id", "student_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_mobile_submissions" ADD CONSTRAINT "fee_mobile_submissions_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_mobile_submissions" ADD CONSTRAINT "fee_mobile_submissions_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_mobile_submission_dues" ADD CONSTRAINT "fee_mobile_submission_dues_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_mobile_submission_dues" ADD CONSTRAINT "fee_mobile_submission_dues_tenant_id_submission_id_student_fkey" FOREIGN KEY ("tenant_id", "submission_id", "student_id") REFERENCES "fee_mobile_submissions"("tenant_id", "id", "student_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_mobile_submission_dues" ADD CONSTRAINT "fee_mobile_submission_dues_tenant_id_due_id_student_id_fkey" FOREIGN KEY ("tenant_id", "due_id", "student_id") REFERENCES "fee_dues"("tenant_id", "id", "student_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "fee_mobile_submission_dues" ADD CONSTRAINT "fee_mobile_submission_dues_tenant_id_student_id_fkey" FOREIGN KEY ("tenant_id", "student_id") REFERENCES "students"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ───────────────────────── Hand-written: integrity after the security review ─────────────────────────
-- 1. Every fee foreign key is ON UPDATE RESTRICT (above): with CASCADE, changing a parent's key
--    (a term's year, a student's id) would rewrite fee rows behind their column-level grants.

-- 2. The allocation check serialises on the payment row (FOR UPDATE) and holds the due (FOR
--    SHARE), so a concurrent void, cancel or second allocation either waits or is refused.
CREATE OR REPLACE FUNCTION fee_payment_allocations_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  payment_status text;
  payment_amount integer;
  due_status text;
  allocated bigint;
BEGIN
  SELECT status::text, amount_paisa INTO payment_status, payment_amount
    FROM fee_payments WHERE tenant_id = NEW.tenant_id AND id = NEW.payment_id
    FOR UPDATE;
  IF payment_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'fee allocation to a void payment' USING ERRCODE = 'check_violation';
  END IF;
  SELECT status::text INTO due_status
    FROM fee_dues WHERE tenant_id = NEW.tenant_id AND id = NEW.due_id
    FOR SHARE;
  IF due_status IS DISTINCT FROM 'OPEN' THEN
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

-- 3. A due is created OPEN; cancelling it (an update) is refused while a live payment is on it,
--    whatever the cached totals say; a cancelled due never changes again.
CREATE OR REPLACE FUNCTION fee_dues_cancel_final() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'OPEN' THEN
      RAISE EXCEPTION 'fee dues are created open' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'a cancelled due cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'CANCELLED' AND EXISTS (
    SELECT 1 FROM fee_payment_allocations a
    JOIN fee_payments p ON p.tenant_id = a.tenant_id AND p.id = a.payment_id
    WHERE a.tenant_id = NEW.tenant_id AND a.due_id = NEW.id AND p.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'a due with payments on it cannot be cancelled' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS fee_dues_cancel_final ON fee_dues;
CREATE TRIGGER fee_dues_cancel_final
  BEFORE INSERT OR UPDATE ON fee_dues
  FOR EACH ROW EXECUTE FUNCTION fee_dues_cancel_final();
