-- Step 8, part 2: institutes from the platform side. See docs/platform.md.
--   * tenant_subscriptions: Jantrik's plan and limits per institute (tenant table: the institute
--     reads its own row; only the platform functions write it).
--   * tenants.suspended_from / suspended_at: suspension and the status to return to.
--   * Platform functions: list, detail, register (plan + audit after provisioning), status,
--     modules, limits. Every one needs a live platform session and audits its writes.
--   * jantrik_app loses UPDATE and DELETE on tenants and tenant_modules: an institute can never
--     un-suspend itself or switch a module on, even through a bug. Provisioning still INSERTs.
--   * jantrik_platform reads institute tables only through COLUMN grants: what counts need
--     (status, dates, segments), owner names and phones from staff_profiles, never a student's,
--     guardian's or SMS's content. A function body cannot leak what its owner cannot read.

-- CreateEnum
CREATE TYPE "plan_pricing" AS ENUM ('PER_STUDENT', 'FLAT');

-- CreateEnum
CREATE TYPE "billing_cycle" AS ENUM ('MONTHLY', 'YEARLY');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "suspended_at" TIMESTAMPTZ(3),
ADD COLUMN     "suspended_from" "tenant_status";

-- CreateTable
CREATE TABLE "tenant_subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_name" TEXT,
    "pricing" "plan_pricing" NOT NULL DEFAULT 'PER_STUDENT',
    "core_paisa" INTEGER NOT NULL DEFAULT 0,
    "attendance_paisa" INTEGER NOT NULL DEFAULT 0,
    "fees_paisa" INTEGER NOT NULL DEFAULT 0,
    "exams_paisa" INTEGER NOT NULL DEFAULT 0,
    "flat_paisa" INTEGER NOT NULL DEFAULT 0,
    "cycle" "billing_cycle" NOT NULL DEFAULT 'MONTHLY',
    "yearly_discount_percent" SMALLINT NOT NULL DEFAULT 0,
    "due_days" SMALLINT NOT NULL DEFAULT 10,
    "trial_ends_on" DATE,
    "student_limit" INTEGER,
    "sms_daily_cap" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_subscriptions_tenant_id_key" ON "tenant_subscriptions"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_subscriptions_tenant_id_id_key" ON "tenant_subscriptions"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────── Constraints ───────────────────────────
ALTER TABLE "tenants"
  ADD CONSTRAINT tenants_suspended_from
    CHECK (suspended_from IS NULL OR (status = 'SUSPENDED' AND suspended_from IN ('TRIAL', 'ACTIVE')));

ALTER TABLE "tenant_subscriptions"
  ADD CONSTRAINT tenant_subscriptions_plan_name_length
    CHECK (plan_name IS NULL OR char_length(plan_name) BETWEEN 1 AND 60),
  ADD CONSTRAINT tenant_subscriptions_prices
    CHECK (core_paisa BETWEEN 0 AND 100000000 AND attendance_paisa BETWEEN 0 AND 100000000
       AND fees_paisa BETWEEN 0 AND 100000000 AND exams_paisa BETWEEN 0 AND 100000000
       AND flat_paisa BETWEEN 0 AND 100000000),
  ADD CONSTRAINT tenant_subscriptions_discount CHECK (yearly_discount_percent BETWEEN 0 AND 100),
  ADD CONSTRAINT tenant_subscriptions_due_days CHECK (due_days BETWEEN 1 AND 90),
  ADD CONSTRAINT tenant_subscriptions_student_limit
    CHECK (student_limit IS NULL OR student_limit BETWEEN 1 AND 1000000),
  ADD CONSTRAINT tenant_subscriptions_sms_daily_cap
    CHECK (sms_daily_cap IS NULL OR sms_daily_cap BETWEEN 0 AND 1000000);

-- ─────────────────────────── RLS and grants ───────────────────────────
ALTER TABLE tenant_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_subscriptions
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
-- The institute reads its own plan and limits; it never writes them.
GRANT SELECT ON tenant_subscriptions TO jantrik_app;

