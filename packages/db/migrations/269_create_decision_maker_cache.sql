-- Up Migration
--
-- decision_maker_cache: one row per discovered_organizations row, caching
-- the outcome of the last decision-maker-search provider waterfall run
-- against it (see apps/api/src/lib/decisionMakerProvider.ts +
-- providerWaterfall.ts). This is a cache of an OUTCOME, not just a results
-- list: `status` distinguishes "a provider actually found decision-makers"
-- from "every provider we tried is honestly not configured" from "a real
-- provider looked and found nobody" — collapsing those into an empty
-- `contacts` array would make a not-configured provider indistinguishable
-- from a confirmed empty search. `contacts` only ever holds candidates a
-- provider actually returned (see DecisionMakerCandidate) — never a
-- fabricated name/title/email.
CREATE TABLE decision_maker_cache (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES discovered_organizations (id) ON DELETE CASCADE,
  provider        text,
  status          text NOT NULL CHECK (status IN ('found', 'not_configured', 'no_result')),
  contacts        jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempts        jsonb NOT NULL DEFAULT '[]'::jsonb,
  looked_up_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_decision_maker_cache_set_updated_at
  BEFORE UPDATE ON decision_maker_cache
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_decision_maker_cache_tenant_id ON decision_maker_cache (tenant_id);
CREATE INDEX idx_decision_maker_cache_organization_id ON decision_maker_cache (organization_id);

-- One cached lookup per organization — a fresh lookup upserts in place
-- (mirrors company_enrichment's one-row-per-lead cache pattern in
-- 081_create_company_enrichment.sql) rather than accumulating history.
CREATE UNIQUE INDEX uq_decision_maker_cache_organization_id ON decision_maker_cache (organization_id);

-- Down Migration

DROP TABLE IF EXISTS decision_maker_cache;
