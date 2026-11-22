-- Up Migration

-- approvals records human-in-the-loop sign-off on an agent_executions row
-- (e.g. "approve this outbound campaign before it sends"). Tenant-owned.
CREATE TABLE approvals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  agent_execution_id uuid NOT NULL REFERENCES agent_executions (id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  requested_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  reviewed_by     uuid REFERENCES users (id) ON DELETE SET NULL,
  reason          text,
  decision_notes  text,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_at     timestamptz,
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_approvals_set_updated_at
  BEFORE UPDATE ON approvals
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_approvals_tenant_id ON approvals (tenant_id);
CREATE INDEX idx_approvals_agent_execution_id ON approvals (agent_execution_id);
CREATE INDEX idx_approvals_tenant_status ON approvals (tenant_id, status);

-- Down Migration

DROP TABLE IF EXISTS approvals;
