-- Step 8, part 1, after review:
--   1. The platform_* functions run only for jantrik_platform_app, the API platform module's own
--      login role (DATABASE_PLATFORM_URL). jantrik_app (the rest of the API) loses EXECUTE, so an
--      SQL injection anywhere in the institute API cannot open or use a platform session.
--      jantrik_platform_app inherits jantrik_app (still under RLS) for platform actions that
--      touch an institute in the same transaction. The role is created outside migrations, like
--      the others (docker/postgres/init/01-roles.sh; production infrastructure).
--   2. Every older SECURITY DEFINER function also searches pg_temp last, so a temporary table can
--      never stand in for a real one (schema-safety.test.ts now checks every definer function).

SET ROLE jantrik_platform;
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
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM jantrik_app', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO jantrik_platform_app', f);
  END LOOP;
END $$;
RESET ROLE;

SET ROLE jantrik_auth;
ALTER FUNCTION auth_find_user_for_login(text, text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION auth_list_my_memberships() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION auth_resolve_tenant(text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION auth_find_refresh_token(text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION app_find_or_create_user(text, text, text) SET search_path = pg_catalog, public, pg_temp;
RESET ROLE;

SET ROLE jantrik_search;
ALTER FUNCTION search_student_ids(text, text, integer) SET search_path = pg_catalog, public, pg_temp;
RESET ROLE;
