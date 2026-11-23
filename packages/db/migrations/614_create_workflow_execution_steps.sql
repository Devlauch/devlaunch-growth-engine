-- Up Migration
--
-- One row per node visited during a workflow_executions run
-- (612_create_workflow_executions.sql) — the real per-node execution
-- history apps/api/src/lib/workflowEngine.ts's runWorkflow() writes as it
-- walks a workflow_definitions row's `nodes` DAG, and what GET
-- .../workflow-automation/:id/executions/:executionId (workflowAutomation.ts)
-- reads to show exactly which node ran, with what input, what it produced,
-- and whether/why it failed — never a synthesized "it probably did X".
CREATE TABLE workflow_execution_steps (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  execution_id   uuid NOT NULL REFERENCES workflow_executions (id) ON DELETE CASCADE,
  node_key       text NOT NULL,
  status         text NOT NULL CHECK (status IN ('succeeded', 'failed', 'skipped')),
  input          jsonb NOT NULL DEFAULT '{}'::jsonb,
  output         jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_workflow_execution_steps_tenant_id ON workflow_execution_steps (tenant_id);
CREATE INDEX idx_workflow_execution_steps_execution_id ON workflow_execution_steps (execution_id);

-- Down Migration

DROP TABLE IF EXISTS workflow_execution_steps;
