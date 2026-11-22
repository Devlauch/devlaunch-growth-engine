-- Up Migration
--
-- "AI Website Growth Analyzer" (DevLaunch Growth Engine, feature 1): one row
-- per crawl+analyze run of a project's website. The crawl itself reuses
-- apps/api/src/lib/crawl4aiClient.ts (same verified Crawl4AI HTTP client
-- already used by competitors.ts) and apps/api/src/lib/siteAudit.ts (real
-- sitemap/robots/broken-link/metadata checks); keyword/signal extraction
-- reuses apps/api/src/lib/keywordExtraction.ts's deterministic TF algorithm.
-- Nothing here is produced by an LLM — see apps/api/src/lib/growthAnalyzer.ts
-- for the honesty contract on every derived field.
--
-- `recommended_icp` suggests industries/geographies/segments but is never
-- written directly into icp_profiles — see growth_recommendations
-- (261_create_growth_recommendations.sql) for the acceptance flow, which
-- copies an accepted suggestion into the EXISTING icp_profiles table
-- (007_create_icp_profiles.sql) rather than a second ICP table.

CREATE TABLE growth_analyses (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id                uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  domain                    text NOT NULL,
  status                    text NOT NULL DEFAULT 'completed'
                              CHECK (status IN ('completed', 'partial', 'failed')),
  pages_discovered          integer NOT NULL DEFAULT 0,
  pages_crawled             integer NOT NULL DEFAULT 0,
  crawl_error               text,
  sitemap_found             boolean NOT NULL DEFAULT false,
  robots_found              boolean NOT NULL DEFAULT false,
  extracted_keywords        jsonb NOT NULL DEFAULT '[]'::jsonb,
  products_services         jsonb NOT NULL DEFAULT '[]'::jsonb,
  value_propositions        jsonb NOT NULL DEFAULT '[]'::jsonb,
  target_audience_signals   jsonb NOT NULL DEFAULT '[]'::jsonb,
  recommended_icp           jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_gaps              jsonb NOT NULL DEFAULT '[]'::jsonb,
  conversion_opportunities  jsonb NOT NULL DEFAULT '[]'::jsonb,
  growth_plan_summary       text NOT NULL DEFAULT '',
  started_at                timestamptz NOT NULL DEFAULT now(),
  completed_at               timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_growth_analyses_tenant_id ON growth_analyses (tenant_id);
CREATE INDEX idx_growth_analyses_project_id ON growth_analyses (project_id);
CREATE INDEX idx_growth_analyses_project_created_at ON growth_analyses (project_id, created_at DESC);

-- Same set_updated_at() trigger function used across the schema (see e.g.
-- 020_create_campaigns.sql) — already created, not redefined here.
CREATE TRIGGER trg_growth_analyses_set_updated_at
  BEFORE UPDATE ON growth_analyses
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TRIGGER IF EXISTS trg_growth_analyses_set_updated_at ON growth_analyses;
DROP TABLE IF EXISTS growth_analyses;
