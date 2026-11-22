-- Up Migration
--
-- Roadmap item 12 ("Approval screen"): "support approving a batch of
-- messages, with a daily send limit per tenant." This column is read by
-- POST .../message-drafts/batch-approve (apps/api/src/routes/messaging.ts),
-- which counts message_drafts already approved today for the tenant and
-- rejects the whole batch (no partial approval) if it would exceed this
-- limit. NULL means unlimited.
ALTER TABLE tenants
  ADD COLUMN message_approval_daily_limit integer
  CONSTRAINT tenants_message_approval_daily_limit_positive
    CHECK (message_approval_daily_limit IS NULL OR message_approval_daily_limit > 0);

-- Down Migration

ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_message_approval_daily_limit_positive;
ALTER TABLE tenants DROP COLUMN IF EXISTS message_approval_daily_limit;
