-- Up Migration
--
-- One row per real run of a workflow_definitions row
-- (610_create_workflow_definitions.sql), triggered either by
-- apps/worker/src/cron/workflowTriggerCron.ts (scheduled/condition
-- triggers) or a direct runWorkflow() call (event triggers) — see
-- apps/api/src/lib/workflowEngine.ts.
--
-- `dedupe_key` is a deterministic sha256 hash of (workflow_id +
-- canonicalized trigger_payload), computed by workflowEngine.ts's
-- computeDedupeKey(). The partial unique index below means a second
-- runWorkflow() call for the exact same workflow + trigger payload while a
-- prior run of it is still 'running' or already 'completed' is a genuine
-- no-op (returns the existing execution's id, never a second run) — the
-- same idempotency contract 286_create_integration_webhook_events.sql's
-- UNIQUE (integration_id, external_event_id) gives inbound webhooks,
-- applied here to workflow triggers instead. A 'failed' run is
-- deliberately EXCLUDED from the uniqueness check so a genuinely failed
-- run can be retried (e.g. the next scheduled/condition poll tick) without
-- ever being permanently wedged by its own failure.
CREATE TABLE workflow_executions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id       uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  workflow_id      uuid NOT NULL REFERENCES workflow_definitions (id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  trigger_payload   jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key       text NOT NULL,
  error            text,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_workflow_executions_tenant_id ON workflow_executions (tenant_id);
CREATE INDEX idx_workflow_executions_workflow_id ON workflow_executions (workflow_id);
CREATE INDEX idx_workflow_executions_tenant_started_at ON workflow_executions (tenant_id, started_at DESC);

-- Idempotency: see this file's header comment. Partial (excludes 'failed'
-- rows) so a failed run never permanently blocks a retry.
CREATE UNIQUE INDEX idx_workflow_executions_dedupe
  ON workflow_executions (workflow_id, dedupe_key)
  WHERE status <> 'failed';

-- Down Migration

DROP TABLE IF EXISTS workflow_executions;
