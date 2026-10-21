-- CreateEnum
CREATE TYPE "theme_preset" AS ENUM ('SCHOOL', 'MADRASA', 'COACHING', 'ENGLISH_MEDIUM');

-- CreateEnum
CREATE TYPE "color_scheme" AS ENUM ('LIGHT', 'DARK', 'SYSTEM');

-- AlterTable
ALTER TABLE "institute_types" ADD COLUMN     "default_theme" "theme_preset" NOT NULL DEFAULT 'SCHOOL';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "color_scheme" "color_scheme" NOT NULL DEFAULT 'SYSTEM';

-- CreateTable
CREATE TABLE "appearance_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "preset" "theme_preset",
    "accent" CHAR(7),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appearance_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "appearance_settings_tenant_id_key" ON "appearance_settings"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "appearance_settings_tenant_id_id_key" ON "appearance_settings"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "appearance_settings" ADD CONSTRAINT "appearance_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
