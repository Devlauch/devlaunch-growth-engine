-- Up Migration
--
-- Same tenant-isolation pattern as 013_enable_rls_policies.sql /
-- 017_enable_rls_leads.sql / 022_enable_rls_campaigns.sql, applied to the
-- three tables added in 031_create_scoring_rubrics.sql,
-- 032_create_lead_scores.sql, and 033_create_lead_score_feedback.sql.

ALTER TABLE scoring_rubrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE scoring_rubrics FORCE ROW LEVEL SECURITY;

CREATE POLICY scoring_rubrics_isolation ON scoring_rubrics
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE lead_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_scores FORCE ROW LEVEL SECURITY;

CREATE POLICY lead_scores_isolation ON lead_scores
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE lead_score_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_score_feedback FORCE ROW LEVEL SECURITY;

CREATE POLICY lead_score_feedback_isolation ON lead_score_feedback
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS lead_score_feedback_isolation ON lead_score_feedback;
ALTER TABLE lead_score_feedback NO FORCE ROW LEVEL SECURITY;
ALTER TABLE lead_score_feedback DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_scores_isolation ON lead_scores;
ALTER TABLE lead_scores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE lead_scores DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scoring_rubrics_isolation ON scoring_rubrics;
ALTER TABLE scoring_rubrics NO FORCE ROW LEVEL SECURITY;
ALTER TABLE scoring_rubrics DISABLE ROW LEVEL SECURITY;
