-- Up Migration

-- generated_reports: one real generated PDF client report, either produced
-- on-demand (POST .../reports/generate, schedule_id NULL) or by a due
-- report_schedules row. Mirrors agent_executions' queued -> running ->
-- succeeded/failed lifecycle so the API can enqueue a BullMQ job and the
-- dashboard can poll the same way it polls agent executions.
--
-- file_path is a path relative to REPORT_FILES_DIR (see apps/worker/src/reports
-- and apps/api/src/routes/reports.ts) on the shared `report_files` volume —
-- never a public URL. The only way to read the bytes back is the
-- authenticated, tenant-isolated GET .../reports/:id/download route.
CREATE TABLE generated_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  schedule_id     uuid REFERENCES report_schedules (id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  period_start    timestamptz NOT NULL,
  period_end      timestamptz NOT NULL,
  file_path       text,
  file_bytes      integer,
  error           text,
  created_by      text,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_generated_reports_set_updated_at
  BEFORE UPDATE ON generated_reports
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_generated_reports_tenant_id ON generated_reports (tenant_id);
CREATE INDEX idx_generated_reports_project_id ON generated_reports (project_id);
CREATE INDEX idx_generated_reports_schedule_id ON generated_reports (schedule_id);
CREATE INDEX idx_generated_reports_tenant_created_at ON generated_reports (tenant_id, created_at);

-- Down Migration

DROP TABLE IF EXISTS generated_reports;
