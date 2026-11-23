-- Up Migration
--
-- Phase 5 inbound growth item ("SEO campaigns"): a real, trackable entity a
-- tenant creates by picking a deterministic keyword cluster (see
-- apps/api/src/lib/keywordClustering.ts) — or a manually chosen set of
-- target keywords — computed from this project's own real TF-extracted
-- keywords (growth_analyses.extracted_keywords,
-- 260_create_growth_analyses.sql). `target_keywords` and
-- `source_cluster` are both honest records of what was picked/computed at
-- creation time, never re-derived or faked later.
--
-- Rather than inventing a second, parallel "content theme" concept,
-- existing content_calendars (071_create_content_calendars.sql) gets a
-- nullable `seo_campaign_id` tag (see
-- 553_add_seo_campaign_to_content_calendars.sql) so a campaign's progress
-- can be computed from the EXISTING, already-real content_calendar_items
-- (072_create_content_calendar_items.sql) and seo_audits/seo_audit_issues
-- (076/077_*.sql) rather than duplicating either.
CREATE TABLE seo_campaigns (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name              text NOT NULL,
  domain            text,
  -- Real target keywords this campaign is tracking content/technical
  -- progress against — a jsonb string array, e.g. ["pricing","invoicing"].
  target_keywords   jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Honest record of the deterministic cluster this campaign was created
  -- from (clusterKey/label/member keywords+frequencies at creation time),
  -- or null when the tenant picked custom keywords instead of a cluster.
  source_cluster    jsonb,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_seo_campaigns_set_updated_at
  BEFORE UPDATE ON seo_campaigns
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_seo_campaigns_tenant_id ON seo_campaigns (tenant_id);
CREATE INDEX idx_seo_campaigns_project_id ON seo_campaigns (project_id);

-- Down Migration

DROP TABLE IF EXISTS seo_campaigns;
