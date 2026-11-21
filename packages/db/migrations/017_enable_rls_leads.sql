-- Up Migration
--
-- Same tenant-isolation pattern as 013_enable_rls_policies.sql, applied to
-- the leads table added in 015_create_leads.sql. This is what makes the
-- public lead-capture endpoint (which authenticates via a project's
-- public_api_key rather than a user session) still go through the exact
-- same tenant-isolated write path: the API resolves the project's
-- tenant_id from the public key, sets app.current_tenant_id to it, and
-- this policy is what actually enforces that the insert can only land in
-- that tenant's rows.
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads FORCE ROW LEVEL SECURITY;

CREATE POLICY leads_isolation ON leads
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS leads_isolation ON leads;
ALTER TABLE leads NO FORCE ROW LEVEL SECURITY;
ALTER TABLE leads DISABLE ROW LEVEL SECURITY;
