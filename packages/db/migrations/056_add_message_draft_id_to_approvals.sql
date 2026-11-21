-- Up Migration
--
-- Generalizes approvals (011_create_approvals.sql, already widened once by
-- 023_add_campaign_id_to_approvals.sql for campaigns) so it can also
-- reference a message_drafts row (052_create_message_drafts.sql), without
-- inventing a second/parallel approvals mechanism. The existing
-- "exactly one subject" CHECK is widened to admit this third subject
-- column the same way 023 added the second.
ALTER TABLE approvals
  ADD COLUMN message_draft_id uuid REFERENCES message_drafts (id) ON DELETE CASCADE;

ALTER TABLE approvals
  DROP CONSTRAINT approvals_exactly_one_subject;

ALTER TABLE approvals
  ADD CONSTRAINT approvals_exactly_one_subject CHECK (
    (agent_execution_id IS NOT NULL)::int + (campaign_id IS NOT NULL)::int + (message_draft_id IS NOT NULL)::int = 1
  );

CREATE INDEX idx_approvals_message_draft_id ON approvals (message_draft_id);

-- Down Migration

DROP INDEX IF EXISTS idx_approvals_message_draft_id;

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_exactly_one_subject;

ALTER TABLE approvals
  ADD CONSTRAINT approvals_exactly_one_subject CHECK (
    (agent_execution_id IS NOT NULL)::int + (campaign_id IS NOT NULL)::int = 1
  );

ALTER TABLE approvals DROP COLUMN IF EXISTS message_draft_id;
