-- Up Migration
--
-- company_enrichment: a complementary intelligence layer on top of the
-- EXISTING rubric-based scoring system (scoring_rubrics/lead_scores, see
-- 032_create_lead_scores.sql and apps/api/src/routes/scoring.ts). This
-- table does NOT replace or duplicate that scoring — it holds firmographic
-- context for a lead, sourced honestly from whatever already-crawled
-- discovered_organizations data matches the lead by domain/name (see
-- apps/api/src/lib/dedup.ts for the matching normalizers and
-- apps/api/src/lib/scoreLead.ts for the evidence-matching pattern this
-- reuses conceptually). One row per lead — enrichment is a point-in-time
-- snapshot that gets overwritten (upserted) on re-enrichment, not
-- versioned history.
CREATE TABLE company_enrichment (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id                uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  lead_id                   uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  matched_organization_id   uuid REFERENCES discovered_organizations (id) ON DELETE SET NULL,
  domain                    text,
  -- Only real, sourced fields ever go here (e.g. domain, matched org name,
  -- raw_metadata keys actually present on the matched org) — never
  -- invented employee-count/revenue numbers we don't have.
  firmographics             jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Array of strings naming where each piece of firmographics came from,
  -- e.g. ["discovered_organizations:domain_match"], for honesty/auditability.
  data_sources              jsonb NOT NULL DEFAULT '[]'::jsonb,
  enriched_at               timestamptz NOT NULL DEFAULT now(),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_company_enrichment_lead_id UNIQUE (lead_id)
);

CREATE TRIGGER trg_company_enrichment_set_updated_at
  BEFORE UPDATE ON company_enrichment
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_company_enrichment_tenant_id ON company_enrichment (tenant_id);
CREATE INDEX idx_company_enrichment_project_id ON company_enrichment (project_id);

-- Down Migration

DROP TABLE IF EXISTS company_enrichment;
