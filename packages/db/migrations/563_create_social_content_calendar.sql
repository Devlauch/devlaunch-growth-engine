-- Up Migration
--
-- Workstream H: social content calendar + approval workflow + campaign
-- attribution for Postiz-published content. This is an ORCHESTRATION layer
-- on top of the existing, real Postiz integration
-- (317_create_postiz_organization_links.sql /
-- 318_create_postiz_social_posts.sql / apps/api/src/lib/postizClient.ts /
-- apps/api/src/routes/postizIntegration.ts) — it is NOT a second
-- publishing table. `postiz_social_posts` already owns the real
-- draft -> approval -> publish/sync lifecycle for an individual Postiz
-- post; `social_content_calendar` adds the thing that table does not have:
-- a forward-looking, plannable calendar row (a content idea/draft that may
-- not even be scheduled yet) that can optionally be tied to a `campaigns`
-- row for attribution, with its own approval gate BEFORE a
-- `postiz_social_posts` row (and therefore a real Postiz API call) ever
-- exists for it. Once approved, apps/api/src/lib/socialContentCalendar.ts's
-- approveAndPublish() creates/uses the real postiz_social_posts row and
-- goes through the EXISTING approval engine (the `approvals` table +
-- POST .../approvals/:approvalId/decision, same as
-- postizIntegration.ts's request-approval/publish routes) — never a
-- second, parallel approval mechanism.
--
-- Same tenant/project-owned shape as every other table in this schema.
-- campaign_id is nullable: a calendar item does not have to belong to a
-- campaign, but when it does, socialCampaignAttribution.ts joins it against
-- the existing campaign_attribution view (276_create_campaign_attribution.sql)
-- to show social's real contribution to that campaign.
CREATE TABLE social_content_calendar (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  -- Nullable: a calendar item is not required to belong to a campaign.
  campaign_id       uuid REFERENCES campaigns (id) ON DELETE SET NULL,
  platform          text NOT NULL,
  content_draft     text NOT NULL,
  -- Postiz media references (uploaded media ids / urls) — stored as-is,
  -- never fabricated; passed through verbatim to Postiz's createPost() at
  -- publish time once that call site accepts media (see postizClient.ts's
  -- CreatePostInput doc comment: media is a documented future extension of
  -- that same DTO shape, not invented here).
  media_refs        jsonb NOT NULL DEFAULT '[]'::jsonb,
  scheduled_at      timestamptz,
  approval_status   text NOT NULL DEFAULT 'pending'
                      CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  -- Set once approveAndPublish() actually creates a real postiz_social_posts
  -- row for this item and (if approved) publishes it — copied verbatim from
  -- that row's own postiz_post_id (itself copied verbatim from Postiz's
  -- real API response). Never guessed.
  postiz_post_id    text,
  published_status  text NOT NULL DEFAULT 'not_published'
                      CHECK (published_status IN ('not_published', 'scheduled', 'published', 'failed')),
  created_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_social_content_calendar_set_updated_at
  BEFORE UPDATE ON social_content_calendar
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_social_content_calendar_tenant_id ON social_content_calendar (tenant_id);
CREATE INDEX idx_social_content_calendar_project_id ON social_content_calendar (project_id);
CREATE INDEX idx_social_content_calendar_campaign_id ON social_content_calendar (campaign_id);
CREATE INDEX idx_social_content_calendar_project_scheduled_at ON social_content_calendar (project_id, scheduled_at);
CREATE INDEX idx_social_content_calendar_tenant_approval_status ON social_content_calendar (tenant_id, approval_status);

-- Down Migration

DROP TABLE IF EXISTS social_content_calendar;
