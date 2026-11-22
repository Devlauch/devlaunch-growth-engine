-- Up Migration
--
-- Phase 2 item 3 ("Technical SEO Agent"): keyword ranking history. SERP
-- position tracking genuinely requires a paid provider (SEMrush/Ahrefs/
-- DataForSEO, etc.) that this environment has no credentials for — see
-- apps/api/src/lib/keywordRankingStub.ts's NotConfiguredRankingProvider.
-- position is nullable and source defaults to 'not_configured' precisely
-- so a request to track a keyword can be honestly recorded (never a
-- fabricated position) until a real SERP provider is wired in.

CREATE TABLE keyword_rankings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  keyword     text NOT NULL,
  position    integer,
  source      text NOT NULL DEFAULT 'not_configured',
  checked_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_keyword_rankings_tenant_id ON keyword_rankings (tenant_id);
CREATE INDEX idx_keyword_rankings_project_id ON keyword_rankings (project_id);
CREATE INDEX idx_keyword_rankings_project_id_keyword_checked_at
  ON keyword_rankings (project_id, keyword, checked_at DESC);

-- Down Migration

DROP TABLE IF EXISTS keyword_rankings;
