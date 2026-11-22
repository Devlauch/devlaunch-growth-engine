-- Up Migration
--
-- Milestone 3 Phase 2 completion pass (Advanced Prospect Discovery /
-- decision-maker + enrichment + verification provider architecture):
-- company_enrichment (081_create_company_enrichment.sql) tracks
-- `data_sources` (an array of free-text provenance tags) but never tagged a
-- confidence tier, unlike discovered_organizations/discovered_contacts
-- (268_add_prospect_discovery_fields.sql). This adds the same
-- 'verified'/'inferred'/'unconfirmed' vocabulary here so enrichment rows
-- carry the same honest provenance signal as the rest of the discovery
-- pipeline — see apps/api/src/lib/companyEnrichment.ts's
-- DiscoveredOrganizationMatchProvider, which now propagates the matched
-- discovered_organizations row's own source_confidence onto the
-- enrichment it produces (a match against a 'verified' org yields
-- 'verified' enrichment; no match at all keeps the conservative
-- 'unconfirmed' default).
--
-- Existing rows predate this distinction; they are backfilled to
-- 'unconfirmed' (the conservative default) rather than guessed at,
-- since we can't retroactively know which ones matched a 'verified' org
-- without re-running enrichment.

ALTER TABLE company_enrichment
  ADD COLUMN source_confidence text NOT NULL DEFAULT 'unconfirmed'
    CHECK (source_confidence IN ('verified', 'inferred', 'unconfirmed'));

CREATE INDEX idx_company_enrichment_source_confidence ON company_enrichment (source_confidence);

-- Down Migration

DROP INDEX IF EXISTS idx_company_enrichment_source_confidence;
ALTER TABLE company_enrichment DROP COLUMN IF EXISTS source_confidence;
