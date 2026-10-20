-- Step 8, part 3: subscriptions and billing. See docs/platform.md.
--   * platform_invoices / _lines / _payments: tenant tables (the institute reads its own; only
--     the platform functions write; no DELETE for anyone). Overdue = ISSUED and past due_on.
--   * tenant_subscriptions.billing_starts_on: the first month invoiced.
--   * Functions: set the plan, activate (TRIAL → ACTIVE), generate a month's invoices
--     (idempotent), record a payment, void an unpaid invoice, list and read invoices; the
--     institute list and detail show what is overdue.

-- CreateEnum
CREATE TYPE "invoice_status" AS ENUM ('ISSUED', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "invoice_line_kind" AS ENUM ('CORE', 'ATTENDANCE', 'FEES', 'EXAMS', 'FLAT', 'DISCOUNT');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('CASH', 'BKASH', 'BANK');

-- AlterTable
ALTER TABLE "tenant_subscriptions" ADD COLUMN     "billing_starts_on" DATE;

-- CreateTable
CREATE TABLE "platform_invoices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "cycle" "billing_cycle" NOT NULL,
    "issued_on" DATE NOT NULL,
    "due_on" DATE NOT NULL,
    "status" "invoice_status" NOT NULL DEFAULT 'ISSUED',
    "total_paisa" INTEGER NOT NULL,
    "paid_paisa" INTEGER NOT NULL DEFAULT 0,
    "void_reason" TEXT,
    "voided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_invoice_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "kind" "invoice_line_kind" NOT NULL,
    "active_students" INTEGER,
    "unit_paisa" INTEGER NOT NULL,
    "months" SMALLINT NOT NULL,
    "amount_paisa" INTEGER NOT NULL,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "platform_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount_paisa" INTEGER NOT NULL,
    "method" "payment_method" NOT NULL,
    "reference" TEXT,
    "paid_on" DATE NOT NULL,
    "recorded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_invoices_tenant_id_due_on_idx" ON "platform_invoices"("tenant_id", "due_on");

-- CreateIndex
CREATE UNIQUE INDEX "platform_invoices_tenant_id_id_key" ON "platform_invoices"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_invoices_tenant_period" ON "platform_invoices"("tenant_id", "period_start") WHERE (status <> 'VOID');

-- CreateIndex
CREATE INDEX "platform_invoice_lines_tenant_id_invoice_id_idx" ON "platform_invoice_lines"("tenant_id", "invoice_id");

-- CreateIndex
CREATE INDEX "platform_payments_tenant_id_invoice_id_idx" ON "platform_payments"("tenant_id", "invoice_id");

-- AddForeignKey
ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_invoice_lines" ADD CONSTRAINT "platform_invoice_lines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_invoice_lines" ADD CONSTRAINT "platform_invoice_lines_tenant_id_invoice_id_fkey" FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "platform_invoices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_payments" ADD CONSTRAINT "platform_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_payments" ADD CONSTRAINT "platform_payments_tenant_id_invoice_id_fkey" FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "platform_invoices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_payments" ADD CONSTRAINT "platform_payments_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "platform_admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────── Constraints ───────────────────────────
ALTER TABLE "tenant_subscriptions"
  ADD CONSTRAINT tenant_subscriptions_billing_start_month
    CHECK (billing_starts_on IS NULL OR billing_starts_on = date_trunc('month', billing_starts_on)::date);

ALTER TABLE "platform_invoices"
  ADD CONSTRAINT platform_invoices_period
    CHECK (period_start = date_trunc('month', period_start)::date AND period_end >= period_start),
  ADD CONSTRAINT platform_invoices_due CHECK (due_on >= issued_on),
  ADD CONSTRAINT platform_invoices_amounts
    CHECK (total_paisa > 0 AND paid_paisa BETWEEN 0 AND total_paisa),
  ADD CONSTRAINT platform_invoices_paid CHECK (status <> 'PAID' OR paid_paisa = total_paisa),
  ADD CONSTRAINT platform_invoices_void
    CHECK ((status = 'VOID') = (voided_at IS NOT NULL)
       AND (status <> 'VOID' OR (paid_paisa = 0 AND char_length(void_reason) BETWEEN 3 AND 500)));

ALTER TABLE "platform_invoice_lines"
  ADD CONSTRAINT platform_invoice_lines_months CHECK (months IN (1, 12)),
  ADD CONSTRAINT platform_invoice_lines_amounts
    CHECK (CASE WHEN kind = 'DISCOUNT' THEN amount_paisa <= 0
                ELSE unit_paisa >= 0 AND amount_paisa >= 0 END),
  ADD CONSTRAINT platform_invoice_lines_students CHECK (active_students IS NULL OR active_students >= 0);

ALTER TABLE "platform_payments"
  ADD CONSTRAINT platform_payments_amount CHECK (amount_paisa > 0),
  ADD CONSTRAINT platform_payments_reference
    CHECK (reference IS NULL OR char_length(reference) BETWEEN 1 AND 100);

-- ─────────────────────────── RLS and grants ───────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform_invoices', 'platform_invoice_lines', 'platform_payments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = app_current_tenant_id())
         WITH CHECK (tenant_id = app_current_tenant_id())', t);
    -- The institute reads its own billing (the owner's overdue notice); it never writes it.
    EXECUTE format('GRANT SELECT ON %I TO jantrik_app', t);
    EXECUTE format('CREATE POLICY platform_read ON %I FOR SELECT TO jantrik_platform USING (true)', t);
    EXECUTE format('CREATE POLICY platform_insert ON %I FOR INSERT TO jantrik_platform WITH CHECK (true)', t);
  END LOOP;
END $$;
-- History: no DELETE for anyone; payments and lines are never changed either.
GRANT SELECT, INSERT, UPDATE ON platform_invoices TO jantrik_platform;
GRANT SELECT, INSERT ON platform_invoice_lines, platform_payments TO jantrik_platform;
CREATE POLICY platform_update ON platform_invoices FOR UPDATE TO jantrik_platform
  USING (true) WITH CHECK (true);

-- ─────────────────────────── Platform functions ───────────────────────────

-- The plan: pricing, cycle, days to pay, trial end and the first month invoiced (the limits are
-- separate). An institute without a plan row gets one. Audited on both sides.
CREATE FUNCTION platform_set_plan(
  p_tenant_id uuid, p_plan_name text, p_pricing text, p_core_paisa int, p_attendance_paisa int,
  p_fees_paisa int, p_exams_paisa int, p_flat_paisa int, p_cycle text,
  p_yearly_discount_percent int, p_due_days int, p_trial_ends_on date, p_billing_starts_on date,
  p_ip text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_admin uuid := public.app_current_platform_admin_id();
  v_old jsonb;
  v_new jsonb;
BEGIN
  PERFORM 1 FROM public.tenants WHERE id = p_tenant_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_NOT_FOUND'; END IF;
  SELECT to_jsonb(s) - 'id' - 'tenant_id' - 'created_at' - 'updated_at' - 'student_limit'
         - 'sms_daily_cap'
  INTO v_old FROM public.tenant_subscriptions s WHERE s.tenant_id = p_tenant_id FOR UPDATE;
  INSERT INTO public.tenant_subscriptions (
    id, tenant_id, plan_name, pricing, core_paisa, attendance_paisa, fees_paisa, exams_paisa,
    flat_paisa, cycle, yearly_discount_percent, due_days, trial_ends_on, billing_starts_on)
  VALUES (
    gen_random_uuid(), p_tenant_id, p_plan_name, p_pricing::public.plan_pricing, p_core_paisa,
    p_attendance_paisa, p_fees_paisa, p_exams_paisa, p_flat_paisa,
    p_cycle::public.billing_cycle, p_yearly_discount_percent, p_due_days, p_trial_ends_on,
    p_billing_starts_on)
  ON CONFLICT (tenant_id) DO UPDATE SET
    plan_name = excluded.plan_name, pricing = excluded.pricing,
    core_paisa = excluded.core_paisa, attendance_paisa = excluded.attendance_paisa,
    fees_paisa = excluded.fees_paisa, exams_paisa = excluded.exams_paisa,
    flat_paisa = excluded.flat_paisa, cycle = excluded.cycle,
    yearly_discount_percent = excluded.yearly_discount_percent, due_days = excluded.due_days,
    trial_ends_on = excluded.trial_ends_on, billing_starts_on = excluded.billing_starts_on,
    updated_at = now();
  SELECT to_jsonb(s) - 'id' - 'tenant_id' - 'created_at' - 'updated_at' - 'student_limit'
         - 'sms_daily_cap'
  INTO v_new FROM public.tenant_subscriptions s WHERE s.tenant_id = p_tenant_id;
  INSERT INTO public.platform_audit_logs (id, admin_id, actor, action, target_tenant_id, entity,
                                          entity_id, details, ip)
  VALUES (gen_random_uuid(), v_admin, 'ADMIN', 'INSTITUTE_PLAN', p_tenant_id,
          'tenant_subscription', p_tenant_id::text,
          jsonb_build_object('before', v_old, 'after', v_new), p_ip);
  INSERT INTO public.audit_logs (id, tenant_id, actor_user_id, entity, entity_id, action,
                                 old_values, new_values)
  VALUES (gen_random_uuid(), p_tenant_id, NULL, 'tenant_subscription', p_tenant_id, 'UPDATE',
          v_old, v_new || jsonb_build_object('via', 'platform', 'platformAdminId', v_admin));
END $$;

-- Invoices for one month (`p_month`: any day of it) for every institute that is ACTIVE, has a
-- plan, started billing by then and is due that month (monthly plans every month; yearly plans
-- in the month billing started and every 12 months after). Idempotent: one live invoice per
-- institute and period. Amounts are integer paisa from the active students counted now; yearly =
-- 12 months minus the plan's discount (a DISCOUNT line). `p_issued_on`: the issue date (default
-- today in the institute's timezone; never in the future). Returns {created, skipped: {reason: n}}.
CREATE FUNCTION platform_generate_invoices(p_month date, p_issued_on date, p_ip text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_admin uuid := public.app_current_platform_admin_id();
  v_period date := date_trunc('month', p_month)::date;
  r record;
  v_months int;
  v_active bigint;
  v_lines jsonb;
  v_subtotal bigint;
  v_discount bigint;
  v_total bigint;
  v_issued date;
  v_invoice uuid;
  v_reason text;
  v_created int := 0;
  v_skipped jsonb := '{}'::jsonb;
BEGIN
  IF p_month IS NULL THEN RAISE EXCEPTION 'PLATFORM_BAD_MONTH'; END IF;
  IF p_issued_on IS NOT NULL
     AND (p_issued_on > (now() AT TIME ZONE 'Asia/Dhaka')::date + 1
          OR p_issued_on < (now() AT TIME ZONE 'Asia/Dhaka')::date - 400) THEN
    RAISE EXCEPTION 'PLATFORM_BAD_DATE';
  END IF;
  FOR r IN
    SELECT t.id, t.status, t.timezone, s.plan_name, s.pricing, s.core_paisa, s.attendance_paisa,
           s.fees_paisa, s.exams_paisa, s.flat_paisa, s.cycle, s.yearly_discount_percent,
           s.due_days, s.billing_starts_on
    FROM public.tenants t
    LEFT JOIN public.tenant_subscriptions s ON s.tenant_id = t.id
    ORDER BY t.created_at, t.id
  LOOP
    v_months := CASE WHEN r.cycle = 'YEARLY' THEN 12 ELSE 1 END;
    v_reason := CASE
      WHEN r.status = 'TRIAL' THEN 'trial'
      WHEN r.status <> 'ACTIVE' THEN 'suspended'
      WHEN r.plan_name IS NULL THEN 'noPlan'
      WHEN r.billing_starts_on IS NULL OR r.billing_starts_on > v_period THEN 'notStarted'
      WHEN r.cycle = 'YEARLY'
           AND ((extract(year FROM v_period)::int - extract(year FROM r.billing_starts_on)::int) * 12
                + extract(month FROM v_period)::int - extract(month FROM r.billing_starts_on)::int)
               % 12 <> 0 THEN 'notDue'
      WHEN EXISTS (SELECT 1 FROM public.platform_invoices i
                   WHERE i.tenant_id = r.id AND i.period_start = v_period AND i.status <> 'VOID')
        THEN 'exists'
    END;
    IF v_reason IS NULL THEN
      SELECT count(*) INTO v_active FROM public.students st
      WHERE st.tenant_id = r.id AND st.status = 'ACTIVE' AND st.deleted_at IS NULL;
      IF r.pricing = 'FLAT' THEN
        v_lines := jsonb_build_array(
          jsonb_build_object('kind', 'FLAT', 'active', NULL, 'unit', r.flat_paisa, 'sort', 0));
      ELSE
        -- CORE always; the other modules while enabled.
        SELECT coalesce(jsonb_agg(jsonb_build_object('kind', m.k, 'active', v_active,
                                                     'unit', m.unit, 'sort', m.sort)
                                  ORDER BY m.sort), '[]'::jsonb)
        INTO v_lines
        FROM (VALUES ('CORE', r.core_paisa, 0), ('ATTENDANCE', r.attendance_paisa, 1),
                     ('FEES', r.fees_paisa, 2), ('EXAMS', r.exams_paisa, 3)) AS m(k, unit, sort)
        WHERE m.k = 'CORE'
           OR EXISTS (SELECT 1 FROM public.tenant_modules tm
                      WHERE tm.tenant_id = r.id AND tm.module_key::text = m.k AND tm.enabled);
      END IF;
      SELECT coalesce(sum((l->>'unit')::bigint * coalesce((l->>'active')::bigint, 1) * v_months), 0)
      INTO v_subtotal FROM jsonb_array_elements(v_lines) l;
      v_discount := CASE WHEN v_months = 12
                         THEN round(v_subtotal * r.yearly_discount_percent / 100.0)::bigint
                         ELSE 0 END;
      v_total := v_subtotal - v_discount;
      IF v_total <= 0 THEN
        v_reason := 'free';
      ELSIF v_subtotal > 2147483647 THEN
        RAISE EXCEPTION 'PLATFORM_AMOUNT_TOO_LARGE';
      END IF;
    END IF;
    IF v_reason IS NOT NULL THEN
      v_skipped := jsonb_set(v_skipped, ARRAY[v_reason],
                             to_jsonb(coalesce((v_skipped->>v_reason)::int, 0) + 1));
      CONTINUE;
    END IF;

    v_issued := coalesce(p_issued_on, (now() AT TIME ZONE r.timezone)::date);
    v_invoice := NULL;
    INSERT INTO public.platform_invoices (id, tenant_id, period_start, period_end, cycle,
                                          issued_on, due_on, total_paisa)
    VALUES (gen_random_uuid(), r.id, v_period,
            (v_period + make_interval(months => v_months) - interval '1 day')::date, r.cycle,
            v_issued, v_issued + r.due_days, v_total)
    ON CONFLICT (tenant_id, period_start) WHERE status <> 'VOID' DO NOTHING
    RETURNING id INTO v_invoice;
    IF v_invoice IS NULL THEN -- issued meanwhile by another admin
      v_skipped := jsonb_set(v_skipped, ARRAY['exists'],
                             to_jsonb(coalesce((v_skipped->>'exists')::int, 0) + 1));
      CONTINUE;
    END IF;
    INSERT INTO public.platform_invoice_lines (id, tenant_id, invoice_id, kind, active_students,
                                               unit_paisa, months, amount_paisa, sort_order)
    SELECT gen_random_uuid(), r.id, v_invoice, (l->>'kind')::public.invoice_line_kind,
           (l->>'active')::int, (l->>'unit')::int, v_months,
           ((l->>'unit')::bigint * coalesce((l->>'active')::bigint, 1) * v_months)::int,
           (l->>'sort')::int
    FROM jsonb_array_elements(v_lines) l;
    IF v_discount > 0 THEN
      INSERT INTO public.platform_invoice_lines (id, tenant_id, invoice_id, kind, active_students,
                                                 unit_paisa, months, amount_paisa, sort_order)
      VALUES (gen_random_uuid(), r.id, v_invoice, 'DISCOUNT', NULL, 0, 12, -v_discount, 9);
    END IF;
    INSERT INTO public.platform_audit_logs (id, admin_id, actor, action, target_tenant_id, entity,
                                            entity_id, details, ip)
    VALUES (gen_random_uuid(), v_admin, 'ADMIN', 'INVOICE_ISSUE', r.id, 'platform_invoice',
            v_invoice::text,
            jsonb_build_object('periodStart', v_period, 'totalPaisa', v_total,
                               'issuedOn', v_issued, 'activeStudents', v_active), p_ip);
    INSERT INTO public.audit_logs (id, tenant_id, actor_user_id, entity, entity_id, action,
                                   new_values)
    VALUES (gen_random_uuid(), r.id, NULL, 'platform_invoice', v_invoice, 'CREATE',
            jsonb_build_object('periodStart', v_period, 'totalPaisa', v_total,
                               'issuedOn', v_issued, 'via', 'platform',
                               'platformAdminId', v_admin));
    v_created := v_created + 1;
  END LOOP;
  INSERT INTO public.platform_audit_logs (id, admin_id, actor, action, entity, details, ip)
  VALUES (gen_random_uuid(), v_admin, 'ADMIN', 'INVOICES_GENERATE', 'platform_invoice',
          jsonb_build_object('month', v_period, 'created', v_created, 'skipped', v_skipped), p_ip);
  RETURN jsonb_build_object('created', v_created, 'skipped', v_skipped);
END $$;

-- A payment (part or all of what is left). The invoice is PAID once payments reach its total.
CREATE FUNCTION platform_record_payment(p_invoice_id uuid, p_amount_paisa int, p_method text,
                                        p_reference text, p_paid_on date, p_ip text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_admin uuid := public.app_current_platform_admin_id();
  v_inv public.platform_invoices%ROWTYPE;
  v_tz text;
  v_payment uuid := gen_random_uuid();
  v_paid int;
BEGIN
  SELECT * INTO v_inv FROM public.platform_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_NOT_FOUND'; END IF;
  IF v_inv.status <> 'ISSUED' THEN RAISE EXCEPTION 'PLATFORM_INVOICE_CLOSED'; END IF;
  IF p_amount_paisa IS NULL OR p_amount_paisa < 1
     OR p_amount_paisa > v_inv.total_paisa - v_inv.paid_paisa THEN
    RAISE EXCEPTION 'PLATFORM_BAD_AMOUNT';
  END IF;
  SELECT timezone INTO v_tz FROM public.tenants WHERE id = v_inv.tenant_id;
  IF p_paid_on IS NULL OR p_paid_on > (now() AT TIME ZONE v_tz)::date THEN
    RAISE EXCEPTION 'PLATFORM_BAD_DATE';
  END IF;
  INSERT INTO public.platform_payments (id, tenant_id, invoice_id, amount_paisa, method,
                                        reference, paid_on, recorded_by_id)
  VALUES (v_payment, v_inv.tenant_id, v_inv.id, p_amount_paisa, p_method::public.payment_method,
          nullif(btrim(p_reference), ''), p_paid_on, v_admin);
  v_paid := v_inv.paid_paisa + p_amount_paisa;
  UPDATE public.platform_invoices
  SET paid_paisa = v_paid,
      status = CASE WHEN v_paid = total_paisa THEN 'PAID'::public.invoice_status ELSE status END,
      updated_at = now()
  WHERE id = v_inv.id;
  INSERT INTO public.platform_audit_logs (id, admin_id, actor, action, target_tenant_id, entity,
                                          entity_id, details, ip)
  VALUES (gen_random_uuid(), v_admin, 'ADMIN', 'PAYMENT_RECORD', v_inv.tenant_id,
          'platform_invoice', v_inv.id::text,
          jsonb_build_object('paymentId', v_payment, 'amountPaisa', p_amount_paisa,
                             'method', p_method, 'paidOn', p_paid_on,
                             'paidPaisa', v_paid, 'totalPaisa', v_inv.total_paisa), p_ip);
  INSERT INTO public.audit_logs (id, tenant_id, actor_user_id, entity, entity_id, action,
                                 old_values, new_values)
  VALUES (gen_random_uuid(), v_inv.tenant_id, NULL, 'platform_invoice', v_inv.id, 'UPDATE',
          jsonb_build_object('paidPaisa', v_inv.paid_paisa, 'status', v_inv.status),
          jsonb_build_object('paidPaisa', v_paid, 'payment', p_amount_paisa,
                             'method', p_method, 'paidOn', p_paid_on, 'via', 'platform',
                             'platformAdminId', v_admin));
END $$;

-- Void an invoice nobody has paid anything on (a reason is required). The period can then be
-- invoiced again.
CREATE FUNCTION platform_void_invoice(p_invoice_id uuid, p_reason text, p_ip text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_admin uuid := public.app_current_platform_admin_id();
  v_inv public.platform_invoices%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 3 OR char_length(p_reason) > 500 THEN
    RAISE EXCEPTION 'PLATFORM_REASON_REQUIRED';
  END IF;
  SELECT * INTO v_inv FROM public.platform_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_NOT_FOUND'; END IF;
  IF v_inv.status <> 'ISSUED' THEN RAISE EXCEPTION 'PLATFORM_INVOICE_CLOSED'; END IF;
  IF v_inv.paid_paisa > 0 THEN RAISE EXCEPTION 'PLATFORM_INVOICE_HAS_PAYMENTS'; END IF;
  UPDATE public.platform_invoices
  SET status = 'VOID', void_reason = btrim(p_reason), voided_at = now(), updated_at = now()
  WHERE id = v_inv.id;
  INSERT INTO public.platform_audit_logs (id, admin_id, actor, action, target_tenant_id, entity,
                                          entity_id, details, ip)
  VALUES (gen_random_uuid(), v_admin, 'ADMIN', 'INVOICE_VOID', v_inv.tenant_id,
          'platform_invoice', v_inv.id::text,
          jsonb_build_object('reason', btrim(p_reason), 'totalPaisa', v_inv.total_paisa,
                             'periodStart', v_inv.period_start), p_ip);
  INSERT INTO public.audit_logs (id, tenant_id, actor_user_id, entity, entity_id, action,
                                 old_values, new_values)
  VALUES (gen_random_uuid(), v_inv.tenant_id, NULL, 'platform_invoice', v_inv.id, 'UPDATE',
          jsonb_build_object('status', v_inv.status),
          jsonb_build_object('status', 'VOID', 'reason', btrim(p_reason), 'via', 'platform',
                             'platformAdminId', v_admin));
END $$;

-- Invoices, newest first, optionally of one institute / status / month / overdue only.
CREATE FUNCTION platform_list_invoices(p_tenant_id uuid, p_status text, p_overdue boolean,
                                       p_period date, p_offset int, p_limit int)
RETURNS TABLE (id uuid, tenant_id uuid, tenant_name text, tenant_slug text, period_start date,
               period_end date, cycle text, issued_on date, due_on date, status text,
               total_paisa int, paid_paisa int, overdue boolean, total bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT i.id, i.tenant_id, t.name, t.slug, i.period_start, i.period_end, i.cycle::text,
         i.issued_on, i.due_on, i.status::text, i.total_paisa, i.paid_paisa,
         (i.status = 'ISSUED' AND i.due_on < (now() AT TIME ZONE t.timezone)::date),
         count(*) OVER ()
  FROM public.platform_invoices i
  JOIN public.tenants t ON t.id = i.tenant_id
  WHERE public.app_current_platform_admin_id() IS NOT NULL
    AND (p_tenant_id IS NULL OR i.tenant_id = p_tenant_id)
    AND (p_status IS NULL OR i.status::text = p_status)
    AND (p_period IS NULL OR i.period_start = date_trunc('month', p_period)::date)
    AND (NOT coalesce(p_overdue, false)
         OR (i.status = 'ISSUED' AND i.due_on < (now() AT TIME ZONE t.timezone)::date))
  ORDER BY i.issued_on DESC, i.created_at DESC, i.id DESC
  OFFSET greatest(coalesce(p_offset, 0), 0)
  LIMIT least(greatest(coalesce(p_limit, 25), 1), 100)
$$;

-- One invoice with its lines and payments. Raises PLATFORM_NOT_FOUND.
CREATE FUNCTION platform_get_invoice(p_invoice_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v jsonb;
  v_admin uuid := public.app_current_platform_admin_id();
BEGIN
  SELECT jsonb_build_object(
    'id', i.id, 'tenant', jsonb_build_object('id', t.id, 'name', t.name, 'slug', t.slug),
    'periodStart', i.period_start, 'periodEnd', i.period_end, 'cycle', i.cycle,
    'issuedOn', i.issued_on, 'dueOn', i.due_on, 'status', i.status,
    'totalPaisa', i.total_paisa, 'paidPaisa', i.paid_paisa,
    'overdue', (i.status = 'ISSUED' AND i.due_on < (now() AT TIME ZONE t.timezone)::date),
    'voidReason', i.void_reason, 'voidedAt', i.voided_at,
    'lines', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                'kind', l.kind, 'activeStudents', l.active_students, 'unitPaisa', l.unit_paisa,
                'months', l.months, 'amountPaisa', l.amount_paisa) ORDER BY l.sort_order), '[]'::jsonb)
              FROM public.platform_invoice_lines l WHERE l.invoice_id = i.id),
    'payments', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                   'id', p.id, 'amountPaisa', p.amount_paisa, 'method', p.method,
                   'reference', p.reference, 'paidOn', p.paid_on, 'recordedBy', a.name,
                   'createdAt', p.created_at) ORDER BY p.created_at), '[]'::jsonb)
                 FROM public.platform_payments p
                 LEFT JOIN public.platform_admins a ON a.id = p.recorded_by_id
                 WHERE p.invoice_id = i.id))
  INTO v
  FROM public.platform_invoices i
  JOIN public.tenants t ON t.id = i.tenant_id
  WHERE i.id = p_invoice_id AND v_admin IS NOT NULL;
  IF v IS NULL THEN RAISE EXCEPTION 'PLATFORM_NOT_FOUND'; END IF;
  RETURN v;
