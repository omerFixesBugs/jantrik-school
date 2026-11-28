-- Online fee payments, part 1 (sprint 1 P7a1, docs/payments.md → Gateway accounts): an institute's
-- SSLCommerz account. One per provider per institute, SANDBOX only, the store ID and password one
-- ciphertext (encrypted by the API, bound to the row), on only after a passing connection test.
-- Forced RLS; never deleted (P7a-P); the policy calls the context function wrapped in (SELECT …).
-- CreateEnum
CREATE TYPE "payment_provider" AS ENUM ('SSLCOMMERZ');

-- CreateTable
CREATE TABLE "payment_gateway_accounts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "provider" "payment_provider" NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'SANDBOX',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "credentials_ciphertext" TEXT,
    "credentials_hint" TEXT,
    "key_version" SMALLINT NOT NULL DEFAULT 1,
    "credentials_updated_at" TIMESTAMPTZ(3),
    "credentials_updated_by_id" UUID,
    "last_test_at" TIMESTAMPTZ(3),
    "last_test_result" TEXT,
    "last_tested_by_id" UUID,
    "last_failure_code" TEXT,
    "last_failure_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_gateway_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_gateway_accounts_tenant_id_id_key" ON "payment_gateway_accounts"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_gateway_accounts_tenant_id_provider_key" ON "payment_gateway_accounts"("tenant_id", "provider");

-- AddForeignKey
ALTER TABLE "payment_gateway_accounts" ADD CONSTRAINT "payment_gateway_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_gateway_accounts" ADD CONSTRAINT "payment_gateway_accounts_credentials_updated_by_id_fkey" FOREIGN KEY ("credentials_updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_gateway_accounts" ADD CONSTRAINT "payment_gateway_accounts_last_tested_by_id_fkey" FOREIGN KEY ("last_tested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ───────────────────────────── RLS ─────────────────────────────
ALTER TABLE payment_gateway_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_gateway_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_gateway_accounts
  USING (tenant_id = (SELECT app_current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant_id()));

-- ───────────────────────────── Grants ─────────────────────────────
-- No DELETE: an account is switched off, never removed (who set what stays). UPDATE never on the
-- id, the institute, the provider, the mode or when it was created.
GRANT SELECT, INSERT ON payment_gateway_accounts TO jantrik_app;
GRANT UPDATE (enabled, credentials_ciphertext, credentials_hint, key_version, credentials_updated_at,
  credentials_updated_by_id, last_test_at, last_test_result, last_tested_by_id, last_failure_code,
  last_failure_at, updated_at) ON payment_gateway_accounts TO jantrik_app;

-- ───────────────────────────── Checks ─────────────────────────────
-- Nullable columns are tested with IS [NOT] NULL first: a CHECK whose expression is NULL passes.
ALTER TABLE payment_gateway_accounts
  -- Live mode is not this sprint.
  ADD CONSTRAINT payment_gateway_accounts_mode CHECK (mode = 'SANDBOX'),
  -- On only with credentials that passed the connection test (saving credentials clears the test
  -- and switches it off in the same update, P7a-M).
  ADD CONSTRAINT payment_gateway_accounts_enabled CHECK (
    NOT enabled
    OR (credentials_ciphertext IS NOT NULL AND last_test_result IS NOT NULL AND last_test_result = 'OK')
  ),
  -- The API's format: "v1." + base64url(iv | tag | ciphertext), never anything readable: 40 to
  -- 2000 characters after the prefix (a regular expression repeats at most 255 times, hence the
  -- length test).
  ADD CONSTRAINT payment_gateway_accounts_ciphertext CHECK (
    credentials_ciphertext IS NULL
    OR (
      credentials_ciphertext ~ '^v1\.[A-Za-z0-9_-]+$'
      AND char_length(credentials_ciphertext) BETWEEN 43 AND 2003
    )
  ),
  -- The store ID's last 4 characters.
  ADD CONSTRAINT payment_gateway_accounts_hint CHECK (
    credentials_hint IS NULL OR credentials_hint ~ '^[A-Za-z0-9_-]{1,4}$'
  ),
  -- Credentials come with their hint and the time they were saved; a person only with a time (a
  -- command that loaded them names nobody).
  ADD CONSTRAINT payment_gateway_accounts_credentials CHECK (
    (credentials_ciphertext IS NULL) = (credentials_hint IS NULL)
    AND (credentials_ciphertext IS NULL) = (credentials_updated_at IS NULL)
    AND (credentials_updated_by_id IS NULL OR credentials_updated_at IS NOT NULL)
  ),
  ADD CONSTRAINT payment_gateway_accounts_key_version CHECK (key_version BETWEEN 1 AND 100),
  -- A test has a time and one of the fixed results; who asked only with a time.
  ADD CONSTRAINT payment_gateway_accounts_test CHECK (
    (last_test_at IS NULL) = (last_test_result IS NULL)
    AND (last_tested_by_id IS NULL OR last_test_at IS NOT NULL)
    AND (
      last_test_result IS NULL
      OR last_test_result IN ('OK', 'BAD_CREDENTIALS', 'STORE_INACTIVE', 'UNREACHABLE', 'ERROR')
    )
  ),
  -- A job's last failure: a fixed code (upper case and underscores) and its time.
  ADD CONSTRAINT payment_gateway_accounts_failure CHECK (
    (last_failure_code IS NULL) = (last_failure_at IS NULL)
    AND (last_failure_code IS NULL OR last_failure_code ~ '^[A-Z][A-Z_]{0,39}$')
  );
