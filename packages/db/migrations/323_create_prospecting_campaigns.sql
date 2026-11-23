-- Up Migration
--
-- Milestone 3 Phase 2 (Intelligent Lead Acquisition) — the real gap flagged
-- in docs/MILESTONE_3_REPORT.md's Phase 2 recommendation: discovery_sources
-- (026_create_discovery_sources.sql) is purely a connector CONFIG row — no
-- name/goal, no status, no results summary, no link to which icp_profiles
-- row it's targeting. prospecting_campaigns is the missing entity: one row
-- per "a batch of discovery work with a goal", owning one or more
-- discovery_sources (via prospecting_campaign_sources, ordered by
-- `priority` for the waterfall run in apps/api/src/lib/discoveryRun.ts) and
-- optionally targeting a real icp_profiles row.
--
-- Results summary is deliberately NOT a stored/fabricated column here — see
-- apps/api/src/lib/prospectingCampaigns.ts's getCampaignResultsSummary,
-- which always computes it fresh from real discovered_organizations /
-- discovered_contacts / leads rows tagged with this campaign's id, never a
-- cached or guessed count.
CREATE TABLE prospecting_campaigns (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id          uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name                text NOT NULL,
  goal                text,
  -- The ICP a run under this campaign targets. Nullable: a campaign can run
  -- untargeted (same as today's plain discovery-source run). ON DELETE SET
  -- NULL rather than CASCADE — deleting an icp_profiles row should not take
  -- a campaign's history down with it.
  icp_profile_id      uuid REFERENCES icp_profiles (id) ON DELETE SET NULL,
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'running', 'paused', 'completed')),
  started_at          timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_prospecting_campaigns_set_updated_at
  BEFORE UPDATE ON prospecting_campaigns
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_prospecting_campaigns_tenant_id ON prospecting_campaigns (tenant_id);
CREATE INDEX idx_prospecting_campaigns_project_id ON prospecting_campaigns (project_id);
CREATE INDEX idx_prospecting_campaigns_icp_profile_id ON prospecting_campaigns (icp_profile_id);

-- prospecting_campaign_sources: which discovery_sources a campaign runs,
-- and in what priority order (ascending — lower runs first) when its "start
-- run" action builds the waterfall (runProviderWaterfall, same generic
-- orchestrator decisionMakerProvider.ts already uses — see
-- apps/api/src/lib/discoveryRun.ts). tenant_id is carried directly (rather
-- than only derivable via a join) so RLS below can scope this table the
-- same simple way every other table in this schema is scoped.
CREATE TABLE prospecting_campaign_sources (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  prospecting_campaign_id   uuid NOT NULL REFERENCES prospecting_campaigns (id) ON DELETE CASCADE,
  discovery_source_id       uuid NOT NULL REFERENCES discovery_sources (id) ON DELETE CASCADE,
  priority                  integer NOT NULL DEFAULT 0,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (prospecting_campaign_id, discovery_source_id)
);

CREATE INDEX idx_prospecting_campaign_sources_tenant_id ON prospecting_campaign_sources (tenant_id);
CREATE INDEX idx_prospecting_campaign_sources_campaign_id ON prospecting_campaign_sources (prospecting_campaign_id);
CREATE INDEX idx_prospecting_campaign_sources_priority ON prospecting_campaign_sources (prospecting_campaign_id, priority);

-- Tags a discovered_organizations row with the campaign whose run created
-- it (null for organizations created outside any campaign — e.g. the
-- pre-existing single-source /:id/run endpoint, left untouched). This is
-- the ONLY provenance link needed for a real, non-fabricated results
-- summary: discovered_contacts already hangs off discovered_organizations,
-- and promote-to-lead's created `leads` row records
-- custom_fields.discoveredOrganizationId, so "leads created under this
-- campaign" is a real join, not a second denormalized counter to keep in
-- sync.
ALTER TABLE discovered_organizations
  ADD COLUMN prospecting_campaign_id uuid REFERENCES prospecting_campaigns (id) ON DELETE SET NULL;

CREATE INDEX idx_discovered_organizations_prospecting_campaign_id
  ON discovered_organizations (prospecting_campaign_id);

-- Down Migration

DROP INDEX IF EXISTS idx_discovered_organizations_prospecting_campaign_id;
ALTER TABLE discovered_organizations DROP COLUMN IF EXISTS prospecting_campaign_id;

DROP TABLE IF EXISTS prospecting_campaign_sources;
DROP TABLE IF EXISTS prospecting_campaigns;
