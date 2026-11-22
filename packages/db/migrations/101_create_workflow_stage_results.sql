-- Up Migration
--
-- One row per attempt at a workflow stage (see 100_create_workflow_runs.sql
-- for the parent run). A stage can legitimately run more than once — most
-- notably approval_compliance_gate, which re-runs after a human approves
-- the pending drafts elsewhere in the app — so this table is append-only
-- history, never overwritten in place.

CREATE TABLE workflow_stage_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN (
    'client_onboarding',
    'research',
    'lead_generation',
    'content_campaign',
    'approval_compliance_gate',
    'campaign_execution',
    'analytics_learning'
  )),
  status text NOT NULL CHECK (status IN ('completed', 'failed', 'needs_approval')),
  summary text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  approval_context jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_workflow_stage_results_tenant_id ON workflow_stage_results (tenant_id);
CREATE INDEX idx_workflow_stage_results_workflow_run_id ON workflow_stage_results (workflow_run_id);
CREATE INDEX idx_workflow_stage_results_run_stage_created_at
  ON workflow_stage_results (workflow_run_id, stage, created_at DESC);

-- Down Migration

DROP TABLE IF EXISTS workflow_stage_results;
