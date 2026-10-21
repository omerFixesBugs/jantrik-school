-- Default theme per institute type (reference data; templates.ts seeds the same values).
UPDATE institute_types SET default_theme = 'ENGLISH_MEDIUM' WHERE key = 'NCTB_SCHOOL_EN';
UPDATE institute_types SET default_theme = 'COACHING' WHERE key = 'COACHING';

-- Row-Level Security (docs/database.md, .claude/skills/add-tenant-table).
ALTER TABLE appearance_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE appearance_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON appearance_settings
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Upserted by the owner, never deleted.
GRANT SELECT, INSERT, UPDATE ON appearance_settings TO jantrik_app;

ALTER TABLE appearance_settings
  ADD CONSTRAINT appearance_settings_accent_format CHECK (accent IS NULL OR accent ~ '^#[0-9a-f]{6}$');
