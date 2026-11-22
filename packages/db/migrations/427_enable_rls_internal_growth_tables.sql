-- Up Migration
--
-- Same tenant-isolation pattern as 013_enable_rls_policies.sql /
-- 324_enable_rls_prospecting_campaigns.sql, applied to every table added
-- in 422-425 for DevLaunch's internal growth workspace. This internal
-- tenant gets NO special bypass: it is isolated by the exact same
-- current_setting('app.current_tenant_id', true)::uuid check as every
-- client tenant's rows — the only thing that makes it "internal" is which
-- routes are authorized to read/write it (app-level), never a difference
-- in this policy.

ALTER TABLE growth_audit_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_audit_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY growth_audit_requests_isolation ON growth_audit_requests
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE demo_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY demo_requests_isolation ON demo_requests
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE trial_signups ENABLE ROW LEVEL SECURITY;
ALTER TABLE trial_signups FORCE ROW LEVEL SECURITY;
CREATE POLICY trial_signups_isolation ON trial_signups
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE acquisition_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE acquisition_costs FORCE ROW LEVEL SECURITY;
CREATE POLICY acquisition_costs_isolation ON acquisition_costs
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS acquisition_costs_isolation ON acquisition_costs;
ALTER TABLE acquisition_costs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE acquisition_costs DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trial_signups_isolation ON trial_signups;
ALTER TABLE trial_signups NO FORCE ROW LEVEL SECURITY;
ALTER TABLE trial_signups DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS demo_requests_isolation ON demo_requests;
ALTER TABLE demo_requests NO FORCE ROW LEVEL SECURITY;
ALTER TABLE demo_requests DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS growth_audit_requests_isolation ON growth_audit_requests;
ALTER TABLE growth_audit_requests NO FORCE ROW LEVEL SECURITY;
ALTER TABLE growth_audit_requests DISABLE ROW LEVEL SECURITY;
