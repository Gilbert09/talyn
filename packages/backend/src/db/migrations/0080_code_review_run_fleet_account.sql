-- The fleet account a code-review unit ran on. A unit that hit a usage limit
-- moves to the next account of the same agent first, so it must know which
-- account it was. No foreign key: an account can be removed while its runs stay.
ALTER TABLE "pr_code_review_runs" ADD COLUMN IF NOT EXISTS "fleet_account_id" text;
