-- Row-Level Security, grants and CHECK constraints for the Phase 1 core schema.
-- Hand-written (Prisma does not manage these). See docs/database.md.
--
-- Roles (created outside migrations, see docker/postgres/init/01-roles.sh):
--   jantrik_owner  owns every table, runs migrations. FORCE RLS applies to it too.
--   jantrik_app    runtime role: NOSUPERUSER NOBYPASSRLS, never owns tables.

-- ───────────────────────── Current tenant helper ─────────────────────────
-- Returns the tenant set via `set_config('app.tenant_id', <uuid>, true)` (= SET LOCAL),
-- or NULL when no tenant context is set. NULLIF handles the '' that Postgres reports for a
-- custom setting on a pooled connection after a previous SET LOCAL transaction ended.
-- A NULL tenant matches no rows, so "no context" means "no data", never an error.
CREATE FUNCTION app_current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- ───────────────────────── Row-Level Security ─────────────────────────
-- The tenants table is isolated on its own id.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = app_current_tenant_id())
  WITH CHECK (id = app_current_tenant_id());

-- Every other tenant-owned table is isolated on tenant_id.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_modules', 'tenant_labels', 'branches', 'academic_years', 'shifts',
    'grading_schemes', 'grade_bands', 'class_levels', 'study_groups', 'subjects', 'sections',
    'memberships', 'students', 'guardians', 'student_guardians', 'enrolments', 'audit_logs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = app_current_tenant_id())
         WITH CHECK (tenant_id = app_current_tenant_id())',
      t
    );
  END LOOP;
END
$$;

-- ───────────────────────── Grants for the app role ─────────────────────────
-- No default privileges on purpose: a new table is invisible to the app until its migration
-- grants access explicitly (see the checklist in docs/database.md).
GRANT USAGE ON SCHEMA public TO jantrik_app;
GRANT EXECUTE ON FUNCTION app_current_tenant_id() TO jantrik_app;

-- Global reference data: read-only (written by migrations / seed as the owner).
GRANT SELECT ON
  institute_types, grading_scheme_templates, grade_band_templates,
  template_class_levels, template_study_groups, template_subjects, template_labels
TO jantrik_app;

-- Global people.
GRANT SELECT, INSERT, UPDATE, DELETE ON users TO jantrik_app;

-- Tenant-owned tables (RLS applies).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenants, tenant_modules, tenant_labels, branches, academic_years, shifts,
  grading_schemes, grade_bands, class_levels, study_groups, subjects, sections,
  memberships, students, guardians, student_guardians, enrolments
TO jantrik_app;

-- Audit log is append-only for the app.
GRANT SELECT, INSERT ON audit_logs TO jantrik_app;

-- ───────────────────────── CHECK constraints ─────────────────────────
ALTER TABLE tenants
  ADD CONSTRAINT tenants_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 3 AND 63);

-- Bangladeshi mobile numbers in E.164: +880 1[3-9] XXXXXXXX
ALTER TABLE users
  ADD CONSTRAINT users_phone_bd_format CHECK (phone ~ '^\+8801[3-9][0-9]{8}$');
ALTER TABLE guardians
  ADD CONSTRAINT guardians_phone_bd_format CHECK (phone ~ '^\+8801[3-9][0-9]{8}$');

ALTER TABLE academic_years
  ADD CONSTRAINT academic_years_dates CHECK (end_date > start_date);
ALTER TABLE shifts
  ADD CONSTRAINT shifts_times CHECK (end_time > start_time);

ALTER TABLE grade_band_templates
  ADD CONSTRAINT grade_band_templates_range
    CHECK (min_percent >= 0 AND min_percent <= max_percent AND max_percent <= 100 AND grade_point >= 0);
ALTER TABLE grade_bands
  ADD CONSTRAINT grade_bands_range
    CHECK (min_percent >= 0 AND min_percent <= max_percent AND max_percent <= 100 AND grade_point >= 0);

ALTER TABLE students
  ADD CONSTRAINT students_name_present CHECK (name_bn IS NOT NULL OR name_en IS NOT NULL),
  ADD CONSTRAINT students_birth_registration_no_format CHECK (birth_registration_no ~ '^[0-9]{17}$');
ALTER TABLE guardians
  ADD CONSTRAINT guardians_name_present CHECK (name_bn IS NOT NULL OR name_en IS NOT NULL);

ALTER TABLE enrolments
  ADD CONSTRAINT enrolments_roll_positive CHECK (roll > 0);
ALTER TABLE sections
  ADD CONSTRAINT sections_capacity_positive CHECK (capacity > 0);
