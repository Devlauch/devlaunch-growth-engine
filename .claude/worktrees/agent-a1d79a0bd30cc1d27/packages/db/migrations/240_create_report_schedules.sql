-- Up Migration

-- report_schedules: a recurring "generate a client PDF report" schedule for
-- a project (e.g. weekly / monthly). Tenant-owned. The worker-side
-- schedule loop (apps/worker/src/reports/scheduleLoop.ts) polls this table
-- and, for each enabled row whose frequency interval has elapsed since
-- last_generated_at, generates a report exactly like the on-demand
-- POST .../reports/generate path and advances last_generated_at.
--
-- recipients is stored only (jsonb array of email strings) — this
-- environment has no real SMTP/email-provider configured, so nothing here
-- ever sends email; recipients exist purely as "who should eventually get
-- this" metadata for whichever future integration wires up real delivery.
CREATE TABLE report_schedules (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id         uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  frequency          text NOT NULL CHECK (frequency IN ('weekly', 'monthly')),
  recipients         jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled            boolean NOT NULL DEFAULT true,
  last_generated_at  timestamptz,
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_report_schedules_set_updated_at
  BEFORE UPDATE ON report_schedules
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_report_schedules_tenant_id ON report_schedules (tenant_id);
CREATE INDEX idx_report_schedules_project_id ON report_schedules (project_id);
CREATE INDEX idx_report_schedules_enabled ON report_schedules (enabled) WHERE enabled = true;

-- Down Migration

DROP TABLE IF EXISTS report_schedules;
