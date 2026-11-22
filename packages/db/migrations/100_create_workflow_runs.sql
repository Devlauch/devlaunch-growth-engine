-- Up Migration
--
-- Phase 4 ("make the agents work together"): a workflow_run is one
-- end-to-end pass of the autonomous pipeline (client onboarding ->
-- research -> lead generation -> content/campaign -> human approval ->
-- approval/compliance gate -> campaign execution -> analytics/learning)
-- for a single project. The generic stage-execution engine
-- (apps/api/src/workflow/engine.ts) advances current_stage one stage at a
-- time; workflow_stage_results (101) keeps the full history of every
-- attempt at every stage.

CREATE TABLE workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'awaiting_approval', 'completed', 'failed')),
  current_stage text NOT NULL DEFAULT 'client_onboarding',
  input_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX idx_workflow_runs_tenant_id ON workflow_runs (tenant_id);
CREATE INDEX idx_workflow_runs_project_id ON workflow_runs (project_id);
CREATE INDEX idx_workflow_runs_project_id_status ON workflow_runs (project_id, status);

-- Same set_updated_at() trigger function used across the schema (see e.g.
-- 020_create_campaigns.sql) — already created, not redefined here.
CREATE TRIGGER trg_workflow_runs_set_updated_at
  BEFORE UPDATE ON workflow_runs
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TRIGGER IF EXISTS trg_workflow_runs_set_updated_at ON workflow_runs;
DROP TABLE IF EXISTS workflow_runs;
