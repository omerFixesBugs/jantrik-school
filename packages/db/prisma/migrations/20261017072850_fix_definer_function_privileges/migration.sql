-- Fix: restrict the SECURITY DEFINER functions to jantrik_app.
--
-- The earlier migrations changed each function's owner first and then ran REVOKE/GRANT as
-- jantrik_owner. Only a function's owner may change its privileges, so those statements were
-- silently no-ops: PUBLIC kept the default EXECUTE and the explicit grant to jantrik_app was
-- never recorded. Here each change runs as the owning role (jantrik_owner may SET ROLE to it).
--
-- Rule for future migrations (docs/database.md): REVOKE/GRANT on a function BEFORE handing its
-- ownership to another role, or SET ROLE to the owner first.

SET ROLE jantrik_auth;
REVOKE ALL ON FUNCTION auth_find_user_for_login(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_list_my_memberships() FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_resolve_tenant(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_find_refresh_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_find_or_create_user(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_user_for_login(text, text) TO jantrik_app;
GRANT EXECUTE ON FUNCTION auth_list_my_memberships() TO jantrik_app;
GRANT EXECUTE ON FUNCTION auth_resolve_tenant(text) TO jantrik_app;
GRANT EXECUTE ON FUNCTION auth_find_refresh_token(text) TO jantrik_app;
GRANT EXECUTE ON FUNCTION app_find_or_create_user(text, text) TO jantrik_app;
RESET ROLE;

SET ROLE jantrik_search;
REVOKE ALL ON FUNCTION search_student_ids(text, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_student_ids(text, text, int) TO jantrik_app;
RESET ROLE;
