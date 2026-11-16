-- P1-J: the app login (jantrik_app) never reads a password hash, its own or anyone's, so an SQL
-- injection in a request cannot take staff hashes away to crack offline (docs/database.md → users).

-- ───────────── users: SELECT by column, every column but password_hash ─────────────
-- A table-level SELECT covers every column (a column REVOKE would change nothing), so the table
-- grant goes and the columns are granted one by one. A new users column needs its own GRANT.
-- UPDATE on password_hash stays (P1-B): setting a password writes it.
REVOKE SELECT ON users FROM jantrik_app;
GRANT SELECT (id, phone, email, name, name_bn, password_changed_at, locale, color_scheme,
              created_at, updated_at)
  ON users TO jantrik_app;

-- ───────────── auth_find_user_for_login(): parameters and salt, never the digest ─────────────
-- It returned password_hash of any user by phone or email, which made the column grant above
-- pointless. It now returns the PHC string up to its last `$` (argon2id, version 19, m, t, p and
-- the salt); the API hashes the typed password with them and auth_my_password_matches() compares.
-- Only the format Jantrik writes is accepted (a 32-byte digest); anything else gives NULL, as a
-- corrupt hash would fail today. A changed result type needs DROP + CREATE. Privileges are set
-- BEFORE the ownership change (see fix_definer_function_privileges).
DROP FUNCTION auth_find_user_for_login(text, text);
CREATE FUNCTION auth_find_user_for_login(p_phone text, p_email text)
  RETURNS TABLE (id uuid, name text, locale locale, password_params text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT u.id, u.name, u.locale,
           substring(u.password_hash FROM
             '^(\$argon2id\$v=19\$m=[0-9]{1,10},t=[0-9]{1,10},p=[0-9]{1,3}\$[A-Za-z0-9+/]{11,64})\$[A-Za-z0-9+/]{43}$')
    FROM users u
    WHERE (p_phone IS NOT NULL AND u.phone = p_phone)
       OR (p_email IS NOT NULL AND lower(u.email) = lower(p_email))
    LIMIT 1
  $$;
REVOKE ALL ON FUNCTION auth_find_user_for_login(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_user_for_login(text, text) TO jantrik_app;
ALTER FUNCTION auth_find_user_for_login(text, text) OWNER TO jantrik_auth;

-- ───────────── auth_my_password_matches(digest): the comparison, inside the database ─────────────
-- True when the current user's (app.user_id) stored hash has this SHA-256. The API sends the
-- SHA-256 of the hash it computed from the typed password, so the digest never leaves the
-- database, and what travels is fixed-size. No user parameter: scoped by context, like
-- auth_list_my_memberships().
CREATE FUNCTION auth_my_password_matches(p_digest bytea)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = app_current_user_id()
        AND u.password_hash IS NOT NULL
        AND sha256(convert_to(u.password_hash, 'UTF8')) = p_digest
    )
  $$;
REVOKE ALL ON FUNCTION auth_my_password_matches(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_my_password_matches(bytea) TO jantrik_app;
ALTER FUNCTION auth_my_password_matches(bytea) OWNER TO jantrik_auth;

-- ───────────── auth_my_password_is_set(): GET /me/password's hasPassword ─────────────
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
