-- AlterTable
ALTER TABLE "memberships" ADD COLUMN     "invited_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "staff_profiles" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "name_bn" TEXT,
    "phone" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_profiles_tenant_id_id_key" ON "staff_profiles"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_profiles_tenant_id_user_id_key" ON "staff_profiles"("tenant_id", "user_id");

-- AddForeignKey
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ───────────── staff_profiles: RLS, grants, checks (add-tenant-table skill) ─────────────
ALTER TABLE staff_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_profiles
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON staff_profiles TO jantrik_app;
ALTER TABLE staff_profiles
  ADD CONSTRAINT staff_profiles_phone_bd_format CHECK (phone ~ '^\+8801[3-9][0-9]{8}$'),
  ADD CONSTRAINT staff_profiles_name_length CHECK (char_length(name) BETWEEN 1 AND 100),
  ADD CONSTRAINT staff_profiles_name_bn_length CHECK (name_bn IS NULL OR char_length(name_bn) BETWEEN 1 AND 100);

-- ───────────── users: invited/declined people stay invisible to the institute ─────────────
-- A pending or declined invitation must not reveal the person's global row (their own name,
-- possibly set by another institute) to the inviting institute.
DROP POLICY users_visible ON users;
CREATE POLICY users_visible ON users FOR SELECT
  USING (
    id = app_current_user_id()
    OR EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = users.id
        AND m.tenant_id = app_current_tenant_id()
        AND m.status NOT IN ('INVITED', 'DECLINED')
    )
  );

-- ───────────── auth_list_my_memberships(): also return invited_at ─────────────
-- So a person's pending invitations can be listed (and expired ones left out) before they have
-- access to that institute. Same body otherwise; a changed result type needs DROP + CREATE.
-- Privileges are set BEFORE the ownership change (see fix_definer_function_privileges).
DROP FUNCTION auth_list_my_memberships();
CREATE FUNCTION auth_list_my_memberships()
  RETURNS TABLE (
    tenant_id uuid, tenant_slug text, tenant_name text, tenant_status tenant_status,
    role role, membership_status membership_status, invited_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT t.id, t.slug, t.name, t.status, m.role, m.status, m.invited_at
    FROM memberships m
    JOIN tenants t ON t.id = m.tenant_id
    WHERE m.user_id = app_current_user_id()
    ORDER BY t.name, m.role
  $$;
REVOKE ALL ON FUNCTION auth_list_my_memberships() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_list_my_memberships() TO jantrik_app;
ALTER FUNCTION auth_list_my_memberships() OWNER TO jantrik_auth;
