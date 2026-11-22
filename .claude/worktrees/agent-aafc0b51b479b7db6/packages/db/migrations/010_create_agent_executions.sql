-- Up Migration

-- agent_executions is one run (invocation) of an agent_instances row,
-- including its inputs/outputs and status. Tenant-owned.
CREATE TABLE agent_executions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  agent_instance_id uuid NOT NULL REFERENCES agent_instances (id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'awaiting_approval')),
  trigger         text NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'schedule', 'event', 'api')),
  input           jsonb NOT NULL DEFAULT '{}'::jsonb,
  output          jsonb NOT NULL DEFAULT '{}'::jsonb,
  error           text,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_agent_executions_set_updated_at
  BEFORE UPDATE ON agent_executions
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_agent_executions_tenant_id ON agent_executions (tenant_id);
CREATE INDEX idx_agent_executions_agent_instance_id ON agent_executions (agent_instance_id);
CREATE INDEX idx_agent_executions_tenant_status ON agent_executions (tenant_id, status);
CREATE INDEX idx_agent_executions_created_at ON agent_executions (created_at);

-- Down Migration

DROP TABLE IF EXISTS agent_executions;
