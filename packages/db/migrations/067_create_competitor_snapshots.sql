-- Up Migration
--
-- Phase 2 item 1 ("Competitor Intelligence Agent"): a single crawl run of a
-- competitor's site. `pages` stores only a per-page content hash (sha256,
-- computed by the caller via Node's crypto.createHash) plus the extracted
-- text actually used for keyword extraction/diffing — never raw HTML — to
-- keep rows small. `extracted_keywords` is the output of a simple, honest
-- term-frequency pass (see apps/worker/src/agents/competitorIntelligence.ts
-- and apps/api/src/lib/keywordExtraction.ts), not any paid SEO/SERP data.

CREATE TABLE competitor_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  competitor_id uuid NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  crawled_at timestamptz NOT NULL DEFAULT now(),
  pages jsonb NOT NULL DEFAULT '[]'::jsonb,
  extracted_keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_competitor_snapshots_tenant_id ON competitor_snapshots (tenant_id);
CREATE INDEX idx_competitor_snapshots_competitor_id ON competitor_snapshots (competitor_id);
CREATE INDEX idx_competitor_snapshots_competitor_crawled_at ON competitor_snapshots (competitor_id, crawled_at DESC);

-- Down Migration

DROP TABLE IF EXISTS competitor_snapshots;
