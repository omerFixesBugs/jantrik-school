-- CreateEnum
CREATE TYPE "student_import_status" AS ENUM ('UPLOADED', 'VALIDATED', 'QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "student_imports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "status" "student_import_status" NOT NULL DEFAULT 'UPLOADED',
    "file_name" TEXT NOT NULL,
    "headers" JSONB NOT NULL,
    "rows" JSONB,
    "mapping" JSONB,
    "results" JSONB,
    "row_count" INTEGER NOT NULL,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "failure" TEXT,
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_imports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "student_imports_tenant_id_created_at_idx" ON "student_imports"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "student_imports_tenant_id_id_key" ON "student_imports"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "student_imports" ADD CONSTRAINT "student_imports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_imports" ADD CONSTRAINT "student_imports_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-Level Security (docs/database.md, .claude/skills/add-tenant-table).
ALTER TABLE student_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON student_imports
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Import history is kept: no DELETE for the app (raw rows are cleared with an UPDATE).
GRANT SELECT, INSERT, UPDATE ON student_imports TO jantrik_app;

ALTER TABLE student_imports
  ADD CONSTRAINT student_imports_row_count_range CHECK (row_count BETWEEN 0 AND 5000),
  ADD CONSTRAINT student_imports_processed_range CHECK (processed BETWEEN 0 AND row_count),
  ADD CONSTRAINT student_imports_file_name_length CHECK (char_length(file_name) BETWEEN 1 AND 255);
