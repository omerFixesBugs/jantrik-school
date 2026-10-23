-- A CHECK whose expression is NULL passes. The fee setup checks compared nullable columns
-- (due_day, fine_cap_paisa, sibling_discount_value, reasons) without IS NOT NULL, so a MONTHLY
-- head without a due day or a PER_DAY fine without a cap slipped through. Same rules, NULL-safe.

ALTER TABLE fee_settings
  DROP CONSTRAINT IF EXISTS fee_settings_sibling_rule,
  ADD CONSTRAINT fee_settings_sibling_rule CHECK (
    (sibling_discount_type IS NULL AND sibling_discount_value IS NULL)
    OR (sibling_discount_type = 'PERCENT' AND sibling_discount_value IS NOT NULL
        AND sibling_discount_value BETWEEN 1 AND 100)
    OR (sibling_discount_type = 'FIXED' AND sibling_discount_value IS NOT NULL
        AND sibling_discount_value BETWEEN 1 AND 100000000));

ALTER TABLE fee_heads
  DROP CONSTRAINT IF EXISTS fee_heads_due_day,
  ADD CONSTRAINT fee_heads_due_day CHECK (
    (frequency = 'MONTHLY' AND due_day IS NOT NULL AND due_day BETWEEN 1 AND 28)
    OR (frequency <> 'MONTHLY' AND due_day IS NULL)),
  DROP CONSTRAINT IF EXISTS fee_heads_fine_rule,
  ADD CONSTRAINT fee_heads_fine_rule CHECK (
    (fine_type = 'NONE' AND fine_amount_paisa = 0 AND fine_cap_paisa IS NULL)
    OR (fine_type = 'FLAT' AND fine_amount_paisa BETWEEN 1 AND 10000000 AND fine_cap_paisa IS NULL)
    OR (fine_type = 'PER_DAY' AND fine_amount_paisa BETWEEN 1 AND 10000000
        AND fine_cap_paisa IS NOT NULL AND fine_cap_paisa BETWEEN fine_amount_paisa AND 100000000));

ALTER TABLE fee_concessions
  DROP CONSTRAINT IF EXISTS fee_concessions_category_rule,
  ADD CONSTRAINT fee_concessions_category_rule CHECK (
    (category <> 'FREE_FULL' OR (type = 'PERCENT' AND value = 100))
    AND (category <> 'FREE_HALF' OR (type = 'PERCENT' AND value = 50))
    AND (category <> 'SCHOLARSHIP'
         OR (reason IS NOT NULL AND char_length(btrim(reason)) BETWEEN 3 AND 500))),
  DROP CONSTRAINT IF EXISTS fee_concessions_end,
  ADD CONSTRAINT fee_concessions_end CHECK (
    (ended_on IS NULL AND ended_by_id IS NULL AND ended_reason IS NULL)
    OR (ended_on IS NOT NULL AND ended_by_id IS NOT NULL AND ended_on >= valid_from
        AND ended_reason IS NOT NULL AND char_length(btrim(ended_reason)) BETWEEN 3 AND 500));

ALTER TABLE fee_sibling_members
  DROP CONSTRAINT IF EXISTS fee_sibling_members_removal,
  ADD CONSTRAINT fee_sibling_members_removal CHECK (
    (removed_at IS NULL AND removed_by_id IS NULL AND removed_reason IS NULL)
    OR (removed_at IS NOT NULL AND removed_by_id IS NOT NULL
        AND removed_reason IS NOT NULL AND char_length(btrim(removed_reason)) BETWEEN 3 AND 500));
