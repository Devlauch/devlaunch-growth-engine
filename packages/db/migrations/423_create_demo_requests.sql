-- Up Migration
--
-- demo_requests: one real visitor-submitted "request a demo" form from
-- routes/publicGrowth.ts's unauthenticated POST /public/demo-request.
-- Always scoped to the internal workspace tenant/project (see
-- 421_create_devlaunch_internal_workspace.sql). Reuses the existing
-- ingestLead() path for the real lead row (FK lead_id) — this table only
-- holds the demo-request-specific form fields + the link to that lead; it
-- is not a second lead-capture system.
CREATE TABLE demo_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name        text NOT NULL,
  email       text NOT NULL,
  company     text,
  message     text,
  lead_id     uuid REFERENCES leads (id) ON DELETE SET NULL,
  ip_hash     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_demo_requests_tenant_id ON demo_requests (tenant_id);
CREATE INDEX idx_demo_requests_project_id ON demo_requests (project_id);
CREATE INDEX idx_demo_requests_tenant_created_at ON demo_requests (tenant_id, created_at);
CREATE INDEX idx_demo_requests_lead_id ON demo_requests (lead_id);

-- Down Migration

DROP TABLE IF EXISTS demo_requests;
