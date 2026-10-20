-- Step 8, part 1: platform admins (Jantrik staff), their sessions and audit log.
-- Global tables, not tenant data; see docs/platform.md and docs/database.md.

-- CreateEnum
CREATE TYPE "platform_session_revoke_reason" AS ENUM ('LOGOUT', 'DISABLED', 'RESET_2FA');

-- CreateEnum
CREATE TYPE "platform_actor" AS ENUM ('ADMIN', 'CLI');

-- CreateTable
CREATE TABLE "platform_admins" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "password_hash" TEXT NOT NULL,
    "totp_secret" TEXT,
    "totp_enabled_at" TIMESTAMPTZ(3),
    "totp_last_step" BIGINT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_admin_backup_codes" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_admin_backup_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_sessions" (
    "id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idle_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoke_reason" "platform_session_revoke_reason",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_audit_logs" (
    "id" UUID NOT NULL,
    "admin_id" UUID,
    "actor" "platform_actor" NOT NULL,
    "action" TEXT NOT NULL,
    "target_tenant_id" UUID,
    "entity" TEXT,
    "entity_id" TEXT,
    "details" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_admins_phone_key" ON "platform_admins"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "platform_admins_email_key" ON "platform_admins"("email");

-- CreateIndex
CREATE UNIQUE INDEX "platform_admin_backup_codes_admin_id_code_hash_key" ON "platform_admin_backup_codes"("admin_id", "code_hash");

-- CreateIndex
CREATE UNIQUE INDEX "platform_sessions_token_hash_key" ON "platform_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "platform_sessions_admin_id_idx" ON "platform_sessions"("admin_id");

-- CreateIndex
CREATE INDEX "platform_audit_logs_created_at_idx" ON "platform_audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "platform_audit_logs_target_tenant_id_created_at_idx" ON "platform_audit_logs"("target_tenant_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "platform_admin_backup_codes" ADD CONSTRAINT "platform_admin_backup_codes_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "platform_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_sessions" ADD CONSTRAINT "platform_sessions_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "platform_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_audit_logs" ADD CONSTRAINT "platform_audit_logs_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "platform_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─────────────────────────── Constraints ───────────────────────────
ALTER TABLE "platform_admins"
  ADD CONSTRAINT platform_admins_phone_bd_format CHECK (phone ~ '^\+8801[3-9][0-9]{8}$'),
  ADD CONSTRAINT platform_admins_email_lowercase CHECK (email IS NULL OR email = lower(email)),
  ADD CONSTRAINT platform_admins_name_length CHECK (char_length(name) BETWEEN 1 AND 100),
  ADD CONSTRAINT platform_admins_totp_together
    CHECK ((totp_secret IS NULL) = (totp_enabled_at IS NULL));
ALTER TABLE "platform_sessions"
  ADD CONSTRAINT platform_sessions_idle_within_max CHECK (idle_expires_at <= expires_at);
ALTER TABLE "platform_audit_logs"
  ADD CONSTRAINT platform_audit_logs_action_length CHECK (char_length(action) BETWEEN 1 AND 64);

-- ─────────────────────────── Who may touch them ───────────────────────────
-- No RLS (nothing here belongs to a tenant): protected by grants. jantrik_app gets nothing on
-- these tables; the API reaches them only through the jantrik_platform functions below. The
-- owner role (migrations, the `pnpm platform:admin` CLI) owns them.
REVOKE ALL ON "platform_admins", "platform_admin_backup_codes", "platform_sessions",
  "platform_audit_logs" FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO jantrik_platform;
GRANT SELECT, INSERT, UPDATE ON "platform_admins", "platform_sessions" TO jantrik_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_admin_backup_codes" TO jantrik_platform;
-- Append-only, also for the platform functions.
GRANT SELECT, INSERT ON "platform_audit_logs" TO jantrik_platform;
-- Institute names for the audit log (metadata only; more in part 2).
GRANT SELECT ON "tenants" TO jantrik_platform;
CREATE POLICY platform_read ON "tenants" FOR SELECT TO jantrik_platform USING (true);

-- ─────────────────────────── Session context ───────────────────────────
-- The API sets app.platform_session (the session token's SHA-256) in each platform request's
-- transaction. Platform functions resolve the admin from it and refuse without a live session,
-- so even a wrong context gets nothing without a real session token.
CREATE FUNCTION app_current_platform_session() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.platform_session', true), '')
$$;

CREATE FUNCTION app_current_platform_admin_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_admin uuid;
BEGIN
  SELECT s.admin_id INTO v_admin
  FROM platform_sessions s JOIN platform_admins a ON a.id = s.admin_id
  WHERE s.token_hash = app_current_platform_session()
    AND s.revoked_at IS NULL AND s.expires_at > now() AND s.idle_expires_at > now()
    AND a.is_active;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'platform session required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_admin;
END $$;

-- ─────────────────────────── Before a session exists (login) ───────────────────────────
-- Step 1: the admin by phone or email (the API checks the password and the second factor).
CREATE FUNCTION platform_find_admin_for_login(p_phone text, p_email text)
RETURNS TABLE (id uuid, name text, password_hash text, is_active boolean, totp_secret text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT a.id, a.name, a.password_hash, a.is_active, a.totp_secret
  FROM platform_admins a
  WHERE (p_phone IS NOT NULL AND a.phone = p_phone)
     OR (p_email IS NOT NULL AND a.email = lower(p_email))
  LIMIT 1
$$;

-- Step 2: after the API verified the password and the TOTP or backup code. Atomically: consume
-- the factor (a TOTP step or a backup code is never accepted twice), save a first enrolment with
-- its 10 backup code hashes, open the session and audit the login.
CREATE FUNCTION platform_complete_login(
  p_admin_id uuid, p_method text, p_totp_step bigint, p_backup_hash text,
  p_enrol_secret text, p_enrol_backup_hashes text[],
  p_token_hash text, p_ip text, p_user_agent text, p_idle_seconds int, p_max_seconds int)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_admin platform_admins%ROWTYPE;
  v_session uuid := gen_random_uuid();
BEGIN
  SELECT * INTO v_admin FROM platform_admins WHERE platform_admins.id = p_admin_id FOR UPDATE;
  IF NOT FOUND OR NOT v_admin.is_active THEN RAISE EXCEPTION 'PLATFORM_ADMIN_INACTIVE'; END IF;
  IF p_idle_seconds < 60 OR p_max_seconds < p_idle_seconds OR p_max_seconds > 86400 THEN
    RAISE EXCEPTION 'PLATFORM_BAD_SESSION_LENGTH';
  END IF;
  IF p_method = 'ENROL' THEN
    IF v_admin.totp_secret IS NOT NULL THEN RAISE EXCEPTION 'PLATFORM_ALREADY_ENROLLED'; END IF;
    IF p_enrol_secret IS NULL OR p_totp_step IS NULL
       OR coalesce(array_length(p_enrol_backup_hashes, 1), 0) <> 10 THEN
      RAISE EXCEPTION 'PLATFORM_BAD_ENROLMENT';
    END IF;
    UPDATE platform_admins
    SET totp_secret = p_enrol_secret, totp_enabled_at = now(), totp_last_step = p_totp_step
    WHERE platform_admins.id = p_admin_id;
    DELETE FROM platform_admin_backup_codes WHERE admin_id = p_admin_id;
    INSERT INTO platform_admin_backup_codes (id, admin_id, code_hash)
    SELECT gen_random_uuid(), p_admin_id, h FROM unnest(p_enrol_backup_hashes) AS h;
  ELSIF p_method = 'TOTP' THEN
    IF v_admin.totp_secret IS NULL THEN RAISE EXCEPTION 'PLATFORM_NOT_ENROLLED'; END IF;
    IF p_totp_step IS NULL OR p_totp_step <= coalesce(v_admin.totp_last_step, -1) THEN
      RAISE EXCEPTION 'PLATFORM_CODE_REUSED';
    END IF;
    UPDATE platform_admins SET totp_last_step = p_totp_step WHERE platform_admins.id = p_admin_id;
  ELSIF p_method = 'BACKUP' THEN
    IF v_admin.totp_secret IS NULL THEN RAISE EXCEPTION 'PLATFORM_NOT_ENROLLED'; END IF;
    UPDATE platform_admin_backup_codes SET used_at = now()
    WHERE admin_id = p_admin_id AND code_hash = p_backup_hash AND used_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'PLATFORM_BACKUP_CODE_INVALID'; END IF;
  ELSE
    RAISE EXCEPTION 'PLATFORM_BAD_METHOD';
  END IF;
  UPDATE platform_admins SET last_login_at = now(), updated_at = now()
  WHERE platform_admins.id = p_admin_id;
  INSERT INTO platform_sessions (id, admin_id, token_hash, ip, user_agent, idle_expires_at, expires_at)
  VALUES (v_session, p_admin_id, p_token_hash, p_ip, p_user_agent,
          now() + make_interval(secs => p_idle_seconds), now() + make_interval(secs => p_max_seconds));
  INSERT INTO platform_audit_logs (id, admin_id, actor, action, entity, entity_id, details, ip)
  VALUES (gen_random_uuid(), p_admin_id, 'ADMIN', 'LOGIN', 'platform_session', v_session::text,
          jsonb_build_object('method', p_method), p_ip);
  RETURN v_session;
END $$;

-- A failed second factor (or a locked challenge) for a known admin.
CREATE FUNCTION platform_audit_login_failure(p_admin_id uuid, p_reason text, p_ip text)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  INSERT INTO platform_audit_logs (id, admin_id, actor, action, details, ip)
  SELECT gen_random_uuid(), a.id, 'ADMIN', 'LOGIN_FAILED', jsonb_build_object('reason', p_reason), p_ip
  FROM platform_admins a WHERE a.id = p_admin_id
$$;

-- Every platform request: the live session for a cookie token (hash), touched (idle renewed,
-- never past the absolute expiry). No row: signed out.
CREATE FUNCTION platform_session_admin(p_token_hash text, p_idle_seconds int)
RETURNS TABLE (session_id uuid, admin_id uuid, admin_name text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN QUERY
  UPDATE platform_sessions s
  SET last_used_at = now(),
      idle_expires_at = least(now() + make_interval(secs => greatest(p_idle_seconds, 60)), s.expires_at)
  FROM platform_admins a
  WHERE s.token_hash = p_token_hash AND a.id = s.admin_id AND a.is_active
    AND s.revoked_at IS NULL AND s.expires_at > now() AND s.idle_expires_at > now()
  RETURNING s.id, s.admin_id, a.name;
END $$;

-- ─────────────────────────── With a session ───────────────────────────
CREATE FUNCTION platform_end_session() RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_admin uuid := app_current_platform_admin_id();
BEGIN
  UPDATE platform_sessions SET revoked_at = now(), revoke_reason = 'LOGOUT'
  WHERE token_hash = app_current_platform_session() AND revoked_at IS NULL;
  INSERT INTO platform_audit_logs (id, admin_id, actor, action, entity)
  VALUES (gen_random_uuid(), v_admin, 'ADMIN', 'LOGOUT', 'platform_session');
END $$;

CREATE FUNCTION platform_me()
RETURNS TABLE (id uuid, name text, phone text, email text, totp_enabled_at timestamptz,
               backup_codes_left int, session_expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT a.id, a.name, a.phone, a.email, a.totp_enabled_at,
         (SELECT count(*)::int FROM platform_admin_backup_codes b
          WHERE b.admin_id = a.id AND b.used_at IS NULL),
         (SELECT s.expires_at FROM platform_sessions s
          WHERE s.token_hash = app_current_platform_session())
  FROM platform_admins a WHERE a.id = app_current_platform_admin_id()
$$;

-- An action the API does on the admin's behalf (e.g. provisioning steps), in the same
-- transaction as the action itself.
CREATE FUNCTION platform_audit(p_action text, p_target_tenant_id uuid, p_entity text,
                               p_entity_id text, p_details jsonb, p_ip text)
RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  INSERT INTO platform_audit_logs (id, admin_id, actor, action, target_tenant_id, entity,
                                   entity_id, details, ip)
  VALUES (gen_random_uuid(), app_current_platform_admin_id(), 'ADMIN', p_action,
          p_target_tenant_id, p_entity, p_entity_id, p_details, p_ip)
  RETURNING id
$$;

CREATE FUNCTION platform_list_audit(p_before timestamptz, p_limit int)
RETURNS TABLE (id uuid, created_at timestamptz, actor text, admin_name text, action text,
               target_tenant_id uuid, target_tenant_name text, entity text, entity_id text,
               details jsonb, ip text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT l.id, l.created_at, l.actor::text, a.name, l.action, l.target_tenant_id, t.name,
         l.entity, l.entity_id, l.details, l.ip
  FROM platform_audit_logs l
  LEFT JOIN platform_admins a ON a.id = l.admin_id
  LEFT JOIN tenants t ON t.id = l.target_tenant_id
  WHERE app_current_platform_admin_id() IS NOT NULL
    AND (p_before IS NULL OR l.created_at < p_before)
  ORDER BY l.created_at DESC, l.id DESC
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 200)
$$;

-- ─────────────────────────── Ownership ───────────────────────────
-- REVOKE/GRANT first (as the owner), then hand the functions to jantrik_platform.
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'app_current_platform_admin_id()',
    'platform_find_admin_for_login(text, text)',
    'platform_complete_login(uuid, text, bigint, text, text, text[], text, text, text, integer, integer)',
    'platform_audit_login_failure(uuid, text, text)',
    'platform_session_admin(text, integer)',
    'platform_end_session()',
    'platform_me()',
    'platform_audit(text, uuid, text, text, jsonb, text)',
    'platform_list_audit(timestamp with time zone, integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO jantrik_app', f);
    EXECUTE format('ALTER FUNCTION %s OWNER TO jantrik_platform', f);
  END LOOP;
END $$;
