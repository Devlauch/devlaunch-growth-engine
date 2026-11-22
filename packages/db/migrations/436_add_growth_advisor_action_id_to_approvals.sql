-- Up Migration
--
-- Generalizes approvals (011_create_approvals.sql, already widened for
-- campaigns/message_drafts/postiz_social_posts by 023/056/319) so it can
-- also reference a growth_advisor_actions row
-- (434_create_growth_advisor_actions.sql) — the AI Growth Advisor's one
-- approval-gated action (round-robin auto-assigning unassigned leads).
-- Same "add its column + widen the 'exactly one subject' CHECK, not a new
-- table" extension every prior subject type used.
ALTER TABLE approvals
  ADD COLUMN growth_advisor_action_id uuid REFERENCES growth_advisor_actions (id) ON DELETE CASCADE;

ALTER TABLE approvals
  DROP CONSTRAINT approvals_exactly_one_subject;

ALTER TABLE approvals
  ADD CONSTRAINT approvals_exactly_one_subject CHECK (
    (agent_execution_id IS NOT NULL)::int + (campaign_id IS NOT NULL)::int +
    (message_draft_id IS NOT NULL)::int + (social_post_id IS NOT NULL)::int +
    (growth_advisor_action_id IS NOT NULL)::int = 1
  );

CREATE INDEX idx_approvals_growth_advisor_action_id ON approvals (growth_advisor_action_id);

-- Down Migration

DROP INDEX IF EXISTS idx_approvals_growth_advisor_action_id;

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_exactly_one_subject;

ALTER TABLE approvals
  ADD CONSTRAINT approvals_exactly_one_subject CHECK (
    (agent_execution_id IS NOT NULL)::int + (campaign_id IS NOT NULL)::int +
    (message_draft_id IS NOT NULL)::int + (social_post_id IS NOT NULL)::int = 1
  );

ALTER TABLE approvals DROP COLUMN IF EXISTS growth_advisor_action_id;
