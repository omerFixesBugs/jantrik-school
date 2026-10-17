-- Student search that can use the trigram indexes.
--
-- Why a definer function: ILIKE's operator (texticlike) is not LEAKPROOF, so under RLS Postgres
-- refuses to evaluate it before the row-security qual and can never use a trigram index for it
-- (it degrades to a filter over all of the tenant's rows). This function runs the match as
-- jantrik_search — a NOLOGIN, NOBYPASSRLS role whose only access is the SELECT-only policies
-- below — and scopes by the caller's tenant EXPLICITLY. It returns ids only; the API then loads
-- the students through normal RLS.
--
-- RLS checklist (docs/database.md): no new tables. New role jantrik_search (init script), new
-- `TO jantrik_search` policies, new definer function owned by it, executable by jantrik_app only.

GRANT USAGE, CREATE ON SCHEMA public TO jantrik_search;
GRANT SELECT ON students, guardians, student_guardians TO jantrik_search;
CREATE POLICY search_lookup ON students FOR SELECT TO jantrik_search USING (true);
CREATE POLICY search_lookup ON guardians FOR SELECT TO jantrik_search USING (true);
CREATE POLICY search_lookup ON student_guardians FOR SELECT TO jantrik_search USING (true);

-- p_term: matched against name_bn, name_en, student_code (substring, case-insensitive).
-- p_phone: digits to match inside guardian phones (NULL to skip).
-- Returns ids of non-deleted students of the CURRENT tenant only (no context → no rows).
CREATE FUNCTION search_student_ids(p_term text, p_phone text DEFAULT NULL, p_limit int DEFAULT 2000)
  RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
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
      WHERE s.tenant_id = app_current_tenant_id()
        AND s.deleted_at IS NULL
        AND (s.name_en ILIKE p.term OR s.name_bn ILIKE p.term OR s.student_code ILIKE p.term)
      UNION
      SELECT sg.student_id
      FROM guardians g
      JOIN pattern p ON p.phone IS NOT NULL
      JOIN student_guardians sg ON sg.guardian_id = g.id AND sg.tenant_id = g.tenant_id
      JOIN students s ON s.id = sg.student_id AND s.tenant_id = sg.tenant_id
      WHERE g.tenant_id = app_current_tenant_id()
        AND s.deleted_at IS NULL
        AND g.phone ILIKE p.phone
    ) ids
    LIMIT p_limit
  $$;

ALTER FUNCTION search_student_ids(text, text, int) OWNER TO jantrik_search;
REVOKE ALL ON FUNCTION search_student_ids(text, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_student_ids(text, text, int) TO jantrik_app;
