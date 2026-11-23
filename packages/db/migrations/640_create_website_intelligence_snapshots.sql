-- Up Migration
--
-- Workstream E ("deep website & competitor intelligence"): one row per
-- structured-extraction snapshot of a tenant's own site or a tracked
-- competitor's site, captured by apps/api/src/lib/structuredExtraction.ts
-- (pricing / product catalog / case studies) and the deterministic
-- positioning-signal reuse of ../lib/positioningInsights.ts.
--
-- This is deliberately a NEW, separate table from the existing
-- `competitor_snapshots` (066-069_*.sql, raw crawled pages + TF keywords)
-- rather than an extension of it: `competitor_snapshots` holds the
-- unstructured page/keyword crawl used by routes/competitors.ts today,
-- while this table holds the STRUCTURED, field-level extraction result
-- (pricing plans, product catalog entries, case studies/testimonials,
-- positioning claims) for either this tenant's own `target_url` or a
-- competitor's, each field backed by real `source_evidence` (the exact
-- selector/snippet, source URL, and fetch timestamp it was extracted
-- from) rather than a free-text summary. `extracted_data` is always the
-- real, deterministic parse of a real Crawl4AI fetch (see
-- structuredExtraction.ts's doc comment) — never LLM-fabricated.
--
-- `content_hash` is a sha256 of `extracted_data` (not raw HTML — see
-- websiteChangeDetection.ts), so two snapshots of the same `target_url`
-- can be compared for real structured-field drift (new/changed/removed
-- plans, products, case studies) irrespective of incidental markup
-- churn on the source page.
CREATE TABLE website_intelligence_snapshots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id       uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  target_url       text NOT NULL,
  snapshot_type    text NOT NULL CHECK (snapshot_type IN ('pricing', 'product_catalog', 'case_studies', 'positioning')),
  -- Real, deterministic structured extraction result (shape depends on
  -- snapshot_type — see structuredExtraction.ts's PricingPlan/ProductCatalogEntry/
  -- CaseStudy types). Never invented when a fetch fails: an honest
  -- {error: "..."} shape is stored instead (see that file's doc comment).
  extracted_data   jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Array of {selectorOrText, sourceUrl, fetchedAt} — one entry per
  -- extracted field/claim, always pointing at the real page text it came
  -- from, so a human can verify every field against the live source.
  source_evidence  jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- sha256 hex digest of a canonical JSON.stringify of extracted_data —
  -- used by websiteChangeDetection.ts to decide whether anything
  -- structurally changed since the prior snapshot of this target_url,
  -- without re-fetching or re-diffing raw HTML.
  content_hash     text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_website_intel_snapshots_tenant_id ON website_intelligence_snapshots (tenant_id);
CREATE INDEX idx_website_intel_snapshots_project_id ON website_intelligence_snapshots (project_id);
-- Primary lookup for websiteChangeDetection.ts: latest snapshot for a given
-- (tenant, project, target_url, snapshot_type) tuple.
CREATE INDEX idx_website_intel_snapshots_lookup
  ON website_intelligence_snapshots (tenant_id, project_id, target_url, snapshot_type, created_at DESC);

-- Down Migration

DROP TABLE IF EXISTS website_intelligence_snapshots;
