-- Up Migration
--
-- leads: tenant-isolated contacts/leads captured for a project, from any
-- source (internal agent, manual entry, or the public embeddable widget —
-- see 016_add_project_public_key.sql). This is the single ingestion path:
-- both internal and public submissions insert into this same table, just
-- through different authentication boundaries (see apps/api
-- src/lib/leadIngestion.ts and src/routes/publicLeads.ts).
CREATE TABLE leads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name            text,
  email           text,
  company         text,
  message         text,
  custom_fields   jsonb NOT NULL DEFAULT '{}'::jsonb,
  source          text NOT NULL DEFAULT 'internal' CHECK (source IN ('internal', 'public_widget', 'agent', 'import')),
  status          text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'qualified', 'rejected', 'approved_for_outreach', 'archived')),
  origin          text,
  ip_hash         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- A lead must have at least an email or a name to be useful.
  CONSTRAINT leads_identity_present CHECK (email IS NOT NULL OR name IS NOT NULL)
);

CREATE TRIGGER trg_leads_set_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_leads_tenant_id ON leads (tenant_id);
CREATE INDEX idx_leads_project_id ON leads (project_id);
CREATE INDEX idx_leads_tenant_status ON leads (tenant_id, status);
CREATE INDEX idx_leads_tenant_created_at ON leads (tenant_id, created_at);
CREATE INDEX idx_leads_source ON leads (source);

-- Down Migration

DROP TABLE IF EXISTS leads;
