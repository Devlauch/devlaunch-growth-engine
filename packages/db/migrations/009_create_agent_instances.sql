-- Up Migration

-- agent_instances is a concrete, configured agent attached to a project
-- (instantiated from an agent_templates row). Tenant-owned.
CREATE TABLE agent_instances (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  template_id     uuid NOT NULL REFERENCES agent_templates (id) ON DELETE RESTRICT,
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  schedule        text,
  last_run_at     timestamptz,
  created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_agent_instances_set_updated_at
  BEFORE UPDATE ON agent_instances
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_agent_instances_tenant_id ON agent_instances (tenant_id);
CREATE INDEX idx_agent_instances_project_id ON agent_instances (project_id);
CREATE INDEX idx_agent_instances_template_id ON agent_instances (template_id);
CREATE INDEX idx_agent_instances_tenant_status ON agent_instances (tenant_id, status);

-- Down Migration

DROP TABLE IF EXISTS agent_instances;
