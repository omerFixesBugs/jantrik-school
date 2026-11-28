-- Sprint 1 P3b (docs/admission.md → The public form): what the NOLOGIN role jantrik_admission,
-- owner of the three public admission functions, may see and write (decision S4). Grants by
-- column and `TO jantrik_admission` policies, as the device receiver's jantrik_ingest: the
-- functions scope every statement by the institute they resolved from the slug themselves.
-- jantrik_app is NOT a member of it, so these policies never widen what the API sees.

-- The role is created outside migrations (jantrik_owner cannot create roles, decision P3-P):
-- docker/postgres/init/01-roles.sh for new volumes and CI, deploy/postgres/create-roles.sh in
-- production, and docs/database.md → Database roles for an existing volume. Checked first, so a
-- missing role stops here with nothing applied.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'jantrik_admission') THEN
    RAISE EXCEPTION 'The role jantrik_admission does not exist. Create it first (docs/database.md → Database roles): CREATE ROLE jantrik_admission NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT jantrik_admission TO jantrik_owner WITH INHERIT FALSE, SET TRUE;';
  END IF;
END $$;

-- CREATE: a function's new owner needs it (ALTER FUNCTION … OWNER TO), as for jantrik_ingest;
-- the next migration takes it back once the functions are handed over.
GRANT USAGE, CREATE ON SCHEMA public TO jantrik_admission;
-- Its queries also meet the tables' tenant_isolation policies; those call the context through
-- app_current_tenant_id() (P1-J8), which needs no grant to this role. With no context set (the
-- public functions never set one) they read as "no institute", so only the policies below apply.

-- The institute behind a slug: whether it takes applications, its name and language.
GRANT SELECT (id, slug, name, status, timezone, default_locale) ON tenants TO jantrik_admission;
CREATE POLICY admission_read ON tenants FOR SELECT TO jantrik_admission USING (true);
GRANT SELECT (tenant_id, name_bn, name_en) ON institute_profiles TO jantrik_admission;
CREATE POLICY admission_read ON institute_profiles FOR SELECT TO jantrik_admission USING (true);

-- The cycle's year (application numbers) and the class and group names on the form.
GRANT SELECT (tenant_id, id, start_date) ON academic_years TO jantrik_admission;
CREATE POLICY admission_read ON academic_years FOR SELECT TO jantrik_admission USING (true);
GRANT SELECT (tenant_id, id, name_bn, name_en, is_active, sort_order)
  ON class_levels TO jantrik_admission;
CREATE POLICY admission_read ON class_levels FOR SELECT TO jantrik_admission USING (true);
GRANT SELECT (tenant_id, id, name_bn, name_en, is_active, sort_order)
  ON study_groups TO jantrik_admission;
CREATE POLICY admission_read ON study_groups FOR SELECT TO jantrik_admission USING (true);

-- Cycles and their classes: read only.
GRANT SELECT ON admission_cycles TO jantrik_admission;
CREATE POLICY admission_read ON admission_cycles FOR SELECT TO jantrik_admission USING (true);
GRANT SELECT ON admission_cycle_classes TO jantrik_admission;
CREATE POLICY admission_read ON admission_cycle_classes FOR SELECT TO jantrik_admission
  USING (true);

-- Applications: inserted (status SUBMITTED by default, never the staff columns), and read back
-- only for the duplicate and per-phone checks and the status page.
GRANT SELECT (tenant_id, id, cycle_id, cycle_class_id, application_no, phone, name_key, name_bn,
              name_en, date_of_birth, birth_registration_no, status, submitted_at)
  ON admission_applications TO jantrik_admission;
GRANT INSERT (id, tenant_id, cycle_id, cycle_class_id, application_no, source, name_bn, name_en,
              name_key, date_of_birth, gender, religion, blood_group, birth_registration_no,
              previous_institute, present_address, permanent_address, father_name_bn,
              father_name_en, mother_name_bn, mother_name_en, guardian_name_bn, guardian_name_en,
              guardian_relation, guardian_occupation, phone, submitted_at, created_at, updated_at)
  ON admission_applications TO jantrik_admission;
CREATE POLICY admission_read ON admission_applications FOR SELECT TO jantrik_admission
  USING (true);
CREATE POLICY admission_insert ON admission_applications FOR INSERT TO jantrik_admission
  WITH CHECK (true);

-- The applicant's photo: inserted with the application, never read here.
GRANT INSERT ON admission_application_photos TO jantrik_admission;
CREATE POLICY admission_insert ON admission_application_photos FOR INSERT TO jantrik_admission
  WITH CHECK (true);

-- The numbers: one row per institute and year, taken with INSERT … ON CONFLICT DO UPDATE.
GRANT SELECT, INSERT ON admission_counters TO jantrik_admission;
GRANT UPDATE (last_no, updated_at) ON admission_counters TO jantrik_admission;
CREATE POLICY admission_read ON admission_counters FOR SELECT TO jantrik_admission USING (true);
CREATE POLICY admission_insert ON admission_counters FOR INSERT TO jantrik_admission
  WITH CHECK (true);
CREATE POLICY admission_update ON admission_counters FOR UPDATE TO jantrik_admission
  USING (true) WITH CHECK (true);
