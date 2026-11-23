-- Up Migration
--
-- Generalizes approvals (011_create_approvals.sql, already widened for
-- campaigns/message_drafts/postiz_social_posts/growth_advisor_actions/
-- social_content_calendar by 023/056/319/436/565) so it can also
-- reference a growth_experiment_actions row
-- (645_create_growth_experiment_actions.sql) -- Workstream C2's one
-- approval-gated action, applying a growth experiments winning variant
-- to its live target entity (apps/api/src/lib/experimentEngine.ts's
-- applyWinningVariant()). Same add-its-column-and-widen-the-exactly-one-
-- subject-CHECK extension every prior subject type used -- this is still
-- the ONE approvals table/engine, never a parallel one.
ALTER TABLE approvals
  ADD COLUMN growth_experiment_action_id uuid REFERENCES growth_experiment_actions (id) ON DELETE CASCADE;

ALTER TABLE approvals
  DROP CONSTRAINT approvals_exactly_one_subject;

ALTER TABLE approvals
  ADD CONSTRAINT approvals_exactly_one_subject CHECK (
    (agent_execution_id IS NOT NULL)::int + (campaign_id IS NOT NULL)::int +
    (message_draft_id IS NOT NULL)::int + (social_post_id IS NOT NULL)::int +
    (growth_advisor_action_id IS NOT NULL)::int + (social_content_calendar_id IS NOT NULL)::int +
    (growth_experiment_action_id IS NOT NULL)::int = 1
  );

CREATE INDEX idx_approvals_growth_experiment_action_id ON approvals (growth_experiment_action_id);

-- Down Migration

DROP INDEX IF EXISTS idx_approvals_growth_experiment_action_id;

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_exactly_one_subject;

ALTER TABLE approvals
  ADD CONSTRAINT approvals_exactly_one_subject CHECK (
    (agent_execution_id IS NOT NULL)::int + (campaign_id IS NOT NULL)::int +
    (message_draft_id IS NOT NULL)::int + (social_post_id IS NOT NULL)::int +
    (growth_advisor_action_id IS NOT NULL)::int + (social_content_calendar_id IS NOT NULL)::int = 1
  );

ALTER TABLE approvals DROP COLUMN IF EXISTS growth_experiment_action_id;
