-- Step 8, part 4: usage and cost. See docs/platform.md.
--   * platform_settings (one global row): what one SMS segment costs Jantrik (৳0.30 to start),
--     changed only through an audited platform function.
--   * sms_logs.cost_paisa and platform_sms_logs.cost_paisa: segments × the rate, copied when an
--     SMS is sent, so a later rate change keeps past costs.
--   * Functions: the settings, the month's usage (totals, and per institute by cost).

-- AlterTable
ALTER TABLE "platform_sms_logs" ADD COLUMN     "cost_paisa" INTEGER;

-- AlterTable
ALTER TABLE "sms_logs" ADD COLUMN     "cost_paisa" INTEGER;

-- CreateTable
CREATE TABLE "platform_settings" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "sms_cost_per_segment_paisa" INTEGER NOT NULL DEFAULT 30,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_id" UUID,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "platform_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────── Constraints, the row, grants ───────────────────────────
ALTER TABLE "platform_settings"
  ADD CONSTRAINT platform_settings_single_row CHECK (id = 1),
  ADD CONSTRAINT platform_settings_sms_cost CHECK (sms_cost_per_segment_paisa BETWEEN 0 AND 10000);
ALTER TABLE "sms_logs" ADD CONSTRAINT sms_logs_cost CHECK (cost_paisa IS NULL OR cost_paisa >= 0);
ALTER TABLE "platform_sms_logs"
  ADD CONSTRAINT platform_sms_logs_cost CHECK (cost_paisa IS NULL OR cost_paisa >= 0);

INSERT INTO platform_settings (id, sms_cost_per_segment_paisa) VALUES (1, 30);

REVOKE ALL ON platform_settings FROM PUBLIC;
-- The API reads the rate when it sends an SMS; it can change nothing here.
GRANT SELECT (sms_cost_per_segment_paisa) ON platform_settings TO jantrik_app;
GRANT SELECT, UPDATE ON platform_settings TO jantrik_platform;
-- Costs for the usage figures (never a phone number or an SMS text).
GRANT SELECT (cost_paisa) ON sms_logs TO jantrik_platform;
GRANT SELECT (purpose, status, segments, cost_paisa, created_at) ON platform_sms_logs
  TO jantrik_platform;

-- ─────────────────────────── Platform functions ───────────────────────────

CREATE FUNCTION platform_get_settings() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('smsCostPerSegmentPaisa', s.sms_cost_per_segment_paisa,
                            'updatedAt', s.updated_at, 'updatedBy', a.name)
  FROM public.platform_settings s
  LEFT JOIN public.platform_admins a ON a.id = s.updated_by_id
  WHERE s.id = 1 AND public.app_current_platform_admin_id() IS NOT NULL
$$;

