-- Up Migration
--
-- postiz_organization_links: enforces the audit's explicit recommendation
-- (docs/OPEN_SOURCE_INTEGRATION_AUDIT.md's postiz-app section: "Map one
-- Postiz `Organization` per platform tenant") as a real DB constraint, not
-- just a convention.
--
-- Postiz's own multi-tenancy unit is an `Organization` (see
-- apps/backend/src/public-api/routes/v1/public.integrations.controller.ts's
-- GET /public/v1/me, which resolves the calling API key to exactly one
-- Organization). The generic `integrations` table (024_create_integrations.sql,
-- widened by 315_add_config_to_integrations.sql) already carries one row
-- per (project_id, provider) with a `config` jsonb for non-secret settings
-- and an encrypted_credential_ref for the real Postiz API key — this table
-- adds the one additional fact that table's shape can't itself enforce:
-- a hard 1:1 between a platform tenant and a Postiz Organization, via the
-- UNIQUE(tenant_id) constraint below. A tenant with multiple projects each
-- wanting their own Postiz integration row would otherwise have no DB-level
-- guard against accidentally pointing two of them at two different Postiz
-- Organizations (or, worse, misconfiguring one to reuse another tenant's
-- organization id) — this table is the single source of truth checked
-- before any publish/schedule call is allowed to proceed (see
-- apps/api/src/routes/postizIntegration.ts).
CREATE TABLE postiz_organization_links (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  integration_id         uuid NOT NULL REFERENCES integrations (id) ON DELETE CASCADE,
  -- The Postiz-side Organization id this tenant is bound to (from GET
  -- /public/v1/me's `organization.id`) — never guessed, always confirmed
  -- by a real API call before this row is written (see postizIntegration.ts's
  -- connect handler).
  postiz_organization_id text NOT NULL,
  postiz_organization_name text,
  connected_by           uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT postiz_organization_links_tenant_key UNIQUE (tenant_id),
  CONSTRAINT postiz_organization_links_integration_key UNIQUE (integration_id)
);

CREATE TRIGGER trg_postiz_organization_links_set_updated_at
  BEFORE UPDATE ON postiz_organization_links
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_postiz_organization_links_tenant_id ON postiz_organization_links (tenant_id);

-- Down Migration

DROP TABLE IF EXISTS postiz_organization_links;
