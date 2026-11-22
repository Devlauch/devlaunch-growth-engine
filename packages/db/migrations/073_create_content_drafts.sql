-- Up Migration
--
-- content_drafts: standalone content pieces for the "repurpose one blog
-- into multiple formats" feature (Phase 2 item 2), independent of any
-- content_calendars row. A piece can be an original (source_draft_id
-- NULL) or a repurposed derivative that points back at the blog it was
-- derived from (source_draft_id set) — a self-reference so the lineage
-- of "this LinkedIn post came from that blog" is queryable. Repurposing
-- itself (apps/api/src/lib/contentGeneration.ts's repurposeContent()) is
-- real text transformation of the source draft's own body — extracting
-- hooks/bullets/summaries from what's actually there, never inventing new
-- claims — so brand_voice_note exists purely to record which real
-- project_profiles fields informed tone, for human review.
CREATE TABLE content_drafts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  source_draft_id   uuid REFERENCES content_drafts (id) ON DELETE SET NULL,
  format            text NOT NULL CHECK (format IN ('blog', 'linkedin_post', 'email', 'twitter_thread', 'summary')),
  title             text NOT NULL,
  body              text NOT NULL,
  brand_voice_note  text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_content_drafts_tenant_id ON content_drafts (tenant_id);
CREATE INDEX idx_content_drafts_project_id ON content_drafts (project_id);
CREATE INDEX idx_content_drafts_source_draft_id ON content_drafts (source_draft_id);

-- Down Migration

DROP TABLE IF EXISTS content_drafts;
