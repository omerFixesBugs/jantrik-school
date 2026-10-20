-- Step 8, part 4, after review:
--   * The usage figures read a month's SENT SMS across all institutes: a partial index on
--     local_date, so that read does not scan all SMS history.
--   * platform_set_sms_cost raises its own error for a bad rate, and refuses when the settings
--     row is missing (instead of auditing a change that did not happen).

-- CreateIndex
CREATE INDEX "sms_logs_sent_local_date" ON "sms_logs"("local_date") WHERE (status = 'SENT');

-- Replaced by its owner (grants and settings are kept).
SET ROLE jantrik_platform;

-- What one SMS segment costs from now on (৳0 to ৳100). Audited.
CREATE OR REPLACE FUNCTION platform_set_sms_cost(p_paisa int, p_ip text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_admin uuid := public.app_current_platform_admin_id();
  v_old int;
BEGIN
  IF p_paisa IS NULL OR p_paisa < 0 OR p_paisa > 10000 THEN
    RAISE EXCEPTION 'PLATFORM_BAD_RATE';
  END IF;
  SELECT sms_cost_per_segment_paisa INTO v_old FROM public.platform_settings WHERE id = 1 FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_SETTINGS_MISSING'; END IF;
  UPDATE public.platform_settings
  SET sms_cost_per_segment_paisa = p_paisa, updated_at = now(), updated_by_id = v_admin
  WHERE id = 1;
  INSERT INTO public.platform_audit_logs (id, admin_id, actor, action, entity, entity_id, details,
                                          ip)
  VALUES (gen_random_uuid(), v_admin, 'ADMIN', 'SETTINGS_SMS_COST', 'platform_settings', '1',
          jsonb_build_object('from', v_old, 'to', p_paisa), p_ip);
END $$;

RESET ROLE;
