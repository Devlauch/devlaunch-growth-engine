-- Up Migration
--
-- Phase 2 item 1 ("Competitor Intelligence Agent"): the list of competitors
-- a project wants monitored. Crawling, snapshotting and change-detection
-- live in 067/068; this migration just creates the competitor record
-- itself, following the same tenant+project scoping pattern as
-- icp_profiles / discovery_sources.

CREATE TABLE competitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  domain text NOT NULL,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, domain)
);

CREATE INDEX idx_competitors_tenant_id ON competitors (tenant_id);
CREATE INDEX idx_competitors_project_id ON competitors (project_id);

-- Same set_updated_at() trigger function used across the schema (see e.g.
-- 020_create_campaigns.sql) — already created, not redefined here.
CREATE TRIGGER trg_competitors_set_updated_at
  BEFORE UPDATE ON competitors
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TRIGGER IF EXISTS trg_competitors_set_updated_at ON competitors;
DROP TABLE IF EXISTS competitors;
