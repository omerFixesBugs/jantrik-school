-- Step 8, part 3, after review:
--   * Generation skips a month a live invoice already covers (a yearly invoice covers 12), and
--     yearly plans continue from the end of the previous invoice: changing the cycle or the
--     billing start can no longer bill a month twice or leave a gap. Each institute is locked
--     while it is checked and invoiced.
--   * At most next month can be invoiced; the issue date is never in the future; one mispriced
--     institute is skipped (tooLarge) instead of failing everyone's run.
--   * A payment date at most a year before the invoice; the activation's billing start is in both
--     audit entries; the generation summary records the issue date.
--   * jantrik_platform may UPDATE only the invoice columns its functions change.

REVOKE UPDATE ON platform_invoices FROM jantrik_platform;
GRANT UPDATE (status, paid_paisa, void_reason, voided_at, updated_at) ON platform_invoices
  TO jantrik_platform;

-- Replaced by their owner (grants and settings are kept).
SET ROLE jantrik_platform;

-- Invoices for one month (`p_month`: any day of it, at most next month) for every institute that
-- is ACTIVE, has a plan, started billing by then, is not already covered by a live invoice (a
-- yearly one covers 12 months), and is due that month: monthly plans every month; yearly plans in
-- the month billing starts and then the month after the previous invoice ends (so a change of
-- cycle neither bills a month twice nor leaves a gap). Idempotent. Amounts are integer paisa from the active students counted now; yearly =
-- 12 months minus the plan's discount (a DISCOUNT line). `p_issued_on`: the issue date (default
-- today in the institute's timezone; never in the future). Returns {created, skipped: {reason: n}}.
CREATE OR REPLACE FUNCTION platform_generate_invoices(p_month date, p_issued_on date, p_ip text)
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
  IF p_month IS NULL
     OR v_period > (date_trunc('month', now() AT TIME ZONE 'Asia/Dhaka') + interval '1 month')::date THEN
    RAISE EXCEPTION 'PLATFORM_BAD_MONTH';
  END IF;
  IF p_issued_on IS NOT NULL
     AND (p_issued_on > (now() AT TIME ZONE 'Asia/Dhaka')::date
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
    -- One generation at a time per institute (the coverage checks below decide on locked state).
    PERFORM 1 FROM public.tenants WHERE id = r.id FOR NO KEY UPDATE;
    v_months := CASE WHEN r.cycle = 'YEARLY' THEN 12 ELSE 1 END;
    v_reason := CASE
      WHEN r.status = 'TRIAL' THEN 'trial'
      WHEN r.status <> 'ACTIVE' THEN 'suspended'
      WHEN r.plan_name IS NULL THEN 'noPlan'
      WHEN r.billing_starts_on IS NULL OR r.billing_starts_on > v_period THEN 'notStarted'
      WHEN EXISTS (SELECT 1 FROM public.platform_invoices i
                   WHERE i.tenant_id = r.id AND i.status <> 'VOID'
                     AND v_period BETWEEN i.period_start AND i.period_end) THEN 'exists'
      WHEN r.cycle = 'YEARLY' AND v_period <> r.billing_starts_on
           AND NOT EXISTS (SELECT 1 FROM public.platform_invoices i
                           WHERE i.tenant_id = r.id AND i.status <> 'VOID'
                             AND i.period_end = v_period - 1) THEN 'notDue'
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
        v_reason := 'tooLarge'; -- a mistyped price: skip it, the others still get theirs
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
          jsonb_build_object('month', v_period, 'issuedOn', p_issued_on, 'created', v_created,
                             'skipped', v_skipped), p_ip);
  RETURN jsonb_build_object('created', v_created, 'skipped', v_skipped);
END $$;

-- A payment (part or all of what is left). The invoice is PAID once payments reach its total.
CREATE OR REPLACE FUNCTION platform_record_payment(p_invoice_id uuid, p_amount_paisa int, p_method text,
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
  IF p_paid_on IS NULL OR p_paid_on > (now() AT TIME ZONE v_tz)::date
     OR p_paid_on < v_inv.issued_on - 366 THEN
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
    -- For the audit entries: the month billing starts (NULL without a plan row).
    SELECT billing_starts_on INTO v_billing FROM public.tenant_subscriptions
    WHERE tenant_id = p_tenant_id;
  ELSE
    RAISE EXCEPTION 'PLATFORM_BAD_ACTION';
  END IF;
  INSERT INTO public.platform_audit_logs (id, admin_id, actor, action, target_tenant_id, entity,
                                          entity_id, details, ip)
  VALUES (gen_random_uuid(), v_admin, 'ADMIN', 'INSTITUTE_' || p_action, p_tenant_id, 'tenant',
          p_tenant_id::text,
          jsonb_strip_nulls(jsonb_build_object('from', v_old, 'to', v_new, 'reason', p_reason,
                                               'billingStartsOn', v_billing)), p_ip);
  INSERT INTO public.audit_logs (id, tenant_id, actor_user_id, entity, entity_id, action,
                                 old_values, new_values)
  VALUES (gen_random_uuid(), p_tenant_id, NULL, 'tenant', p_tenant_id, 'UPDATE',
          jsonb_build_object('status', v_old),
          jsonb_build_object('status', v_new, 'reason', p_reason, 'billingStartsOn', v_billing,
                             'via', 'platform',
                             'platformAdminId', v_admin));
  RETURN v_new::text;
END $$;

RESET ROLE;
