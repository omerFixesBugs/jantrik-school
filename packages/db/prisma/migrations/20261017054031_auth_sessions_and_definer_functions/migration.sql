-- CreateEnum
CREATE TYPE "session_client" AS ENUM ('WEB', 'MOBILE');

-- CreateEnum
CREATE TYPE "session_revoke_reason" AS ENUM ('LOGOUT', 'REUSE_DETECTED', 'ADMIN');

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "active_tenant_id" UUID,
    "client" "session_client" NOT NULL,
    "user_agent" TEXT,
    "ip" TEXT,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoke_reason" "session_revoke_reason",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "rotated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_user_id_id_key" ON "sessions"("user_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_session_id_idx" ON "refresh_tokens"("session_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_tenant_id_fkey" FOREIGN KEY ("active_tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_session_id_fkey" FOREIGN KEY ("user_id", "session_id") REFERENCES "sessions"("user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════ Hand-written: auth security (see docs/auth.md) ═══════════════════════
-- Role jantrik_auth (NOLOGIN, NOBYPASSRLS) is created by docker/postgres/init/01-roles.sh.

-- ───────────────────────── Current user helper ─────────────────────────
-- Same pattern as app_current_tenant_id(): NULL when unset or '' (pooled connection).
CREATE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
GRANT EXECUTE ON FUNCTION app_current_user_id() TO jantrik_app;

-- ───────────────────────── users: RLS ─────────────────────────
-- Visible: yourself, or people with a membership in the current tenant.
-- Updatable: yourself only (a person may belong to several tenants).
-- No INSERT/DELETE for the app: users are created via app_find_or_create_user().
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_visible ON users FOR SELECT
  USING (
    id = app_current_user_id()
    OR EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = users.id AND m.tenant_id = app_current_tenant_id()
    )
  );
CREATE POLICY users_update_self ON users FOR UPDATE
  USING (id = app_current_user_id())
  WITH CHECK (id = app_current_user_id());
REVOKE INSERT, DELETE ON users FROM jantrik_app;

-- ───────────────────────── sessions / refresh_tokens: RLS ─────────────────────────
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY session_owner ON sessions
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());

ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY session_owner ON refresh_tokens
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());

GRANT SELECT, INSERT, UPDATE ON sessions, refresh_tokens TO jantrik_app;

-- ───────────────────────── jantrik_auth: what the definer functions may see ─────────────────────────
GRANT USAGE, CREATE ON SCHEMA public TO jantrik_auth;
GRANT SELECT ON users, memberships, tenants, sessions, refresh_tokens TO jantrik_auth;
GRANT INSERT ON users TO jantrik_auth;

CREATE POLICY auth_lookup ON users FOR SELECT TO jantrik_auth USING (true);
CREATE POLICY auth_create ON users FOR INSERT TO jantrik_auth WITH CHECK (true);
CREATE POLICY auth_lookup ON memberships FOR SELECT TO jantrik_auth USING (true);
CREATE POLICY auth_lookup ON tenants FOR SELECT TO jantrik_auth USING (true);
CREATE POLICY auth_lookup ON sessions FOR SELECT TO jantrik_auth USING (true);
CREATE POLICY auth_lookup ON refresh_tokens FOR SELECT TO jantrik_auth USING (true);

-- ───────────────────────── SECURITY DEFINER functions ─────────────────────────
-- Each is narrow, has a fixed search_path, is owned by jantrik_auth and executable only by
-- jantrik_app. They exist for the few lookups that must happen before a context exists.

-- Login: find a user by phone (E.164) or email. Returns the password hash for argon2 verify.
CREATE FUNCTION auth_find_user_for_login(p_phone text, p_email text)
  RETURNS TABLE (id uuid, name text, locale locale, password_hash text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT u.id, u.name, u.locale, u.password_hash
    FROM users u
    WHERE (p_phone IS NOT NULL AND u.phone = p_phone)
       OR (p_email IS NOT NULL AND lower(u.email) = lower(p_email))
    LIMIT 1
  $$;

-- Memberships of the *current* user (app.user_id) across all tenants. No user-id parameter,
-- so it can only be called for a user the API has already authenticated.
CREATE FUNCTION auth_list_my_memberships()
  RETURNS TABLE (
    tenant_id uuid, tenant_slug text, tenant_name text, tenant_status tenant_status,
    role role, membership_status membership_status
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT t.id, t.slug, t.name, t.status, m.role, m.status
    FROM memberships m
    JOIN tenants t ON t.id = m.tenant_id
    WHERE m.user_id = app_current_user_id()
    ORDER BY t.name, m.role
  $$;

-- Public tenant info by slug (e.g. a subdomain or login page).
CREATE FUNCTION auth_resolve_tenant(p_slug text)
  RETURNS TABLE (id uuid, name text, status tenant_status, default_locale locale)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT t.id, t.name, t.status, t.default_locale FROM tenants t WHERE t.slug = p_slug
  $$;

-- Refresh: the presented token's hash → token + session state (the user is not known yet).
CREATE FUNCTION auth_find_refresh_token(p_token_hash text)
  RETURNS TABLE (
    token_id uuid, session_id uuid, user_id uuid, token_expires_at timestamptz,
    rotated_at timestamptz, session_expires_at timestamptz, revoked_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT r.id, s.id, s.user_id, r.expires_at, r.rotated_at, s.expires_at, s.revoked_at
    FROM refresh_tokens r
    JOIN sessions s ON s.id = r.session_id
    WHERE r.token_hash = p_token_hash
  $$;

-- Staff/seed: get the user id for a phone, creating the person if new. Returns only the id,
-- so a person who exists in another tenant is not exposed. Requires a tenant context.
CREATE FUNCTION app_find_or_create_user(p_phone text, p_name text)
  RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  DECLARE
    v_id uuid;
  BEGIN
    IF app_current_tenant_id() IS NULL THEN
      RAISE EXCEPTION 'app_find_or_create_user requires a tenant context'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    INSERT INTO users (id, phone, name, updated_at)
    VALUES (gen_random_uuid(), p_phone, p_name, now())
    ON CONFLICT (phone) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      SELECT u.id INTO v_id FROM users u WHERE u.phone = p_phone;
    END IF;
    RETURN v_id;
  END
  $$;

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'auth_find_user_for_login(text, text)',
    'auth_list_my_memberships()',
    'auth_resolve_tenant(text)',
    'auth_find_refresh_token(text)',
    'app_find_or_create_user(text, text)'
  ]
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO jantrik_auth', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO jantrik_app', f);
  END LOOP;
END
$$;
