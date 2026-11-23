-- Up Migration
--
-- Additive-only extension of the EXISTING generated_reports table
-- (241_create_generated_reports.sql, Phase 3's client-PDF-reports
-- pipeline) so a growth-audit report (routes/publicGrowth.ts's
-- POST /public/growth-audit) can be generated through the SAME
-- queue/worker/file-store/download pipeline as a normal client report,
-- rather than building a second report-generation system.
--
-- kind defaults to 'client_summary' so every pre-existing row and every
-- pre-existing call site (POST .../reports/generate, scheduleLoop.ts) is
-- completely unaffected — this column only ever matters to the new branch
-- in apps/worker/src/reports/reportWorker.ts that checks it.
--
-- growth_analysis_id is nullable and only ever set for kind =
-- 'growth_audit' rows; it points at the real growth_analyses row
-- (260_create_growth_analyses.sql) produced by runGrowthAnalysis() for
-- this request, so the growth-audit PDF renderer reads real crawl/
-- extraction data, never a fabricated summary.
ALTER TABLE generated_reports
  ADD COLUMN kind text NOT NULL DEFAULT 'client_summary'
    CHECK (kind IN ('client_summary', 'growth_audit'));

ALTER TABLE generated_reports
  ADD COLUMN growth_analysis_id uuid REFERENCES growth_analyses (id) ON DELETE SET NULL;

CREATE INDEX idx_generated_reports_growth_analysis_id ON generated_reports (growth_analysis_id);

-- Down Migration

DROP INDEX IF EXISTS idx_generated_reports_growth_analysis_id;
ALTER TABLE generated_reports DROP COLUMN IF EXISTS growth_analysis_id;
ALTER TABLE generated_reports DROP COLUMN IF EXISTS kind;
