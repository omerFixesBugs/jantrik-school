-- Fee SMS purposes (separate migration: a new enum value cannot be used in the transaction that adds it).
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "sms_purpose" ADD VALUE 'FEE_RECEIPT';
ALTER TYPE "sms_purpose" ADD VALUE 'FEE_REMINDER';

