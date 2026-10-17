-- Bangla-script name for the Bangla UI (nullable; the UI falls back to "name").
-- Existing grants and RLS policies on users cover the new column; no policy changes.
ALTER TABLE "users" ADD COLUMN "name_bn" TEXT;
