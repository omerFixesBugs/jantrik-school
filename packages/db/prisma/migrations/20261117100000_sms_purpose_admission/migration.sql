-- Sprint 1 P3 (online admission): two SMS purposes, in their own migration (a new enum value
-- cannot be used in the transaction that adds it).
-- ADMISSION_OTP: the code that proves an applicant's phone (decision P3-D; its body is masked).
-- ADMISSION_SUBMITTED: "application received" to that phone (S11, decision P3-E).
ALTER TYPE "sms_purpose" ADD VALUE IF NOT EXISTS 'ADMISSION_OTP';
ALTER TYPE "sms_purpose" ADD VALUE IF NOT EXISTS 'ADMISSION_SUBMITTED';
