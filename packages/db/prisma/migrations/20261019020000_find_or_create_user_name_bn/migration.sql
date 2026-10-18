-- app_find_or_create_user gets an optional Bangla name for people created by staff (e.g. a new
-- teacher added on the staff page). It is written only when the person is NEW: an existing user
-- may belong to other tenants, and staff of this tenant must not rename them.
--
-- A changed parameter list is a new overload, so the old (text, text) version is dropped first
-- (otherwise it would linger with its EXECUTE grant). Privileges are set BEFORE the ownership
-- change (only a function's owner may change them; see fix_definer_function_privileges).

DROP FUNCTION app_find_or_create_user(text, text);

CREATE FUNCTION app_find_or_create_user(p_phone text, p_name text, p_name_bn text)
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
