-- Up Migration

-- discovery_sources is a per-tenant, per-project configuration of a
-- lead-source connector (public directory listing, Crawl4AI website crawl,
-- CSV upload batch, or a licensed data-provider API). This replaces the old
-- mock market-research agent: each row tells the connector framework how to
-- run one source, at what rate, and with what config (connector-specific
-- JSON, e.g. a directory URL, a crawl seed list, or an API key reference).
CREATE TABLE discovery_sources (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id              uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  connector_type          text NOT NULL CHECK (connector_type IN ('public_directory', 'website_crawl', 'csv_upload', 'licensed_api')),
  name                    text NOT NULL,
  enabled                 boolean NOT NULL DEFAULT true,
  rate_limit_per_minute   integer NOT NULL DEFAULT 10 CHECK (rate_limit_per_minute > 0),
  terms_note              text,
  config                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_discovery_sources_set_updated_at
  BEFORE UPDATE ON discovery_sources
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_discovery_sources_tenant_id ON discovery_sources (tenant_id);
CREATE INDEX idx_discovery_sources_project_id ON discovery_sources (project_id);
CREATE INDEX idx_discovery_sources_tenant_enabled ON discovery_sources (tenant_id, enabled);

-- Down Migration

DROP TABLE IF EXISTS discovery_sources;
