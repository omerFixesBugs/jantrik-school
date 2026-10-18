-- CreateTable
CREATE TABLE "student_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code_prefix" TEXT NOT NULL,
    "code_pattern" TEXT NOT NULL DEFAULT '{PREFIX}-{YEAR}-{NNNN}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_code_counters" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "next_value" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_code_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "student_settings_tenant_id_key" ON "student_settings"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_settings_tenant_id_id_key" ON "student_settings"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "student_code_counters_tenant_id_id_key" ON "student_code_counters"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "student_code_counters_tenant_id_year_key" ON "student_code_counters"("tenant_id", "year");

-- AddForeignKey
ALTER TABLE "student_settings" ADD CONSTRAINT "student_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_code_counters" ADD CONSTRAINT "student_code_counters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-Level Security (docs/database.md, .claude/skills/add-tenant-table).
ALTER TABLE student_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON student_settings
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE student_code_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_code_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON student_code_counters
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Settings and counters are only ever upserted, never deleted.
GRANT SELECT, INSERT, UPDATE ON student_settings, student_code_counters TO jantrik_app;

ALTER TABLE student_settings
  ADD CONSTRAINT student_settings_prefix_format CHECK (code_prefix ~ '^[A-Z0-9]{1,10}$'),
  ADD CONSTRAINT student_settings_pattern_length CHECK (char_length(code_pattern) BETWEEN 1 AND 40);
ALTER TABLE student_code_counters
  ADD CONSTRAINT student_code_counters_year_range CHECK (year BETWEEN 1900 AND 2200),
  ADD CONSTRAINT student_code_counters_next_positive CHECK (next_value >= 1);
