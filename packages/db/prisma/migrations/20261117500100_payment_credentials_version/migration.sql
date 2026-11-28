-- Gateway credentials can no longer be rolled back (sprint 1 P7a1, review round 2, P7a1-x20;
-- docs/payments.md → Credentials at rest). jantrik_app may write credentials_ciphertext, and its
-- additional data (AAD) named only the provider, the institute and the account, so an SQL
-- injection inside the institute (any role's request) could copy an OLDER ciphertext of the same
-- row back, e.g. a store a former owner once saved, and it would still decrypt: once P7a2 moves
-- money, payments would go to that store. Each ciphertext now also names the version it was
-- written as, and this trigger alone sets the version: 0 for a new row without credentials, 1 for
-- one with, and one up whenever the ciphertext changes (otherwise it stays). An older ciphertext
-- put back raises the version past its own, so it never decrypts again: the owner saves the store
-- again. jantrik_app may not UPDATE the column, and an INSERT's value is replaced.
-- (The API locks the row, encrypts as the current version + 1 and writes; it decrypts with the
-- row's version. A ciphertext written before this migration names no version: unreadable, saved
-- again; only sandbox stores exist so far.)
ALTER TABLE "payment_gateway_accounts" ADD COLUMN "credentials_version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE payment_gateway_accounts
  ADD CONSTRAINT payment_gateway_accounts_credentials_version CHECK (credentials_version >= 0);

CREATE FUNCTION app_payment_credentials_version() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $$
  BEGIN
    IF TG_OP = 'INSERT' THEN
      NEW.credentials_version := CASE WHEN NEW.credentials_ciphertext IS NULL THEN 0 ELSE 1 END;
    ELSIF NEW.credentials_ciphertext IS DISTINCT FROM OLD.credentials_ciphertext THEN
      NEW.credentials_version := OLD.credentials_version + 1;
    ELSE
      NEW.credentials_version := OLD.credentials_version;
    END IF;
    RETURN NEW;
  END
  $$;
REVOKE ALL ON FUNCTION app_payment_credentials_version() FROM PUBLIC;
CREATE TRIGGER payment_gateway_accounts_credentials_version
  BEFORE INSERT OR UPDATE ON payment_gateway_accounts
  FOR EACH ROW EXECUTE FUNCTION app_payment_credentials_version();

-- No grant: the UPDATE grant of 20261117500000 names its columns one by one, and this is not one.
