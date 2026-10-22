-- DropIndex
DROP INDEX "fee_heads_tenant_id_name_bn_key";

-- CreateIndex
CREATE UNIQUE INDEX "fee_heads_active_name" ON "fee_heads"("tenant_id", "name_bn") WHERE (is_active);


-- ───────────────────────── Hand-written: review of the fee setup tables ─────────────────────────

-- A NULL type with a value still passed fee_settings_sibling_rule (NULL = 'PERCENT' is NULL).
ALTER TABLE fee_settings
  ADD CONSTRAINT fee_settings_sibling_pair
    CHECK ((sibling_discount_type IS NULL) = (sibling_discount_value IS NULL));

-- 0 is a real price: a study-group override that makes a head free for that group (the dues
-- plan skips heads that cost nothing).
ALTER TABLE fee_amounts
  DROP CONSTRAINT IF EXISTS fee_amounts_amount_range,
  ADD CONSTRAINT fee_amounts_amount_range CHECK (amount_paisa BETWEEN 0 AND 100000000);

-- History stays history: a concession can only be ended, a family member only removed, a
-- family never rewritten (column-level grants; Prisma also writes updated_at).
REVOKE UPDATE ON fee_concessions, fee_sibling_members, fee_sibling_groups FROM jantrik_app;
GRANT UPDATE (ended_on, ended_by_id, ended_reason, updated_at) ON fee_concessions TO jantrik_app;
GRANT UPDATE (removed_at, removed_by_id, removed_reason, updated_at)
  ON fee_sibling_members TO jantrik_app;
