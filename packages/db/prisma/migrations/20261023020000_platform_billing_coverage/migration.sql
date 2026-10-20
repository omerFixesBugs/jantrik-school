-- Step 8, part 3, second review: a month counts as invoiced when any live invoice overlaps the new
-- invoice's whole range, and a yearly invoice can start in any month that is not covered (the
-- "right after the previous one" rule could stop a yearly plan for good after one skipped
-- month). Only institutes that may be invoiced are locked, and they are re-read under the lock.

SET ROLE jantrik_platform;

-- Invoices for one month (`p_month`: any day of it, at most next month) for every institute that
-- is ACTIVE, has a plan, started billing by then, and has no live invoice overlapping the new
-- invoice's whole range (a month, or 12 on a yearly plan): those months are invoiced already.
-- A yearly invoice can start in any month that is not covered, so a skipped month (no students
-- yet, suspended) only moves the year, and a change of cycle never bills a month twice.
-- Idempotent. Only institutes that may be invoiced are locked, and re-read under the lock.
CREATE OR REPLACE FUNCTION platform_generate_invoices(p_month date, p_issued_on date, p_ip text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_admin uuid := public.app_current_platform_admin_id();
  v_period date := date_trunc('month', p_month)::date;
  r record;
  c record;
  v_months int;
  v_end date;
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
    -- A quick look first (no lock): trial, suspended or without a plan is skipped at once.
    v_reason := CASE
      WHEN r.status = 'TRIAL' THEN 'trial'
      WHEN r.status <> 'ACTIVE' THEN 'suspended'
      WHEN r.plan_name IS NULL THEN 'noPlan'
    END;
    IF v_reason IS NULL THEN
      -- A candidate: lock it and decide on its current state (a change committed meanwhile counts).
      SELECT t.id, t.status, t.timezone, s.plan_name, s.pricing, s.core_paisa, s.attendance_paisa,
             s.fees_paisa, s.exams_paisa, s.flat_paisa, s.cycle, s.yearly_discount_percent,
             s.due_days, s.billing_starts_on
      INTO c
      FROM public.tenants t
      LEFT JOIN public.tenant_subscriptions s ON s.tenant_id = t.id
      WHERE t.id = r.id
      FOR NO KEY UPDATE OF t;
      v_months := CASE WHEN c.cycle = 'YEARLY' THEN 12 ELSE 1 END;
      v_end := (v_period + make_interval(months => v_months) - interval '1 day')::date;
      v_reason := CASE
        WHEN c.status = 'TRIAL' THEN 'trial'
        WHEN c.status <> 'ACTIVE' THEN 'suspended'
        WHEN c.plan_name IS NULL THEN 'noPlan'
        WHEN c.billing_starts_on IS NULL OR c.billing_starts_on > v_period THEN 'notStarted'
        WHEN EXISTS (SELECT 1 FROM public.platform_invoices i
                     WHERE i.tenant_id = c.id AND i.status <> 'VOID'
                       AND i.period_start <= v_end AND i.period_end >= v_period) THEN 'exists'
      END;
    END IF;
    IF v_reason IS NULL THEN
      SELECT count(*) INTO v_active FROM public.students st
      WHERE st.tenant_id = c.id AND st.status = 'ACTIVE' AND st.deleted_at IS NULL;
      IF c.pricing = 'FLAT' THEN
        v_lines := jsonb_build_array(
          jsonb_build_object('kind', 'FLAT', 'active', NULL, 'unit', c.flat_paisa, 'sort', 0));
      ELSE
        -- CORE always; the other modules while enabled.
        SELECT coalesce(jsonb_agg(jsonb_build_object('kind', m.k, 'active', v_active,
                                                     'unit', m.unit, 'sort', m.sort)
                                  ORDER BY m.sort), '[]'::jsonb)
        INTO v_lines
        FROM (VALUES ('CORE', c.core_paisa, 0), ('ATTENDANCE', c.attendance_paisa, 1),
                     ('FEES', c.fees_paisa, 2), ('EXAMS', c.exams_paisa, 3)) AS m(k, unit, sort)
        WHERE m.k = 'CORE'
           OR EXISTS (SELECT 1 FROM public.tenant_modules tm
                      WHERE tm.tenant_id = c.id AND tm.module_key::text = m.k AND tm.enabled);
      END IF;
      SELECT coalesce(sum((l->>'unit')::bigint * coalesce((l->>'active')::bigint, 1) * v_months), 0)
      INTO v_subtotal FROM jsonb_array_elements(v_lines) l;
      v_discount := CASE WHEN v_months = 12
                         THEN round(v_subtotal * c.yearly_discount_percent / 100.0)::bigint
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

    v_issued := coalesce(p_issued_on, (now() AT TIME ZONE c.timezone)::date);
    v_invoice := NULL;
    INSERT INTO public.platform_invoices (id, tenant_id, period_start, period_end, cycle,
                                          issued_on, due_on, total_paisa)
    VALUES (gen_random_uuid(), c.id, v_period,
            v_end, c.cycle,
            v_issued, v_issued + c.due_days, v_total)
    ON CONFLICT (tenant_id, period_start) WHERE status <> 'VOID' DO NOTHING
    RETURNING id INTO v_invoice;
    IF v_invoice IS NULL THEN -- issued meanwhile by another admin
      v_skipped := jsonb_set(v_skipped, ARRAY['exists'],
                             to_jsonb(coalesce((v_skipped->>'exists')::int, 0) + 1));
      CONTINUE;
    END IF;
    INSERT INTO public.platform_invoice_lines (id, tenant_id, invoice_id, kind, active_students,
                                               unit_paisa, months, amount_paisa, sort_order)
    SELECT gen_random_uuid(), c.id, v_invoice, (l->>'kind')::public.invoice_line_kind,
           (l->>'active')::int, (l->>'unit')::int, v_months,
           ((l->>'unit')::bigint * coalesce((l->>'active')::bigint, 1) * v_months)::int,
           (l->>'sort')::int
    FROM jsonb_array_elements(v_lines) l;
    IF v_discount > 0 THEN
      INSERT INTO public.platform_invoice_lines (id, tenant_id, invoice_id, kind, active_students,
                                                 unit_paisa, months, amount_paisa, sort_order)
      VALUES (gen_random_uuid(), c.id, v_invoice, 'DISCOUNT', NULL, 0, 12, -v_discount, 9);
    END IF;
    INSERT INTO public.platform_audit_logs (id, admin_id, actor, action, target_tenant_id, entity,
                                            entity_id, details, ip)
    VALUES (gen_random_uuid(), v_admin, 'ADMIN', 'INVOICE_ISSUE', c.id, 'platform_invoice',
            v_invoice::text,
            jsonb_build_object('periodStart', v_period, 'totalPaisa', v_total,
                               'issuedOn', v_issued, 'activeStudents', v_active), p_ip);
    INSERT INTO public.audit_logs (id, tenant_id, actor_user_id, entity, entity_id, action,
                                   new_values)
    VALUES (gen_random_uuid(), c.id, NULL, 'platform_invoice', v_invoice, 'CREATE',
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

RESET ROLE;
