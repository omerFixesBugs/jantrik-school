-- P1-J8: a verified request context. Before, the request's institute and person were two
-- settings, app.tenant_id and app.user_id, that any statement in the transaction could overwrite
-- with set_config: an SQL injection could become anyone (write their password hash, insert a
-- session for them) and enter any institute. Now the API signs one setting, app.context, for the
-- transaction it runs in, with a key only the password-login login (jantrik_login_app) and the
-- schema owner can read, and app_current_tenant_id() / app_current_user_id() believe nothing else.
-- docs/database.md → The request context; docs/plans/sprint-1-p1j8-verified-context.md.
--
-- Prisma does not run a migration in one transaction: every statement below can run again (after
-- `prisma migrate resolve --rolled-back 20261117000000_verified_request_context`).
--
-- Rollback (by hand, as the owner): recreate app_current_tenant_id() / app_current_user_id() as
--   SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid  (and 'app.user_id'),
-- LANGUAGE sql STABLE PARALLEL SAFE, and deploy the previous API. The wrapped policies below work
-- with either version.

-- ───────────── The key ─────────────
-- One row, made here from pg_strong_random (three gen_random_uuid(), 366 random bits): this file
-- holds no secret and every database has its own key. inner_pad / outer_pad are the key XOR the
-- HMAC pads (0x36, 0x5c; the 48-byte key zero-padded to SHA-256's 64-byte block), so the check
-- needs only the built-in sha256() (pgcrypto is not installed).
CREATE TABLE IF NOT EXISTS "app_context_key" (
    "id" SMALLINT NOT NULL,
    "key" BYTEA NOT NULL,
    "inner_pad" BYTEA NOT NULL,
    "outer_pad" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_context_key_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname = 'app_context_key_shape') THEN
    ALTER TABLE app_context_key ADD CONSTRAINT app_context_key_shape CHECK (
      id = 1 AND length(key) = 48 AND length(inner_pad) = 64 AND length(outer_pad) = 64);
  END IF;
END
$$;

DO $$
DECLARE
  v_key bytea;
  v_block bytea;
  v_inner bytea;
  v_outer bytea;
BEGIN
  IF EXISTS (SELECT FROM app_context_key) THEN
    RETURN; -- a re-run keeps the key it made
  END IF;
  v_key := uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid());
  v_block := v_key || '\x00000000000000000000000000000000'::bytea;
  v_inner := v_block;
  v_outer := v_block;
  FOR i IN 0..63 LOOP
    v_inner := set_byte(v_inner, i, get_byte(v_block, i) # 54);  -- 0x36
    v_outer := set_byte(v_outer, i, get_byte(v_block, i) # 92);  -- 0x5c
  END LOOP;
  INSERT INTO app_context_key (id, key, inner_pad, outer_pad) VALUES (1, v_key, v_inner, v_outer);
END
$$;

-- Only the owner (this file's login) and jantrik_auth, the owner of the two functions below. No
-- runtime login reads the table.
REVOKE ALL ON app_context_key FROM PUBLIC;
GRANT SELECT ON app_context_key TO jantrik_auth;

-- ───────────── auth_context_key(): the key, for the password-login login only ─────────────
-- The API and the worker read it once at start-up through jantrik_login_app (LoginPrismaService),
-- the login no ordinary request uses. jantrik_app may not run it. The seed and the tests read the
-- table as the owner.
DROP FUNCTION IF EXISTS auth_context_key();
CREATE FUNCTION auth_context_key()
  RETURNS bytea
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$ SELECT k.key FROM public.app_context_key k WHERE k.id = 1 $$;
REVOKE ALL ON FUNCTION auth_context_key() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_context_key() TO jantrik_login_app;
ALTER FUNCTION auth_context_key() OWNER TO jantrik_auth;

-- ───────────── app_verified_context(): the only reader of app.context ─────────────
-- app.context = 'v1:<tenant uuid or empty>:<user uuid or empty>:<backend pid>:<transaction start,
-- µs since 1970>:<HMAC-SHA256(key, everything before the last colon), 64 hex digits>'.
-- Unset or '' → no context (NULLs), as before. Anything else must be exact, correctly signed and
-- name this backend and this transaction; otherwise 42501, one message for every reason. Bound to
-- the transaction, a copied string is useless anywhere else. The MACs are compared through
-- sha256, so the comparison time does not depend on how many bytes match.
-- PARALLEL RESTRICTED: pg_backend_pid() differs in a parallel worker.
-- EXECUTE for PUBLIC (like app_current_tenant_id()): every login that meets a policy calls it, and
-- it only returns the caller's own verified context.
DROP FUNCTION IF EXISTS app_verified_context();
CREATE FUNCTION app_verified_context(OUT tenant_id uuid, OUT user_id uuid)
  LANGUAGE plpgsql STABLE PARALLEL RESTRICTED SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_raw text := current_setting('app.context', true);
    v_parts text[];
    v_inner bytea;
    v_outer bytea;
    v_ok boolean;
  BEGIN
    IF v_raw IS NULL OR v_raw = '' THEN
      RETURN;
    END IF;
    IF v_raw !~ '^v1:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?:[1-9][0-9]{0,9}:[1-9][0-9]{0,17}:[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'invalid request context' USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_parts := string_to_array(v_raw, ':');
    SELECT k.inner_pad, k.outer_pad INTO v_inner, v_outer FROM public.app_context_key k WHERE k.id = 1;
    v_ok := sha256(sha256(v_outer || sha256(v_inner || convert_to(array_to_string(v_parts[1:5], ':'), 'UTF8'))))
              = sha256(decode(v_parts[6], 'hex'))
            AND v_parts[4]::bigint = pg_backend_pid()
            AND v_parts[5]::bigint = (extract(epoch FROM now()) * 1000000)::bigint;
    IF v_ok IS NOT TRUE THEN
      RAISE EXCEPTION 'invalid request context' USING ERRCODE = 'insufficient_privilege';
    END IF;
    tenant_id := NULLIF(v_parts[2], '')::uuid;
    user_id := NULLIF(v_parts[3], '')::uuid;
  END
  $$;
REVOKE ALL ON FUNCTION app_verified_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_verified_context() TO PUBLIC;
ALTER FUNCTION app_verified_context() OWNER TO jantrik_auth;

-- ───────────── The two context functions: same names, owners and grants ─────────────
-- Every policy and definer function calls these, so they all get the verified values now.
-- app.tenant_id and app.user_id mean nothing any more.
CREATE OR REPLACE FUNCTION app_current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL RESTRICTED
  AS $$ SELECT (public.app_verified_context()).tenant_id $$;
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL RESTRICTED
  AS $$ SELECT (public.app_verified_context()).user_id $$;

-- ───────────── Every policy: once per statement, not once per row ─────────────
-- A definer function is never inlined, so `tenant_id = app_current_tenant_id()` would check the
-- signature for every row a scan looks at. As a scalar subquery, `(SELECT app_current_tenant_id())`,
-- PostgreSQL runs it once per statement (an InitPlan) and still uses it as an index condition.
-- Idempotent: calls already wrapped (deparsed as `( SELECT app_current_x_id() AS app_current_x_id)`)
-- stay as they are. schema-safety.test.ts fails on any unwrapped call.
DO $$
DECLARE
  r record;
  v_qual text;
  v_check text;
  v_wrapped constant text := '\( SELECT (?:public\.)?app_current_(tenant|user)_id\(\) AS app_current_\1_id\)';
  v_bare constant text := '(?:public\.)?app_current_(tenant|user)_id\(\)';
BEGIN
  FOR r IN
    SELECT p.polname, c.relname,
           pg_get_expr(p.polqual, p.polrelid) AS qual,
           pg_get_expr(p.polwithcheck, p.polrelid) AS chk
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE c.relnamespace = 'public'::regnamespace
  LOOP
    v_qual := regexp_replace(regexp_replace(regexp_replace(r.qual,
      v_wrapped, '@@ctx_\1@@', 'g'), v_bare, '(SELECT app_current_\1_id())', 'g'),
      '@@ctx_(tenant|user)@@', '(SELECT app_current_\1_id())', 'g');
    v_check := regexp_replace(regexp_replace(regexp_replace(r.chk,
      v_wrapped, '@@ctx_\1@@', 'g'), v_bare, '(SELECT app_current_\1_id())', 'g'),
      '@@ctx_(tenant|user)@@', '(SELECT app_current_\1_id())', 'g');
    IF r.qual IS NOT NULL AND regexp_replace(r.qual, v_wrapped, '', 'g') ~ v_bare THEN
      EXECUTE format('ALTER POLICY %I ON public.%I USING (%s)', r.polname, r.relname, v_qual);
    END IF;
    IF r.chk IS NOT NULL AND regexp_replace(r.chk, v_wrapped, '', 'g') ~ v_bare THEN
      EXECUTE format('ALTER POLICY %I ON public.%I WITH CHECK (%s)', r.polname, r.relname, v_check);
    END IF;
  END LOOP;
END
$$;

-- ───────────── tenant_modules.provisioning_only: no subquery on its own table ─────────────
-- Its WITH CHECK read tenant_modules in a subquery. With tenant_modules' own tenant_isolation
-- now holding a subquery too, PostgreSQL's policy rewriter refuses that as "infinite recursion"
-- (42P17). The same check moves into a function, which runs as a query of its own: STABLE (the
-- statement's snapshot, as the subquery had), invoker (the caller's RLS, so it sees the current
-- institute's rows only, as before), plpgsql so it is never inlined back into the policy.
CREATE OR REPLACE FUNCTION app_tenant_has_modules(p_tenant_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    RETURN EXISTS (SELECT 1 FROM public.tenant_modules m WHERE m.tenant_id = p_tenant_id);
  END
  $$;
REVOKE ALL ON FUNCTION app_tenant_has_modules(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_tenant_has_modules(uuid) TO jantrik_app;
ALTER POLICY provisioning_only ON tenant_modules WITH CHECK (NOT app_tenant_has_modules(tenant_id));

-- ───────────── The definer functions that call them: wrapped too ─────────────
-- Bodies unchanged but for the wrapper. Privileges are set before the ownership change, as in
-- the migrations that made them.
DROP FUNCTION IF EXISTS app_find_or_create_user(text, text, text);
CREATE FUNCTION app_find_or_create_user(p_phone text, p_name text, p_name_bn text)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  DECLARE
    v_id uuid;
  BEGIN
    IF (SELECT app_current_tenant_id()) IS NULL THEN
      RAISE EXCEPTION 'app_find_or_create_user requires a tenant context'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    INSERT INTO users (id, phone, name, name_bn, updated_at)
    VALUES (gen_random_uuid(), p_phone, p_name, NULLIF(btrim(p_name_bn), ''), now())
    ON CONFLICT (phone) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      SELECT u.id INTO v_id FROM users u WHERE u.phone = p_phone;
    END IF;
    RETURN v_id;
  END
  $$;
REVOKE ALL ON FUNCTION app_find_or_create_user(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_find_or_create_user(text, text, text) TO jantrik_app;
ALTER FUNCTION app_find_or_create_user(text, text, text) OWNER TO jantrik_auth;

DROP FUNCTION IF EXISTS auth_list_my_memberships();
CREATE FUNCTION auth_list_my_memberships()
  RETURNS TABLE (tenant_id uuid, tenant_slug text, tenant_name text, tenant_status tenant_status,
                 role role, membership_status membership_status, invited_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT t.id, t.slug, t.name, t.status, m.role, m.status, m.invited_at
    FROM memberships m
    JOIN tenants t ON t.id = m.tenant_id
    WHERE m.user_id = (SELECT app_current_user_id())
    ORDER BY t.name, m.role
  $$;
REVOKE ALL ON FUNCTION auth_list_my_memberships() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_list_my_memberships() TO jantrik_app;
ALTER FUNCTION auth_list_my_memberships() OWNER TO jantrik_auth;

-- Scoped by the verified person now: P1-J2's one bit (does a given person have a password?) is
-- no longer open to an injection.
DROP FUNCTION IF EXISTS auth_my_password_is_set();
CREATE FUNCTION auth_my_password_is_set()
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = (SELECT app_current_user_id()) AND u.password_hash IS NOT NULL
    )
  $$;
REVOKE ALL ON FUNCTION auth_my_password_is_set() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_my_password_is_set() TO jantrik_app;
ALTER FUNCTION auth_my_password_is_set() OWNER TO jantrik_auth;

DROP FUNCTION IF EXISTS search_student_ids(text, text, integer);
CREATE FUNCTION search_student_ids(p_term text, p_phone text DEFAULT NULL, p_limit integer DEFAULT 2000)
  RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    WITH pattern AS (
      -- Escape LIKE wildcards so user input is matched literally.
      SELECT '%' || replace(replace(replace(p_term, '\', '\\'), '%', '\%'), '_', '\_') || '%' AS term,
             CASE WHEN p_phone IS NULL OR p_phone = '' THEN NULL
                  ELSE '%' || replace(replace(replace(p_phone, '\', '\\'), '%', '\%'), '_', '\_') || '%'
             END AS phone
    )
    SELECT ids.id FROM (
      SELECT s.id
      FROM students s, pattern p
      WHERE s.tenant_id = (SELECT app_current_tenant_id())
        AND s.deleted_at IS NULL
        AND (s.name_en ILIKE p.term OR s.name_bn ILIKE p.term OR s.student_code ILIKE p.term)
      UNION
      SELECT sg.student_id
      FROM guardians g
      JOIN pattern p ON p.phone IS NOT NULL
      JOIN student_guardians sg ON sg.guardian_id = g.id AND sg.tenant_id = g.tenant_id
      JOIN students s ON s.id = sg.student_id AND s.tenant_id = sg.tenant_id
      WHERE g.tenant_id = (SELECT app_current_tenant_id())
        AND s.deleted_at IS NULL
        AND g.phone ILIKE p.phone
    ) ids
    LIMIT p_limit
  $$;
REVOKE ALL ON FUNCTION search_student_ids(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_student_ids(text, text, integer) TO jantrik_app;
ALTER FUNCTION search_student_ids(text, text, integer) OWNER TO jantrik_search;
