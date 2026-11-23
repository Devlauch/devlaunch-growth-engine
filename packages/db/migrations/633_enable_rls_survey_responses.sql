-- Up Migration
--
-- Plain tenant-isolation policy, same shape as 552_enable_rls_seo_campaigns.sql
-- -- no public carve-out is needed here (unlike 631's surveys policy):
-- the public submission route (publicSurveys.ts) first resolves the
-- survey's tenant_id/status via surveys' own public carve-out, THEN
-- switches the session to that real tenant (`SELECT set_config
-- ('app.current_tenant_id', ...)`) before inserting/updating a
-- survey_responses row — exactly the same two-step pattern
-- publicLeads.ts already uses for the `leads` table. So every write here
-- always goes through the normal tenant_id-scoped policy below.

ALTER TABLE survey_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE survey_responses FORCE ROW LEVEL SECURITY;

CREATE POLICY survey_responses_isolation ON survey_responses
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS survey_responses_isolation ON survey_responses;
ALTER TABLE survey_responses NO FORCE ROW LEVEL SECURITY;
ALTER TABLE survey_responses DISABLE ROW LEVEL SECURITY;
