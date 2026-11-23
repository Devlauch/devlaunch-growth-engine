-- Up Migration
--
-- growth_audit_requests: one real visitor-initiated "free website growth
-- audit" request against routes/publicGrowth.ts's unauthenticated
-- POST /public/growth-audit. Always scoped to the internal workspace
-- tenant/project (see 421_create_devlaunch_internal_workspace.sql) — a
-- client tenant's own `growth_analyses` (260_create_growth_analyses.sql)
-- are a completely separate feature/table and are not touched by this one.
--
-- Reuses rather than duplicates:
--  - growth_analyses (FK growth_analysis_id): the actual crawl/extraction
--    result from apps/api/src/lib/growthAnalyzer.ts's runGrowthAnalysis()
--    is inserted into the EXISTING growth_analyses table, exactly like
--    routes/growthAnalyzer.ts's POST /analyze does for an authenticated
--    client tenant. This row is just the public-request wrapper around it
--    (who asked, with what domain/email, tied to which real lead).
--  - leads (FK lead_id): the visitor's domain/email becomes a real lead via
--    the existing ingestLead() path (source 'public_widget'), not a new
--    lead-insert path.
--  - generated_reports (FK report_id, nullable until the async PDF job is
--    enqueued): the existing client-report pipeline
--    (apps/worker/src/reports/) generates the "personalised business
--    report" PDF — see 426_add_growth_audit_fields_to_generated_reports.sql
--    for the additive kind/growth_analysis_id columns that let the SAME
--    worker process branch to a growth-audit-specific render function
--    instead of a second reports system.
CREATE TABLE growth_audit_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id          uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  domain              text NOT NULL,
  email               text NOT NULL,
  lead_id             uuid REFERENCES leads (id) ON DELETE SET NULL,
  growth_analysis_id  uuid REFERENCES growth_analyses (id) ON DELETE SET NULL,
  report_id           uuid REFERENCES generated_reports (id) ON DELETE SET NULL,
  status              text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'partial', 'failed')),
  ip_hash             text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_growth_audit_requests_tenant_id ON growth_audit_requests (tenant_id);
CREATE INDEX idx_growth_audit_requests_project_id ON growth_audit_requests (project_id);
CREATE INDEX idx_growth_audit_requests_tenant_created_at ON growth_audit_requests (tenant_id, created_at);
CREATE INDEX idx_growth_audit_requests_lead_id ON growth_audit_requests (lead_id);

-- Down Migration

DROP TABLE IF EXISTS growth_audit_requests;
