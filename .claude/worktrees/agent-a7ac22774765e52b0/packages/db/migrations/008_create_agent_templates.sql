-- Up Migration

-- agent_templates is the catalog of agent "blueprints" (role, prompt,
-- default config, tool access) that agent_instances are created from.
-- tenant_id is NULLABLE here: NULL rows are global/system templates shared
-- by every tenant (e.g. "Lead Research Agent"); a non-null tenant_id marks
-- a tenant's own private customization of (or addition to) the catalog.
-- The RLS policy in 013_enable_rls_policies.sql allows a tenant to see
-- global templates plus its own.
CREATE TABLE agent_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid REFERENCES tenants (id) ON DELETE CASCADE,
  key             text NOT NULL,
  name            text NOT NULL,
  description     text,
  category        text NOT NULL DEFAULT 'growth' CHECK (category IN ('growth', 'sales', 'data', 'ops', 'other')),
  version         integer NOT NULL DEFAULT 1,
  default_config  jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_templates_tenant_key_version_key UNIQUE (tenant_id, key, version)
);

CREATE TRIGGER trg_agent_templates_set_updated_at
  BEFORE UPDATE ON agent_templates
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_agent_templates_tenant_id ON agent_templates (tenant_id);
CREATE INDEX idx_agent_templates_key ON agent_templates (key);

-- Down Migration

DROP TABLE IF EXISTS agent_templates;