-- What one SMS segment costs from now on (০ to ৳100). Audited.
CREATE FUNCTION platform_set_sms_cost(p_paisa int, p_ip text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_admin uuid := public.app_current_platform_admin_id();
  v_old int;
BEGIN
  IF p_paisa IS NULL OR p_paisa < 0 OR p_paisa > 10000 THEN
    RAISE EXCEPTION 'PLATFORM_BAD_AMOUNT';
  END IF;
  SELECT sms_cost_per_segment_paisa INTO v_old FROM public.platform_settings WHERE id = 1 FOR UPDATE;
  UPDATE public.platform_settings
  SET sms_cost_per_segment_paisa = p_paisa, updated_at = now(), updated_by_id = v_admin
  WHERE id = 1;
  INSERT INTO public.platform_audit_logs (id, admin_id, actor, action, entity, entity_id, details,
                                          ip)
  VALUES (gen_random_uuid(), v_admin, 'ADMIN', 'SETTINGS_SMS_COST', 'platform_settings', '1',
          jsonb_build_object('from', v_old, 'to', p_paisa), p_ip);
END $$;

-- One month (`p_month`: any day of it): institutes by status, active students, SMS sent by
-- institutes and as login codes (count, segments, cost), and the current rate. SMS months are
-- the institute's local date / Dhaka time for login codes.
CREATE FUNCTION platform_usage(p_month date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH m AS (
    SELECT date_trunc('month', p_month)::date AS start,
           (date_trunc('month', p_month) + interval '1 month')::date AS next
  )
  SELECT jsonb_build_object(
    'month', m.start,
    'institutes', (SELECT jsonb_build_object(
                     'total', count(*),
                     'active', count(*) FILTER (WHERE t.status = 'ACTIVE'),
                     'trial', count(*) FILTER (WHERE t.status = 'TRIAL'),
                     'suspended', count(*) FILTER (WHERE t.status IN ('SUSPENDED', 'ARCHIVED')))
                   FROM public.tenants t),
    'activeStudents', (SELECT count(*) FROM public.students st
                       WHERE st.status = 'ACTIVE' AND st.deleted_at IS NULL),
    'institutesSms', (SELECT jsonb_build_object('count', count(*),
                                                'segments', coalesce(sum(l.segments), 0),
                                                'costPaisa', coalesce(sum(l.cost_paisa), 0))
                      FROM public.sms_logs l
                      WHERE l.status = 'SENT' AND l.local_date >= m.start AND l.local_date < m.next),
    'loginSms', (SELECT jsonb_build_object('count', count(*),
                                           'segments', coalesce(sum(p.segments), 0),
                                           'costPaisa', coalesce(sum(p.cost_paisa), 0))
                 FROM public.platform_sms_logs p
                 WHERE p.status = 'SENT'
                   AND p.created_at >= m.start::timestamp AT TIME ZONE 'Asia/Dhaka'
                   AND p.created_at < m.next::timestamp AT TIME ZONE 'Asia/Dhaka'),
    'smsCostPerSegmentPaisa', (SELECT s.sms_cost_per_segment_paisa
                               FROM public.platform_settings s WHERE s.id = 1))
  FROM m
  WHERE public.app_current_platform_admin_id() IS NOT NULL
$$;

-- One month per institute, the most expensive first: active students, SMS sent (count,
-- segments, cost), imports that month, last activity. `total` is the count before paging.
CREATE FUNCTION platform_usage_institutes(p_month date, p_offset int, p_limit int)
RETURNS TABLE (id uuid, name text, slug text, status text, active_students bigint,
               sms_sent bigint, sms_segments bigint, sms_cost_paisa bigint, imports bigint,
               last_activity_at timestamptz, total bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH m AS (
    SELECT date_trunc('month', p_month)::date AS start,
           (date_trunc('month', p_month) + interval '1 month')::date AS next
  ), sms AS (
    SELECT l.tenant_id, count(*) AS sent, sum(l.segments) AS segments,
           coalesce(sum(l.cost_paisa), 0) AS cost
    FROM public.sms_logs l CROSS JOIN m
    WHERE l.status = 'SENT' AND l.local_date >= m.start AND l.local_date < m.next
    GROUP BY l.tenant_id
  ), page AS (
    SELECT t.id, t.name, t.slug, t.status::text AS status, t.timezone,
           coalesce(sms.sent, 0) AS sms_sent, coalesce(sms.segments, 0) AS sms_segments,
           coalesce(sms.cost, 0) AS sms_cost, count(*) OVER () AS total
    FROM public.tenants t
    LEFT JOIN sms ON sms.tenant_id = t.id
    WHERE public.app_current_platform_admin_id() IS NOT NULL
    ORDER BY coalesce(sms.cost, 0) DESC, coalesce(sms.segments, 0) DESC, t.name, t.id
    OFFSET greatest(coalesce(p_offset, 0), 0)
    LIMIT least(greatest(coalesce(p_limit, 25), 1), 100)
  )
  SELECT p.id, p.name, p.slug, p.status,
         (SELECT count(*) FROM public.students st
          WHERE st.tenant_id = p.id AND st.status = 'ACTIVE' AND st.deleted_at IS NULL),
         p.sms_sent, p.sms_segments, p.sms_cost,
         (SELECT count(*) FROM public.student_imports i CROSS JOIN m
          WHERE i.tenant_id = p.id
            AND i.created_at >= m.start::timestamp AT TIME ZONE p.timezone
            AND i.created_at < m.next::timestamp AT TIME ZONE p.timezone),
         greatest(
           (SELECT max(a.created_at) FROM public.audit_logs a WHERE a.tenant_id = p.id),
           (SELECT max(s.updated_at) FROM public.attendance_sessions s WHERE s.tenant_id = p.id),
           (SELECT max(l.created_at) FROM public.sms_logs l WHERE l.tenant_id = p.id),
           (SELECT max(i.created_at) FROM public.student_imports i WHERE i.tenant_id = p.id)),
         p.total
  FROM page p
  ORDER BY p.sms_cost DESC, p.sms_segments DESC, p.name, p.id
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'platform_get_settings()',
    'platform_set_sms_cost(integer, text)',
    'platform_usage(date)',
    'platform_usage_institutes(date, integer, integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO jantrik_platform_app', f);
    EXECUTE format('ALTER FUNCTION %s OWNER TO jantrik_platform', f);
  END LOOP;
END $$;

-- The institute detail gets the month's SMS cost (replaced by its owner; grants are kept).
SET ROLE jantrik_platform;

-- One institute: metadata, modules, plan and limits, billing, owners, counts. Raises
-- PLATFORM_NOT_FOUND. (Part 3: billing start, open and overdue invoices; part 4: SMS cost.)
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
      'smsCostThisMonth', (SELECT coalesce(sum(l.cost_paisa), 0) FROM public.sms_logs l
                           WHERE l.tenant_id = t.id AND l.status = 'SENT'
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

RESET ROLE;
