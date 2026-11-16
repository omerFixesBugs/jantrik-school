-- P1-J: the app login (jantrik_app) never reads a password hash, its own or anyone's, so an SQL
-- injection in an institute request cannot take staff hashes away to crack offline. Only the
-- password-login login (jantrik_login_app, DATABASE_LOGIN_URL) may look a hash up, through one
-- function (docs/database.md → users, docs/auth.md → The API never reads a hash in a request).
-- jantrik_login_app must exist first: docker/postgres/init/01-roles.sh, or for an existing local
-- volume the commands in docs/database.md → Database roles; deploy/postgres/create-roles.sh in
-- production.
--
-- Prisma does not run a migration in one transaction: a statement that fails leaves the ones
-- before it applied. So the role is checked first, before anything changes, and every statement
-- can run again (after `prisma migrate resolve --rolled-back 20261116000000_users_password_hash_hidden`).

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'jantrik_login_app') THEN
    RAISE EXCEPTION 'create the role jantrik_login_app first: docs/deploy.md → Upgrades (production), docs/database.md → Database roles (development)';
  END IF;
END
$$;

-- ───────────── users: SELECT by column, every column but password_hash ─────────────
-- A table-level SELECT covers every column (a column REVOKE would change nothing), so the table
-- grant goes and the columns are granted one by one. A new users column needs its own GRANT.
-- UPDATE on password_hash stays (P1-B): setting a password writes it.
REVOKE SELECT ON users FROM jantrik_app;
GRANT SELECT (id, phone, email, name, name_bn, password_changed_at, locale, color_scheme,
              created_at, updated_at)
  ON users TO jantrik_app;

-- ───────────── auth_find_user_for_login(): no password data ─────────────
-- It returned password_hash of any user by phone or email, which made the column grant above
-- pointless. The OTP login and the profile read need only who the person is. A changed result type
-- needs DROP + CREATE. Privileges are set BEFORE the ownership change (see
-- fix_definer_function_privileges).
DROP FUNCTION IF EXISTS auth_find_user_for_login(text, text);
CREATE FUNCTION auth_find_user_for_login(p_phone text, p_email text)
  RETURNS TABLE (id uuid, name text, locale locale)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT u.id, u.name, u.locale
    FROM users u
    WHERE (p_phone IS NOT NULL AND u.phone = p_phone)
       OR (p_email IS NOT NULL AND lower(u.email) = lower(p_email))
    LIMIT 1
  $$;
REVOKE ALL ON FUNCTION auth_find_user_for_login(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_user_for_login(text, text) TO jantrik_app;
ALTER FUNCTION auth_find_user_for_login(text, text) OWNER TO jantrik_auth;

-- ───────────── auth_find_user_for_password_login(): the hash, for the login login only ─────────────
-- The password login (POST /auth/login) runs this on its own login (jantrik_login_app), which has
-- no table grants and may run nothing else, so an injection in an ordinary request (jantrik_app)
-- cannot reach it. The API verifies the password with argon2 itself.
DROP FUNCTION IF EXISTS auth_find_user_for_password_login(text, text);
CREATE FUNCTION auth_find_user_for_password_login(p_phone text, p_email text)
  RETURNS TABLE (id uuid, name text, locale locale, password_hash text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT u.id, u.name, u.locale, u.password_hash
    FROM users u
    WHERE (p_phone IS NOT NULL AND u.phone = p_phone)
       OR (p_email IS NOT NULL AND lower(u.email) = lower(p_email))
    LIMIT 1
  $$;
REVOKE ALL ON FUNCTION auth_find_user_for_password_login(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_user_for_password_login(text, text) TO jantrik_login_app;
ALTER FUNCTION auth_find_user_for_password_login(text, text) OWNER TO jantrik_auth;

-- The login login reaches the function through the schema; nothing else (no table grants).
GRANT USAGE ON SCHEMA public TO jantrik_login_app;

-- ───────────── auth_my_password_is_set(): GET /me/password's hasPassword ─────────────
-- Scoped by app.user_id. A request can set that to any id with set_config, so an injection can
-- learn whether a given person has a password (yes or no, nothing more): docs/auth.md.
DROP FUNCTION IF EXISTS auth_my_password_is_set();
CREATE FUNCTION auth_my_password_is_set()
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = app_current_user_id() AND u.password_hash IS NOT NULL
    )
  $$;
REVOKE ALL ON FUNCTION auth_my_password_is_set() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_my_password_is_set() TO jantrik_app;
ALTER FUNCTION auth_my_password_is_set() OWNER TO jantrik_auth;
