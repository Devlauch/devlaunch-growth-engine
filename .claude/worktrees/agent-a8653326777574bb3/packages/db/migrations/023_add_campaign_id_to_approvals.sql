-- Up Migration
--
-- Generalizes approvals (011_create_approvals.sql) so it can reference a
-- campaigns row (020_create_campaigns.sql) and not only an
-- agent_executions row, without inventing a second/parallel approvals
-- mechanism. agent_execution_id is relaxed from NOT NULL to nullable, and
-- a CHECK constraint keeps every row referencing exactly one approvable
-- entity (adding a third kind later means adding its column + widening
-- this same CHECK, not a new table).
ALTER TABLE approvals
  ALTER COLUMN agent_execution_id DROP NOT NULL;

ALTER TABLE approvals
  ADD COLUMN campaign_id uuid REFERENCES campaigns (id) ON DELETE CASCADE;

ALTER TABLE approvals
  ADD CONSTRAINT approvals_exactly_one_subject CHECK (
    (agent_execution_id IS NOT NULL)::int + (campaign_id IS NOT NULL)::int = 1
  );

CREATE INDEX idx_approvals_campaign_id ON approvals (campaign_id);

-- Down Migration

DROP INDEX IF EXISTS idx_approvals_campaign_id;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_exactly_one_subject;
ALTER TABLE approvals DROP COLUMN IF EXISTS campaign_id;
ALTER TABLE approvals ALTER COLUMN agent_execution_id SET NOT NULL;
