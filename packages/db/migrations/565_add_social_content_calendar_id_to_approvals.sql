-- Up Migration
--
-- Generalizes approvals (011_create_approvals.sql, already widened for
-- campaigns/message_drafts/postiz_social_posts/growth_advisor_actions by
-- 023/056/319/436) so it can also reference a social_content_calendar row
-- (563_create_social_content_calendar.sql) — Workstream H's calendar
-- approval gate (apps/api/src/lib/socialContentCalendar.ts's
-- requestCalendarApproval()/approveAndPublish()). Same "add its column +
-- widen the 'exactly one subject' CHECK, not a new table" extension every
-- prior subject type used — this is still the ONE approvals table/engine,
-- never a parallel one.
ALTER TABLE approvals
  ADD COLUMN social_content_calendar_id uuid REFERENCES social_content_calendar (id) ON DELETE CASCADE;

ALTER TABLE approvals
  DROP CONSTRAINT approvals_exactly_one_subject;

ALTER TABLE approvals
  ADD CONSTRAINT approvals_exactly_one_subject CHECK (
    (agent_execution_id IS NOT NULL)::int + (campaign_id IS NOT NULL)::int +
    (message_draft_id IS NOT NULL)::int + (social_post_id IS NOT NULL)::int +
    (growth_advisor_action_id IS NOT NULL)::int + (social_content_calendar_id IS NOT NULL)::int = 1
  );

CREATE INDEX idx_approvals_social_content_calendar_id ON approvals (social_content_calendar_id);

-- Down Migration

DROP INDEX IF EXISTS idx_approvals_social_content_calendar_id;

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_exactly_one_subject;

ALTER TABLE approvals
  ADD CONSTRAINT approvals_exactly_one_subject CHECK (
    (agent_execution_id IS NOT NULL)::int + (campaign_id IS NOT NULL)::int +
    (message_draft_id IS NOT NULL)::int + (social_post_id IS NOT NULL)::int +
    (growth_advisor_action_id IS NOT NULL)::int = 1
  );

ALTER TABLE approvals DROP COLUMN IF EXISTS social_content_calendar_id;
