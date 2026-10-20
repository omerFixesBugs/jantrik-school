-- Invitations (step 7 review): new membership statuses. A separate migration because a value
-- added with ALTER TYPE cannot be used in the same transaction (the next migration uses them).
ALTER TYPE "membership_status" ADD VALUE 'INVITED';
ALTER TYPE "membership_status" ADD VALUE 'DECLINED';
