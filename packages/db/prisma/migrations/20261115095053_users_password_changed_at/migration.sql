-- AlterTable
ALTER TABLE "users" ADD COLUMN     "password_changed_at" TIMESTAMPTZ(3);

-- P1-B: the app login may update only these columns of a user's own row (RLS still limits it to
-- that row). The login identifiers (phone, email) and the global name stay out of its reach.
REVOKE UPDATE ON users FROM jantrik_app;
GRANT UPDATE (locale, color_scheme, name_bn, password_hash, password_changed_at, updated_at)
  ON users TO jantrik_app;