END $$;

-- The institute list gets an overdue filter (a new signature: drop the old one as its owner).
SET ROLE jantrik_platform;
DROP FUNCTION platform_list_institutes(text, text, text, text, boolean, integer, integer);
RESET ROLE;

-- One page of institutes, newest first, with the owner, two counts and what is overdue. `p_search` matches the
-- name or slug (LIKE wildcards in it are literal). `total` is the count before paging.
CREATE FUNCTION platform_list_institutes(p_search text, p_type text, p_status text, p_plan text,
                                         p_trial_ended boolean, p_overdue boolean, p_offset int,
                                         p_limit int)
RETURNS TABLE (id uuid, name text, slug text, type_key text, type_name_bn text, type_name_en text,
               status text, plan_name text, trial_ends_on date, created_at timestamptz,
               owner_name text, owner_name_bn text, owner_phone text, owner_status text,
               owner_invited_at timestamptz, active_students bigint, sms_this_month bigint,
               overdue_count bigint, overdue_paisa bigint, total bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH q AS (
    SELECT CASE WHEN nullif(btrim(p_search), '') IS NULL THEN NULL
                ELSE '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%'
           END AS pattern
  ), page AS (
    SELECT t.id, t.name, t.slug, it.key AS type_key, it.name_bn AS type_name_bn,
           it.name_en AS type_name_en, t.status::text AS status, s.plan_name, s.trial_ends_on,
           t.created_at, t.timezone, count(*) OVER () AS total
    FROM public.tenants t
    JOIN public.institute_types it ON it.id = t.institute_type_id
    LEFT JOIN public.tenant_subscriptions s ON s.tenant_id = t.id
    CROSS JOIN q
    WHERE public.app_current_platform_admin_id() IS NOT NULL
      AND (q.pattern IS NULL OR t.name ILIKE q.pattern OR t.slug ILIKE q.pattern)
      AND (p_type IS NULL OR it.key = p_type)
      AND (p_status IS NULL OR t.status::text = p_status)
      AND (p_plan IS NULL OR s.plan_name = p_plan)
      AND (NOT coalesce(p_trial_ended, false)
           OR (t.status = 'TRIAL' AND s.trial_ends_on < (now() AT TIME ZONE t.timezone)::date))
      AND (NOT coalesce(p_overdue, false)
           OR EXISTS (SELECT 1 FROM public.platform_invoices i
                      WHERE i.tenant_id = t.id AND i.status = 'ISSUED'
                        AND i.due_on < (now() AT TIME ZONE t.timezone)::date))
    ORDER BY t.created_at DESC, t.id DESC
    OFFSET greatest(coalesce(p_offset, 0), 0)
    LIMIT least(greatest(coalesce(p_limit, 25), 1), 100)
  )
  SELECT p.id, p.name, p.slug, p.type_key, p.type_name_bn, p.type_name_en, p.status, p.plan_name,
         p.trial_ends_on, p.created_at, o.name, o.name_bn, o.phone, o.status, o.invited_at,
         (SELECT count(*) FROM public.students st
          WHERE st.tenant_id = p.id AND st.status = 'ACTIVE' AND st.deleted_at IS NULL),
         (SELECT count(*) FROM public.sms_logs l
          WHERE l.tenant_id = p.id AND l.status IN ('QUEUED', 'SENT')
            AND l.local_date >= date_trunc('month', now() AT TIME ZONE p.timezone)::date),
         b.overdue_count, b.overdue_paisa,
         p.total
  FROM page p
  LEFT JOIN LATERAL (
    -- The owner shown: an active one first, else the latest invitation.
    SELECT sp.name, sp.name_bn, sp.phone, m.status::text AS status, m.invited_at
    FROM public.memberships m
    LEFT JOIN public.staff_profiles sp ON sp.tenant_id = m.tenant_id AND sp.user_id = m.user_id
    WHERE m.tenant_id = p.id AND m.role = 'OWNER'
    ORDER BY (m.status = 'ACTIVE') DESC, m.invited_at DESC NULLS LAST, m.created_at
    LIMIT 1
  ) o ON true
  CROSS JOIN LATERAL (
    SELECT count(*) AS overdue_count, coalesce(sum(i.total_paisa - i.paid_paisa), 0) AS overdue_paisa
    FROM public.platform_invoices i
    WHERE i.tenant_id = p.id AND i.status = 'ISSUED'
      AND i.due_on < (now() AT TIME ZONE p.timezone)::date
  ) b
  ORDER BY p.created_at DESC, p.id DESC
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'platform_set_plan(uuid, text, text, integer, integer, integer, integer, integer, text, integer, integer, date, date, text)',
    'platform_generate_invoices(date, date, text)',
    'platform_record_payment(uuid, integer, text, text, date, text)',
    'platform_void_invoice(uuid, text, text)',
    'platform_list_invoices(uuid, text, boolean, date, integer, integer)',
    'platform_get_invoice(uuid)',
    'platform_list_institutes(text, text, text, text, boolean, boolean, integer, integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO jantrik_platform_app', f);
    EXECUTE format('ALTER FUNCTION %s OWNER TO jantrik_platform', f);
  END LOOP;
