-- Step 8, part 1, hardening after review:
--   * every platform function searches pg_temp LAST (a temp table named like a platform table
--     could otherwise shadow it, since pg_temp is searched first when it is not listed);
--   * platform_complete_login accepts only a time step of now (±1), and only for the password and
--     authenticator the login started with (a challenge does not survive `password`/`reset-2fa`);
--   * the authenticator can be set up only within an enrolment window opened by the CLI
--     (create / reset-2fa: 24 hours), not forever after a password is known;
--   * the audit log pages by (created_at, id).

ALTER TABLE "platform_admins" ADD COLUMN "totp_enrol_by" TIMESTAMPTZ(3);

-- The functions are owned by jantrik_platform: drop them as that role, then recreate.
SET ROLE jantrik_platform;
DROP FUNCTION app_current_platform_admin_id();
DROP FUNCTION platform_find_admin_for_login(text, text);
DROP FUNCTION platform_complete_login(uuid, text, bigint, text, text, text[], text, text, text, integer, integer);
DROP FUNCTION platform_audit_login_failure(uuid, text, text);
DROP FUNCTION platform_session_admin(text, integer);
DROP FUNCTION platform_end_session();
DROP FUNCTION platform_me();
DROP FUNCTION platform_audit(text, uuid, text, text, jsonb, text);
DROP FUNCTION platform_list_audit(timestamp with time zone, integer);
RESET ROLE;

CREATE FUNCTION app_current_platform_admin_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_admin uuid;
BEGIN
  SELECT s.admin_id INTO v_admin
  FROM public.platform_sessions s JOIN public.platform_admins a ON a.id = s.admin_id
  WHERE s.token_hash = public.app_current_platform_session()
    AND s.revoked_at IS NULL AND s.expires_at > now() AND s.idle_expires_at > now()
    AND a.is_active;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'platform session required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_admin;
END $$;

