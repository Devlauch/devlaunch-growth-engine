-- Up Migration
--
-- Same tenant-isolation pattern as 013_enable_rls_policies.sql /
-- 022_enable_rls_campaigns.sql, applied to the three lead-intelligence
-- tables added in 081/082/083.

ALTER TABLE company_enrichment ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_enrichment FORCE ROW LEVEL SECURITY;

CREATE POLICY company_enrichment_isolation ON company_enrichment
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE icp_match_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE icp_match_scores FORCE ROW LEVEL SECURITY;

CREATE POLICY icp_match_scores_isolation ON icp_match_scores
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE buying_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE buying_signals FORCE ROW LEVEL SECURITY;

CREATE POLICY buying_signals_isolation ON buying_signals
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS buying_signals_isolation ON buying_signals;
ALTER TABLE buying_signals NO FORCE ROW LEVEL SECURITY;
ALTER TABLE buying_signals DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS icp_match_scores_isolation ON icp_match_scores;
ALTER TABLE icp_match_scores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE icp_match_scores DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS company_enrichment_isolation ON company_enrichment;
ALTER TABLE company_enrichment NO FORCE ROW LEVEL SECURITY;
ALTER TABLE company_enrichment DISABLE ROW LEVEL SECURITY;
