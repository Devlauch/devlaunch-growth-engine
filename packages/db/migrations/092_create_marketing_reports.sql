-- Up Migration
--
-- Phase 2 item 6 ("Marketing Intelligence Agent"): "Generate weekly and
-- monthly reports." marketing_reports stores one row per generated report —
-- generation itself happens in apps/api/src/lib/reportGenerator.ts, which
-- runs real aggregate queries (new leads, by-status/by-source breakdowns,
-- campaign counts, average lead score where available, funnel-stage counts
-- for the window) and stores the full real result as `summary_data`. Every
-- field in `summary_data` is either a real number or an honest `null`/
-- "no data yet" string — never a fabricated figure (same convention as
-- apps/api/src/routes/analytics.ts's /funnel endpoint).
CREATE TABLE marketing_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  period_type     text NOT NULL CHECK (period_type IN ('weekly', 'monthly')),
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  summary_data    jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_marketing_reports_tenant_id ON marketing_reports (tenant_id);
CREATE INDEX idx_marketing_reports_project_id ON marketing_reports (project_id);
CREATE INDEX idx_marketing_reports_project_period ON marketing_reports (project_id, period_type, period_start DESC);

-- Down Migration

DROP TABLE IF EXISTS marketing_reports;
