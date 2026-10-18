-- Held SMS not released by the end of their day are marked EXPIRED (daily job).
ALTER TYPE "sms_status" ADD VALUE 'EXPIRED';
