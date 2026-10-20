-- Step 8, part 2, after review:
--   * An institute could still INSERT a tenant_modules row for a module it never had
--     (provisioning wrote rows only for the enabled ones). Provisioning now writes a row for
--     every module, and jantrik_app may insert module rows only while its institute has none
--     (the provisioning insert itself). Older institutes already have rows, so they cannot either.
--   * The platform functions lock the institute's row with FOR NO KEY UPDATE (FOR UPDATE would
--     also wait for every foreign-key check on it, i.e. every busy institute request), and lock
--     it first in register / set_module / set_limits: two concurrent changes of one institute
--     run one after the other and audit the right "before".
-- CREATE OR REPLACE as the owner keeps each function's grants (EXECUTE for jantrik_platform_app).

CREATE POLICY provisioning_only ON tenant_modules AS RESTRICTIVE FOR INSERT TO jantrik_app
  WITH CHECK (NOT EXISTS (
    SELECT 1 FROM tenant_modules existing WHERE existing.tenant_id = tenant_modules.tenant_id));

SET ROLE jantrik_platform;

-- After provisioning committed (the API's main role created the institute, its owner invitation
-- and its own audit entry): the plan and limits, and the platform audit entry. Once per institute.
CREATE OR REPLACE FUNCTION platform_register_institute(
  p_tenant_id uuid, p_plan_name text, p_pricing text, p_core_paisa int, p_attendance_paisa int,
  p_fees_paisa int, p_exams_paisa int, p_flat_paisa int, p_cycle text,
  p_yearly_discount_percent int, p_due_days int, p_trial_ends_on date, p_student_limit int,
  p_sms_daily_cap int, p_details jsonb, p_ip text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_admin uuid := public.app_current_platform_admin_id();
BEGIN
  -- The institute's row first: one platform change at a time per institute.
  PERFORM 1 FROM public.tenants WHERE id = p_tenant_id FOR NO KEY UPDATE;
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
CREATE OR REPLACE FUNCTION platform_set_institute_status(p_tenant_id uuid, p_action text, p_reason text,
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
CREATE OR REPLACE FUNCTION platform_set_module(p_tenant_id uuid, p_module text, p_enabled boolean, p_ip text)
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
  -- The institute's row first: one platform change at a time per institute.
  PERFORM 1 FROM public.tenants WHERE id = p_tenant_id FOR NO KEY UPDATE;
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
CREATE OR REPLACE FUNCTION platform_set_limits(p_tenant_id uuid, p_student_limit int, p_sms_daily_cap int,
                                    p_ip text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_admin uuid := public.app_current_platform_admin_id();
  v_old_limit int;
  v_old_cap int;
BEGIN
  -- The institute's row first: one platform change at a time per institute.
  PERFORM 1 FROM public.tenants WHERE id = p_tenant_id FOR NO KEY UPDATE;
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

RESET ROLE;