END $$;

-- Replaced in place by their owner (grants and settings are kept).
SET ROLE jantrik_platform;

-- One institute: metadata, modules, plan and limits, billing, owners, counts. Raises
-- PLATFORM_NOT_FOUND. (Part 3: billing start, open and overdue invoices.)
CREATE OR REPLACE FUNCTION platform_get_institute(p_tenant_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v jsonb;
  v_admin uuid := public.app_current_platform_admin_id();
BEGIN
  SELECT jsonb_build_object(
    'id', t.id, 'name', t.name, 'slug', t.slug, 'status', t.status,
    'suspendedFrom', t.suspended_from, 'suspendedAt', t.suspended_at,
    'timezone', t.timezone, 'defaultLocale', t.default_locale, 'createdAt', t.created_at,
    'type', jsonb_build_object('key', it.key, 'nameBn', it.name_bn, 'nameEn', it.name_en),
    'modules', (SELECT coalesce(jsonb_agg(jsonb_build_object('key', m.module_key,
                                                           'enabled', m.enabled,
                                                           'enabledAt', m.enabled_at)
                                          ORDER BY m.module_key), '[]'::jsonb)
                FROM public.tenant_modules m WHERE m.tenant_id = t.id),
    'subscription', (SELECT jsonb_build_object(
                       'planName', s.plan_name, 'pricing', s.pricing, 'corePaisa', s.core_paisa,
                       'attendancePaisa', s.attendance_paisa, 'feesPaisa', s.fees_paisa,
                       'examsPaisa', s.exams_paisa, 'flatPaisa', s.flat_paisa, 'cycle', s.cycle,
                       'yearlyDiscountPercent', s.yearly_discount_percent, 'dueDays', s.due_days,
                       'trialEndsOn', s.trial_ends_on, 'studentLimit', s.student_limit,
                       'smsDailyCap', s.sms_daily_cap,
                       'billingStartsOn', s.billing_starts_on)
                     FROM public.tenant_subscriptions s WHERE s.tenant_id = t.id),
    'owners', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                       'userId', m.user_id, 'name', sp.name, 'nameBn', sp.name_bn,
                       'phone', sp.phone, 'status', m.status, 'invitedAt', m.invited_at)
                     ORDER BY (m.status = 'ACTIVE') DESC, m.invited_at DESC NULLS LAST,
                              m.created_at), '[]'::jsonb)
               FROM public.memberships m
               LEFT JOIN public.staff_profiles sp
                 ON sp.tenant_id = m.tenant_id AND sp.user_id = m.user_id
               WHERE m.tenant_id = t.id AND m.role = 'OWNER'),
    'billing', (SELECT jsonb_build_object(
                  'openCount', count(*),
                  'openPaisa', coalesce(sum(i.total_paisa - i.paid_paisa), 0),
                  'overdueCount', count(*) FILTER (WHERE i.due_on < (now() AT TIME ZONE t.timezone)::date),
                  'overduePaisa', coalesce(sum(i.total_paisa - i.paid_paisa)
                                    FILTER (WHERE i.due_on < (now() AT TIME ZONE t.timezone)::date), 0))
                FROM public.platform_invoices i
                WHERE i.tenant_id = t.id AND i.status = 'ISSUED'),
    'counts', jsonb_build_object(
      'activeStudents', (SELECT count(*) FROM public.students st
                         WHERE st.tenant_id = t.id AND st.status = 'ACTIVE'
                           AND st.deleted_at IS NULL),
      'activeStaff', (SELECT count(DISTINCT m.user_id) FROM public.memberships m
                      WHERE m.tenant_id = t.id AND m.status = 'ACTIVE'
                        AND m.role NOT IN ('GUARDIAN', 'STUDENT')),
      'smsThisMonth', (SELECT count(*) FROM public.sms_logs l
                       WHERE l.tenant_id = t.id AND l.status IN ('QUEUED', 'SENT')
                         AND l.local_date >= date_trunc('month', now() AT TIME ZONE t.timezone)::date),
      'smsSegmentsThisMonth', (SELECT coalesce(sum(l.segments), 0) FROM public.sms_logs l
                               WHERE l.tenant_id = t.id AND l.status IN ('QUEUED', 'SENT')
                                 AND l.local_date >= date_trunc('month', now() AT TIME ZONE t.timezone)::date),
      'importsThisMonth', (SELECT count(*) FROM public.student_imports i
                           WHERE i.tenant_id = t.id
                             AND i.created_at >= date_trunc('month', now() AT TIME ZONE t.timezone)
                                                   AT TIME ZONE t.timezone),
      'importsTotal', (SELECT count(*) FROM public.student_imports i WHERE i.tenant_id = t.id),
      'lastActivityAt', greatest(
        (SELECT max(a.created_at) FROM public.audit_logs a WHERE a.tenant_id = t.id),
        (SELECT max(s.updated_at) FROM public.attendance_sessions s WHERE s.tenant_id = t.id),
        (SELECT max(l.created_at) FROM public.sms_logs l WHERE l.tenant_id = t.id),
        (SELECT max(i.created_at) FROM public.student_imports i WHERE i.tenant_id = t.id))))
  INTO v
  FROM public.tenants t
  JOIN public.institute_types it ON it.id = t.institute_type_id
  WHERE t.id = p_tenant_id AND v_admin IS NOT NULL;
  IF v IS NULL THEN RAISE EXCEPTION 'PLATFORM_NOT_FOUND'; END IF;
  RETURN v;
