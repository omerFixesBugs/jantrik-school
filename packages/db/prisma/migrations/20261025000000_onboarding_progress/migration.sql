-- Step 8, part 5: the new owner's setup wizard.
--   * onboarding_progress: one row per institute the platform creates (made at provisioning by
--     the API's main role, in the institute's own RLS context). Institutes without a row never
--     see the wizard. Tenant table: RLS, no DELETE (finishing sets completed_at).

-- CreateTable
CREATE TABLE "onboarding_progress" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "steps" JSONB NOT NULL DEFAULT '{}',
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_progress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_progress_tenant_id_key" ON "onboarding_progress"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_progress_tenant_id_id_key" ON "onboarding_progress"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "onboarding_progress" ADD CONSTRAINT "onboarding_progress_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Tenant isolation (add-tenant-table checklist).
ALTER TABLE onboarding_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_progress FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON onboarding_progress
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON onboarding_progress TO jantrik_app;

-- Only the six steps, each 'done' or 'skipped'.
ALTER TABLE onboarding_progress ADD CONSTRAINT onboarding_progress_steps CHECK (
  CASE WHEN jsonb_typeof(steps) = 'object'
    THEN steps - ARRAY['year', 'classes', 'shifts', 'teachers', 'students', 'attendance'] = '{}'::jsonb
         AND NOT jsonb_path_exists(steps, '$.* ? (@ != "done" && @ != "skipped")')
    ELSE false
  END
);