CREATE FUNCTION platform_find_admin_for_login(p_phone text, p_email text)
RETURNS TABLE (id uuid, name text, password_hash text, is_active boolean, totp_secret text,
               totp_enrol_by timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT a.id, a.name, a.password_hash, a.is_active, a.totp_secret, a.totp_enrol_by
  FROM public.platform_admins a
  WHERE (p_phone IS NOT NULL AND a.phone = p_phone)
     OR (p_email IS NOT NULL AND a.email = lower(p_email))
  LIMIT 1
$$;

-- After the API verified the password and the TOTP or backup code. Atomically, under the admin
-- row lock: the password and the authenticator must still be the ones the login started with,
-- a time step must be the current one (±1) and newer than the last used, a backup code is used
-- once, a first enrolment must be inside its window; then the session and its audit entry.
CREATE FUNCTION platform_complete_login(
  p_admin_id uuid, p_method text, p_totp_step bigint, p_backup_hash text,
  p_enrol_secret text, p_enrol_backup_hashes text[],
  p_expected_password_hash text, p_expected_totp_secret text,
  p_token_hash text, p_ip text, p_user_agent text, p_idle_seconds int, p_max_seconds int)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_admin public.platform_admins%ROWTYPE;
  v_session uuid := gen_random_uuid();
  v_now_step bigint := floor(extract(epoch FROM clock_timestamp()) / 30);
BEGIN
  SELECT * INTO v_admin FROM public.platform_admins WHERE platform_admins.id = p_admin_id FOR UPDATE;
  IF NOT FOUND OR NOT v_admin.is_active THEN RAISE EXCEPTION 'PLATFORM_ADMIN_INACTIVE'; END IF;
  IF v_admin.password_hash IS DISTINCT FROM p_expected_password_hash
     OR v_admin.totp_secret IS DISTINCT FROM p_expected_totp_secret THEN
    RAISE EXCEPTION 'PLATFORM_CREDENTIALS_CHANGED';
  END IF;
  IF p_idle_seconds < 60 OR p_max_seconds < p_idle_seconds OR p_max_seconds > 86400 THEN
    RAISE EXCEPTION 'PLATFORM_BAD_SESSION_LENGTH';
  END IF;
  IF p_totp_step IS NOT NULL AND abs(p_totp_step - v_now_step) > 1 THEN
    RAISE EXCEPTION 'PLATFORM_CODE_EXPIRED';
  END IF;
  IF p_method = 'ENROL' THEN
    IF v_admin.totp_secret IS NOT NULL THEN RAISE EXCEPTION 'PLATFORM_ALREADY_ENROLLED'; END IF;
    IF v_admin.totp_enrol_by IS NULL OR v_admin.totp_enrol_by <= now() THEN
      RAISE EXCEPTION 'PLATFORM_ENROLMENT_CLOSED';
    END IF;
    IF p_enrol_secret IS NULL OR p_totp_step IS NULL
       OR coalesce(array_length(p_enrol_backup_hashes, 1), 0) <> 10 THEN
      RAISE EXCEPTION 'PLATFORM_BAD_ENROLMENT';
    END IF;
    UPDATE public.platform_admins
    SET totp_secret = p_enrol_secret, totp_enabled_at = now(), totp_last_step = p_totp_step,
        totp_enrol_by = NULL
    WHERE platform_admins.id = p_admin_id;
    DELETE FROM public.platform_admin_backup_codes WHERE admin_id = p_admin_id;
    INSERT INTO public.platform_admin_backup_codes (id, admin_id, code_hash)
    SELECT gen_random_uuid(), p_admin_id, h FROM unnest(p_enrol_backup_hashes) AS h;
  ELSIF p_method = 'TOTP' THEN
    IF v_admin.totp_secret IS NULL THEN RAISE EXCEPTION 'PLATFORM_NOT_ENROLLED'; END IF;
    IF p_totp_step IS NULL OR p_totp_step <= coalesce(v_admin.totp_last_step, -1) THEN
      RAISE EXCEPTION 'PLATFORM_CODE_REUSED';
    END IF;
    UPDATE public.platform_admins SET totp_last_step = p_totp_step
    WHERE platform_admins.id = p_admin_id;
  ELSIF p_method = 'BACKUP' THEN
    IF v_admin.totp_secret IS NULL THEN RAISE EXCEPTION 'PLATFORM_NOT_ENROLLED'; END IF;
    UPDATE public.platform_admin_backup_codes SET used_at = now()
    WHERE admin_id = p_admin_id AND code_hash = p_backup_hash AND used_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_BACKUP_CODE_INVALID'; END IF;
  ELSE
    RAISE EXCEPTION 'PLATFORM_BAD_METHOD';
  END IF;
  UPDATE public.platform_admins SET last_login_at = now(), updated_at = now()
  WHERE platform_admins.id = p_admin_id;
  INSERT INTO public.platform_sessions (id, admin_id, token_hash, ip, user_agent, idle_expires_at,
                                        expires_at)
  VALUES (v_session, p_admin_id, p_token_hash, p_ip, p_user_agent,
          now() + make_interval(secs => p_idle_seconds), now() + make_interval(secs => p_max_seconds));
  INSERT INTO public.platform_audit_logs (id, admin_id, actor, action, entity, entity_id, details, ip)
  VALUES (gen_random_uuid(), p_admin_id, 'ADMIN', 'LOGIN', 'platform_session', v_session::text,
          jsonb_build_object('method', p_method), p_ip);
  RETURN v_session;
END $$;

CREATE FUNCTION platform_audit_login_failure(p_admin_id uuid, p_reason text, p_ip text)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  INSERT INTO public.platform_audit_logs (id, admin_id, actor, action, details, ip)
  SELECT gen_random_uuid(), a.id, 'ADMIN', 'LOGIN_FAILED', jsonb_build_object('reason', p_reason), p_ip
  FROM public.platform_admins a WHERE a.id = p_admin_id
$$;

CREATE FUNCTION platform_session_admin(p_token_hash text, p_idle_seconds int)
RETURNS TABLE (session_id uuid, admin_id uuid, admin_name text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RETURN QUERY
  UPDATE public.platform_sessions s
  SET last_used_at = now(),
      idle_expires_at = least(now() + make_interval(secs => greatest(p_idle_seconds, 60)), s.expires_at)
  FROM public.platform_admins a
  WHERE s.token_hash = p_token_hash AND a.id = s.admin_id AND a.is_active
    AND s.revoked_at IS NULL AND s.expires_at > now() AND s.idle_expires_at > now()
  RETURNING s.id, s.admin_id, a.name;
END $$;

CREATE FUNCTION platform_end_session() RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_admin uuid := public.app_current_platform_admin_id();
BEGIN
  UPDATE public.platform_sessions SET revoked_at = now(), revoke_reason = 'LOGOUT'
  WHERE token_hash = public.app_current_platform_session() AND revoked_at IS NULL;
  INSERT INTO public.platform_audit_logs (id, admin_id, actor, action, entity)
  VALUES (gen_random_uuid(), v_admin, 'ADMIN', 'LOGOUT', 'platform_session');
END $$;

CREATE FUNCTION platform_me()
RETURNS TABLE (id uuid, name text, phone text, email text, totp_enabled_at timestamptz,
               backup_codes_left int, session_expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT a.id, a.name, a.phone, a.email, a.totp_enabled_at,
         (SELECT count(*)::int FROM public.platform_admin_backup_codes b
          WHERE b.admin_id = a.id AND b.used_at IS NULL),
         (SELECT s.expires_at FROM public.platform_sessions s
          WHERE s.token_hash = public.app_current_platform_session())
  FROM public.platform_admins a WHERE a.id = public.app_current_platform_admin_id()
$$;

CREATE FUNCTION platform_audit(p_action text, p_target_tenant_id uuid, p_entity text,
                               p_entity_id text, p_details jsonb, p_ip text)
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  INSERT INTO public.platform_audit_logs (id, admin_id, actor, action, target_tenant_id, entity,
                                          entity_id, details, ip)
  VALUES (gen_random_uuid(), public.app_current_platform_admin_id(), 'ADMIN', p_action,
          p_target_tenant_id, p_entity, p_entity_id, p_details, p_ip)
  RETURNING id
$$;

-- Newest first; the next page starts after (p_before, p_before_id) of the last row.
CREATE FUNCTION platform_list_audit(p_before timestamptz, p_before_id uuid, p_limit int)
RETURNS TABLE (id uuid, created_at timestamptz, actor text, admin_name text, action text,
               target_tenant_id uuid, target_tenant_name text, entity text, entity_id text,
               details jsonb, ip text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT l.id, l.created_at, l.actor::text, a.name, l.action, l.target_tenant_id, t.name,
         l.entity, l.entity_id, l.details, l.ip
  FROM public.platform_audit_logs l
  LEFT JOIN public.platform_admins a ON a.id = l.admin_id
  LEFT JOIN public.tenants t ON t.id = l.target_tenant_id
  WHERE public.app_current_platform_admin_id() IS NOT NULL
    AND (p_before IS NULL OR (l.created_at, l.id) < (p_before, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
  ORDER BY l.created_at DESC, l.id DESC
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'app_current_platform_admin_id()',
    'platform_find_admin_for_login(text, text)',
    'platform_complete_login(uuid, text, bigint, text, text, text[], text, text, text, text, text, integer, integer)',
    'platform_audit_login_failure(uuid, text, text)',
    'platform_session_admin(text, integer)',
    'platform_end_session()',
    'platform_me()',
    'platform_audit(text, uuid, text, text, jsonb, text)',
    'platform_list_audit(timestamp with time zone, uuid, integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO jantrik_app', f);
    EXECUTE format('ALTER FUNCTION %s OWNER TO jantrik_platform', f);
  END LOOP;
END $$;
