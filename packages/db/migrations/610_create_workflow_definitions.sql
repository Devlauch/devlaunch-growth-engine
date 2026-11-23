-- Up Migration
--
-- Workstream B: native, tenant-aware lifecycle-workflow automation engine
-- (apps/api/src/lib/workflowEngine.ts). This is a DIFFERENT concept than
-- the existing apps/api/src/workflow/ "Phase 4 autonomous pipeline"
-- (client onboarding -> research -> ... -> analytics/learning, one fixed
-- linear run per project, see workflowsRouter/WorkflowPage.tsx): that is a
-- single orchestrated agent pipeline; this is a library of independently
-- configurable, reusable lifecycle-automation DEFINITIONS (e.g. "inactive
-- lead reactivation", "demo follow-up"), each with its own trigger and a
-- small DAG of condition/action nodes, any number of which can be active
-- per project at once. Deliberately separate tables/routes/nav entry
-- ("workflow-automation", not "workflows") so the two never collide.
--
-- `trigger_type` is either 'scheduled' (apps/worker/src/cron/
-- workflowTriggerCron.ts fires it on a fixed interval read from
-- trigger_config.intervalMinutes) or 'condition' (the same cron instead
-- polls for rows matching trigger_config's {entity, field, operator,
-- value, sinceField} shape — e.g. "leads where status = 'new' and
-- created_at < now() - interval '14 days'" for inactive-lead
-- reactivation) or 'event' (fired directly by a future caller via
-- runWorkflow(), e.g. a route handler on a real domain event — no polling
-- needed; present for completeness, not polled by workflowTriggerCron).
--
-- `nodes` is a small jsonb DAG: an array of
-- { key, type: 'condition'|'action', config, next?, onTrue?, onFalse? }
-- objects (see workflowEngine.ts's WorkflowNode type for the exact
-- shape this is validated against at read time). Validation of the DAG
-- shape itself is application-level (zod, in workflowAutomation.ts),
-- mirroring every other jsonb-column convention in this codebase (e.g.
-- sequences.steps, content_calendars items) — Postgres only guarantees
-- it is valid jsonb, not a valid DAG.
CREATE TABLE workflow_definitions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name            text NOT NULL,
  trigger_type    text NOT NULL CHECK (trigger_type IN ('scheduled', 'condition', 'event')),
  trigger_config  jsonb NOT NULL DEFAULT '{}'::jsonb,
  nodes           jsonb NOT NULL DEFAULT '[]'::jsonb,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'draft')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_workflow_definitions_set_updated_at
  BEFORE UPDATE ON workflow_definitions
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_workflow_definitions_tenant_id ON workflow_definitions (tenant_id);
CREATE INDEX idx_workflow_definitions_project_id ON workflow_definitions (project_id);
CREATE INDEX idx_workflow_definitions_tenant_status ON workflow_definitions (tenant_id, status);
CREATE INDEX idx_workflow_definitions_trigger_type ON workflow_definitions (trigger_type) WHERE status = 'active';

-- Down Migration

DROP TABLE IF EXISTS workflow_definitions;