-- An institute can no longer change its own status or modules (the platform does).
REVOKE UPDATE, DELETE ON tenants FROM jantrik_app;
REVOKE UPDATE, DELETE ON tenant_modules FROM jantrik_app;

-- jantrik_platform (owner of the platform functions): reads for metadata and counts, by column.
GRANT SELECT ON institute_types TO jantrik_platform; -- global reference data, no RLS
GRANT UPDATE (status, suspended_from, suspended_at, updated_at) ON tenants TO jantrik_platform;
CREATE POLICY platform_update ON tenants FOR UPDATE TO jantrik_platform USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON tenant_modules, tenant_subscriptions TO jantrik_platform;
GRANT SELECT (tenant_id, user_id, role, status, invited_at, created_at) ON memberships TO jantrik_platform;
GRANT SELECT (tenant_id, user_id, name, name_bn, phone) ON staff_profiles TO jantrik_platform;
GRANT SELECT (tenant_id, status, deleted_at) ON students TO jantrik_platform;
GRANT SELECT (tenant_id, status, segments, local_date, created_at) ON sms_logs TO jantrik_platform;
GRANT SELECT (tenant_id, status, created_at) ON student_imports TO jantrik_platform;
GRANT SELECT (tenant_id, updated_at) ON attendance_sessions TO jantrik_platform;
-- The institute's own audit trail of platform actions (no actor: not an institute user).
GRANT SELECT (tenant_id, created_at), INSERT ON audit_logs TO jantrik_platform;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_modules', 'tenant_subscriptions', 'memberships', 'staff_profiles', 'students',
    'sms_logs', 'student_imports', 'attendance_sessions', 'audit_logs'
  ] LOOP
    EXECUTE format('CREATE POLICY platform_read ON %I FOR SELECT TO jantrik_platform USING (true)', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['tenant_modules', 'tenant_subscriptions'] LOOP
    EXECUTE format('CREATE POLICY platform_insert ON %I FOR INSERT TO jantrik_platform WITH CHECK (true)', t);
    EXECUTE format('CREATE POLICY platform_update ON %I FOR UPDATE TO jantrik_platform USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
CREATE POLICY platform_insert ON audit_logs FOR INSERT TO jantrik_platform
  WITH CHECK (actor_user_id IS NULL);

-- ─────────────────────────── Platform functions ───────────────────────────
-- Same rules as part 1: owned by jantrik_platform, pinned search_path with pg_temp last, tables
-- named with `public.`, a live platform session required (app_current_platform_admin_id()).

-- Choices for the create form and the list filters.
CREATE FUNCTION platform_institute_options() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object(
    'types', (SELECT coalesce(jsonb_agg(jsonb_build_object('key', it.key, 'nameBn', it.name_bn,
                                                          'nameEn', it.name_en)
                                        ORDER BY it.sort_order, it.key), '[]'::jsonb)
              FROM public.institute_types it WHERE it.is_active),
    'plans', (SELECT coalesce(jsonb_agg(DISTINCT s.plan_name), '[]'::jsonb)
              FROM public.tenant_subscriptions s WHERE s.plan_name IS NOT NULL))
  WHERE public.app_current_platform_admin_id() IS NOT NULL
$$;

-- One page of institutes, newest first, with the owner and two counts. `p_search` matches the
-- name or slug (LIKE wildcards in it are literal). `total` is the count before paging.
CREATE FUNCTION platform_list_institutes(p_search text, p_type text, p_status text, p_plan text,
                                         p_trial_ended boolean, p_offset int, p_limit int)
RETURNS TABLE (id uuid, name text, slug text, type_key text, type_name_bn text, type_name_en text,
               status text, plan_name text, trial_ends_on date, created_at timestamptz,
               owner_name text, owner_name_bn text, owner_phone text, owner_status text,
               owner_invited_at timestamptz, active_students bigint, sms_this_month bigint,
               total bigint)
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
  ORDER BY p.created_at DESC, p.id DESC
$$;

-- One institute: metadata, modules, plan and limits, owners, counts. Raises PLATFORM_NOT_FOUND.
CREATE FUNCTION platform_get_institute(p_tenant_id uuid) RETURNS jsonb
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
                       'smsDailyCap', s.sms_daily_cap)
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

-- After provisioning committed (the API's main role created the institute, its owner invitation
-- and its own audit entry): the plan and limits, and the platform audit entry. Once per institute.
CREATE FUNCTION platform_register_institute(
  p_tenant_id uuid, p_plan_name text, p_pricing text, p_core_paisa int, p_attendance_paisa int,
  p_fees_paisa int, p_exams_paisa int, p_flat_paisa int, p_cycle text,
  p_yearly_discount_percent int, p_due_days int, p_trial_ends_on date, p_student_limit int,
  p_sms_daily_cap int, p_details jsonb, p_ip text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_admin uuid := public.app_current_platform_admin_id();
BEGIN
  PERFORM 1 FROM public.tenants WHERE id = p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_NOT_FOUND'; END IF;
  IF EXISTS (SELECT 1 FROM public.tenant_subscriptions WHERE tenant_id = p_tenant_id) THEN
    RAISE EXCEPTION 'PLATFORM_ALREADY_REGISTERED';
  END IF;
  INSERT INTO public.tenant_subscriptions (
    id, tenant_id, plan_name, pricing, core_paisa, attendance_paisa, fees_paisa, exams_paisa,
    flat_paisa, cycle, yearly_discount_percent, due_days, trial_ends_on, student_limit,
    sms_daily_cap)
  VALUES (
    gen_random_uuid(), p_tenant_id, p_plan_name, p_pricing::public.plan_pricing, p_core_paisa,
    p_attendance_paisa, p_fees_paisa, p_exams_paisa, p_flat_paisa,
    p_cycle::public.billing_cycle, p_yearly_discount_percent, p_due_days, p_trial_ends_on,
    p_student_limit, p_sms_daily_cap);
  INSERT INTO public.platform_audit_logs (id, admin_id, actor, action, target_tenant_id, entity,
                                          entity_id, details, ip)
  VALUES (gen_random_uuid(), v_admin, 'ADMIN', 'INSTITUTE_CREATE', p_tenant_id, 'tenant',
          p_tenant_id::text, p_details, p_ip);
END $$;

-- SUSPEND (from TRIAL or ACTIVE) or REACTIVATE (back to the status it had). Access ends or
-- returns on the institute's next request. A reason is required; both audit logs get it.
CREATE FUNCTION platform_set_institute_status(p_tenant_id uuid, p_action text, p_reason text,
                                              p_ip text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_admin uuid := public.app_current_platform_admin_id();
  v_old public.tenant_status;
  v_from public.tenant_status;
  v_new public.tenant_status;
BEGIN
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 3 OR char_length(p_reason) > 500 THEN
    RAISE EXCEPTION 'PLATFORM_REASON_REQUIRED';
  END IF;
  SELECT status, suspended_from INTO v_old, v_from
  FROM public.tenants WHERE id = p_tenant_id FOR UPDATE;
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

-- Turn ATTENDANCE, FEES or EXAMS on or off (CORE is always on). Returns false when nothing
-- changed (no audit entry then). The API drops the institute's modules cache after commit.
CREATE FUNCTION platform_set_module(p_tenant_id uuid, p_module text, p_enabled boolean, p_ip text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_admin uuid := public.app_current_platform_admin_id();
  v_old boolean;
BEGIN
  IF p_module = 'CORE' THEN RAISE EXCEPTION 'PLATFORM_CORE_REQUIRED'; END IF;
  IF p_module IS NULL OR p_module NOT IN ('ATTENDANCE', 'FEES', 'EXAMS') OR p_enabled IS NULL THEN
    RAISE EXCEPTION 'PLATFORM_BAD_MODULE';
  END IF;
  PERFORM 1 FROM public.tenants WHERE id = p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_NOT_FOUND'; END IF;
  SELECT enabled INTO v_old FROM public.tenant_modules
  WHERE tenant_id = p_tenant_id AND module_key = p_module::public.module_key FOR UPDATE;
  IF coalesce(v_old, false) = p_enabled THEN RETURN false; END IF;
  INSERT INTO public.tenant_modules (id, tenant_id, module_key, enabled, enabled_at)
  VALUES (gen_random_uuid(), p_tenant_id, p_module::public.module_key, p_enabled,
          CASE WHEN p_enabled THEN now() END)
  ON CONFLICT (tenant_id, module_key) DO UPDATE
    SET enabled = excluded.enabled, enabled_at = excluded.enabled_at, updated_at = now();
  INSERT INTO public.platform_audit_logs (id, admin_id, actor, action, target_tenant_id, entity,
                                          entity_id, details, ip)
  VALUES (gen_random_uuid(), v_admin, 'ADMIN',
          CASE WHEN p_enabled THEN 'INSTITUTE_MODULE_ON' ELSE 'INSTITUTE_MODULE_OFF' END,
          p_tenant_id, 'tenant_module', p_module, jsonb_build_object('module', p_module), p_ip);
  INSERT INTO public.audit_logs (id, tenant_id, actor_user_id, entity, entity_id, action,
                                 old_values, new_values)
  VALUES (gen_random_uuid(), p_tenant_id, NULL, 'tenant_module', p_tenant_id, 'UPDATE',
          jsonb_build_object('module', p_module, 'enabled', coalesce(v_old, false)),
          jsonb_build_object('module', p_module, 'enabled', p_enabled, 'via', 'platform',
                             'platformAdminId', v_admin));
  RETURN true;
END $$;

-- The student limit and the SMS daily ceiling (NULL: none). An institute without a plan row
-- gets one (no plan name).
CREATE FUNCTION platform_set_limits(p_tenant_id uuid, p_student_limit int, p_sms_daily_cap int,
                                    p_ip text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_admin uuid := public.app_current_platform_admin_id();
  v_old_limit int;
  v_old_cap int;
BEGIN
  PERFORM 1 FROM public.tenants WHERE id = p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_NOT_FOUND'; END IF;
  SELECT student_limit, sms_daily_cap INTO v_old_limit, v_old_cap
  FROM public.tenant_subscriptions WHERE tenant_id = p_tenant_id FOR UPDATE;
  INSERT INTO public.tenant_subscriptions (id, tenant_id, student_limit, sms_daily_cap)
  VALUES (gen_random_uuid(), p_tenant_id, p_student_limit, p_sms_daily_cap)
  ON CONFLICT (tenant_id) DO UPDATE
    SET student_limit = excluded.student_limit, sms_daily_cap = excluded.sms_daily_cap,
        updated_at = now();
  INSERT INTO public.platform_audit_logs (id, admin_id, actor, action, target_tenant_id, entity,
                                          entity_id, details, ip)
  VALUES (gen_random_uuid(), v_admin, 'ADMIN', 'INSTITUTE_LIMITS', p_tenant_id,
          'tenant_subscription', p_tenant_id::text,
          jsonb_build_object('studentLimit', jsonb_build_array(v_old_limit, p_student_limit),
                             'smsDailyCap', jsonb_build_array(v_old_cap, p_sms_daily_cap)),
          p_ip);
  INSERT INTO public.audit_logs (id, tenant_id, actor_user_id, entity, entity_id, action,
                                 old_values, new_values)
  VALUES (gen_random_uuid(), p_tenant_id, NULL, 'tenant_subscription', p_tenant_id, 'UPDATE',
          jsonb_build_object('studentLimit', v_old_limit, 'smsDailyCap', v_old_cap),
          jsonb_build_object('studentLimit', p_student_limit, 'smsDailyCap', p_sms_daily_cap,
                             'via', 'platform', 'platformAdminId', v_admin));
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'platform_institute_options()',
    'platform_list_institutes(text, text, text, text, boolean, integer, integer)',
    'platform_get_institute(uuid)',
    'platform_register_institute(uuid, text, text, integer, integer, integer, integer, integer, text, integer, integer, date, integer, integer, jsonb, text)',
    'platform_set_institute_status(uuid, text, text, text)',
    'platform_set_module(uuid, text, boolean, text)',
    'platform_set_limits(uuid, integer, integer, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO jantrik_platform_app', f);
    EXECUTE format('ALTER FUNCTION %s OWNER TO jantrik_platform', f);
  END LOOP;
END $$;
