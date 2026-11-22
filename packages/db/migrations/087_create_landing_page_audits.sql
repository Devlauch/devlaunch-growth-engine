-- Up Migration
--
-- Phase 2 item 5, "Conversion Optimization Agent": landing_page_audits
-- stores the result of a real fetch+regex audit of a single landing page
-- URL (see apps/api/src/lib/landingPageAudit.ts). Tenant/project-owned,
-- same shape as every other table here.
--
-- findings is a real, derived jsonb array of {issue, detail, severity}
-- objects computed from the fetched HTML at audit time — never fabricated.

CREATE TABLE landing_page_audits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  url             text NOT NULL,
  audited_at      timestamptz NOT NULL DEFAULT now(),
  has_cta         boolean NOT NULL,
  has_form        boolean NOT NULL,
  word_count      integer NOT NULL,
  heading_count   integer NOT NULL,
  load_status     text NOT NULL CHECK (load_status IN ('ok', 'error', 'timeout')),
  findings        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_landing_page_audits_tenant_id ON landing_page_audits (tenant_id);
CREATE INDEX idx_landing_page_audits_project_id ON landing_page_audits (project_id);
CREATE INDEX idx_landing_page_audits_project_audited_at ON landing_page_audits (project_id, audited_at DESC);

-- Down Migration

DROP TABLE IF EXISTS landing_page_audits;