END $$;

-- SUSPEND (from TRIAL or ACTIVE), REACTIVATE (back to the status it had) or ACTIVATE (TRIAL →
-- ACTIVE, part 3). Access ends or returns on the institute's next request. A reason is required;
-- both audit logs get it.
CREATE OR REPLACE FUNCTION platform_set_institute_status(p_tenant_id uuid, p_action text, p_reason text,
                                              p_ip text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_admin uuid := public.app_current_platform_admin_id();
  v_old public.tenant_status;
  v_from public.tenant_status;
  v_new public.tenant_status;
  v_tz text;
  v_billing date;
BEGIN
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 3 OR char_length(p_reason) > 500 THEN
    RAISE EXCEPTION 'PLATFORM_REASON_REQUIRED';
  END IF;
  SELECT status, suspended_from, timezone INTO v_old, v_from, v_tz
  FROM public.tenants WHERE id = p_tenant_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_NOT_FOUND'; END IF;
  IF p_action = 'SUSPEND' THEN
    IF v_old NOT IN ('TRIAL', 'ACTIVE') THEN RAISE EXCEPTION 'PLATFORM_BAD_STATUS'; END IF;
    v_new := 'SUSPENDED';
    UPDATE public.tenants
    SET status = v_new, suspended_from = v_old, suspended_at = now(), updated_at = now()
    WHERE id = p_tenant_id;
  ELSIF p_action = 'REACTIVATE' THEN
    IF v_old <> 'SUSPENDED' THEN RAISE EXCEPTION 'PLATFORM_BAD_STATUS'; END IF;
    v_new := coalesce(v_from, 'ACTIVE');
    UPDATE public.tenants
    SET status = v_new, suspended_from = NULL, suspended_at = NULL, updated_at = now()
    WHERE id = p_tenant_id;
  ELSIF p_action = 'ACTIVATE' THEN
    -- The trial is over: invoices start with the next month (unless the plan says otherwise).
    IF v_old <> 'TRIAL' THEN RAISE EXCEPTION 'PLATFORM_BAD_STATUS'; END IF;
    v_new := 'ACTIVE';
    UPDATE public.tenants SET status = v_new, updated_at = now() WHERE id = p_tenant_id;
    v_billing := (date_trunc('month', now() AT TIME ZONE v_tz) + interval '1 month')::date;
    UPDATE public.tenant_subscriptions
    SET billing_starts_on = v_billing, updated_at = now()
    WHERE tenant_id = p_tenant_id AND billing_starts_on IS NULL;
  ELSE
    RAISE EXCEPTION 'PLATFORM_BAD_ACTION';
  END IF;
  INSERT INTO public.platform_audit_logs (id, admin_id, actor, action, target_tenant_id, entity,
                                          entity_id, details, ip)
  VALUES (gen_random_uuid(), v_admin, 'ADMIN', 'INSTITUTE_' || p_action, p_tenant_id, 'tenant',
          p_tenant_id::text,
          jsonb_build_object('from', v_old, 'to', v_new, 'reason', p_reason), p_ip);
  INSERT INTO public.audit_logs (id, tenant_id, actor_user_id, entity, entity_id, action,
                                 old_values, new_values)
  VALUES (gen_random_uuid(), p_tenant_id, NULL, 'tenant', p_tenant_id, 'UPDATE',
          jsonb_build_object('status', v_old),
          jsonb_build_object('status', v_new, 'reason', p_reason, 'via', 'platform',
                             'platformAdminId', v_admin));
  RETURN v_new::text;
END $$;

RESET ROLE;
