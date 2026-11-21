-- Up Migration

-- integrations is a project-scoped registry row for one external provider
-- (see docs/PHASE1_REPORT.md / docs/DECISIONS.md for the provider list
-- this platform evaluated: twenty, mautic, postiz, listmonk, posthog,
-- formbricks). Tenant-owned, same shape as every other table here.
--
-- IMPORTANT — this is a registry/placeholder, not a working connection.
-- There is no real OAuth/API integration with any of these providers
-- implemented in this phase (see docs/PHASE1_REPORT.md's "hold off on
-- heavy optional services" recommendation). `encrypted_credential_ref` is
-- a nullable *reference* to where a real credential would eventually be
-- stored (e.g. a secrets-manager key) — this phase never writes a real
-- secret into this table, and the API layer
-- (apps/api/src/routes/integrations.ts) only ever accepts a manually
-- entered placeholder label and sets status to 'pending_setup'. Reaching
-- 'connected' is reserved for a later phase once a real provider
-- integration exists; nothing in this phase ever sets that status.
CREATE TABLE integrations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id              uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  provider                text NOT NULL CHECK (provider IN ('twenty', 'mautic', 'postiz', 'listmonk', 'posthog', 'formbricks')),
  status                  text NOT NULL DEFAULT 'not_connected' CHECK (status IN ('not_connected', 'pending_setup', 'connected', 'error')),
  encrypted_credential_ref text,
  scopes                  text[] NOT NULL DEFAULT '{}',
  created_by              uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT integrations_project_provider_key UNIQUE (project_id, provider)
);

CREATE TRIGGER trg_integrations_set_updated_at
  BEFORE UPDATE ON integrations
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_integrations_tenant_id ON integrations (tenant_id);
CREATE INDEX idx_integrations_project_id ON integrations (project_id);
CREATE INDEX idx_integrations_tenant_status ON integrations (tenant_id, status);

-- Down Migration

DROP TABLE IF EXISTS integrations;
