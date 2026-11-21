-- Up Migration

-- discovered_organizations is a lead organization found by a connector
-- (see 026_create_discovery_sources.sql). This sits upstream of leads
-- (015_create_leads.sql): a discovered organization is raw, unverified
-- material a connector surfaced, which the research/verification layer
-- turns into contacts (028_create_discovered_contacts.sql) and eventually
-- promotes into real leads. normalized_domain/normalized_name exist purely
-- for dedup across repeated crawls/directory pulls of the same org.
CREATE TABLE discovered_organizations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id            uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  discovery_source_id   uuid REFERENCES discovery_sources (id) ON DELETE SET NULL,
  name                  text NOT NULL,
  domain                text,
  normalized_domain     text,
  normalized_name       text NOT NULL,
  source_url            text NOT NULL,
  discovered_at         timestamptz NOT NULL DEFAULT now(),
  raw_metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'researched', 'duplicate', 'archived')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_discovered_organizations_set_updated_at
  BEFORE UPDATE ON discovered_organizations
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_discovered_organizations_tenant_id ON discovered_organizations (tenant_id);
CREATE INDEX idx_discovered_organizations_project_id ON discovered_organizations (project_id);
CREATE INDEX idx_discovered_organizations_normalized_domain ON discovered_organizations (normalized_domain);
CREATE INDEX idx_discovered_organizations_normalized_name ON discovered_organizations (normalized_name);

-- Dedup guard: within a tenant/project, the same domain should only ever
-- appear once. Rows without a domain (e.g. directory listings that didn't
-- expose one) are excluded from the constraint.
CREATE UNIQUE INDEX uq_discovered_organizations_tenant_project_domain
  ON discovered_organizations (tenant_id, project_id, normalized_domain)
  WHERE normalized_domain IS NOT NULL;

-- Down Migration

DROP TABLE IF EXISTS discovered_organizations;
