-- Up Migration
--
-- Generalizes approvals (011_create_approvals.sql, already widened by
-- 023_add_campaign_id_to_approvals.sql for campaigns and
-- 056_add_message_draft_id_to_approvals.sql for message_drafts) so it can
-- also reference a postiz_social_posts row (318_create_postiz_social_posts.sql),
-- without inventing a second/parallel approvals mechanism — exactly the
-- "adding a third [now fourth] kind later means adding its column +
-- widening this same CHECK, not a new table" extension 056 documents.
--
-- This is the real approval gate apps/api/src/routes/postizIntegration.ts
-- enforces before ever calling Postiz's publish endpoint: a
-- postiz_social_posts row may only be scheduled/published once its
-- approval_id points at an approvals row with status = 'approved' — the
-- exact same discipline apps/api/src/lib/advanceSequences.ts uses for the
-- email-send approval gate (message_drafts.status = 'approved').
ALTER TABLE approvals
  ADD COLUMN social_post_id uuid REFERENCES postiz_social_posts (id) ON DELETE CASCADE;

ALTER TABLE approvals
  DROP CONSTRAINT approvals_exactly_one_subject;

ALTER TABLE approvals
  ADD CONSTRAINT approvals_exactly_one_subject CHECK (
    (agent_execution_id IS NOT NULL)::int + (campaign_id IS NOT NULL)::int +
    (message_draft_id IS NOT NULL)::int + (social_post_id IS NOT NULL)::int = 1
  );

CREATE INDEX idx_approvals_social_post_id ON approvals (social_post_id);

-- Down Migration

DROP INDEX IF EXISTS idx_approvals_social_post_id;

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_exactly_one_subject;

ALTER TABLE approvals
  ADD CONSTRAINT approvals_exactly_one_subject CHECK (
    (agent_execution_id IS NOT NULL)::int + (campaign_id IS NOT NULL)::int + (message_draft_id IS NOT NULL)::int = 1
  );

ALTER TABLE approvals DROP COLUMN IF EXISTS social_post_id;
