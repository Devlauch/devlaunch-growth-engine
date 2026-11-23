-- Up Migration
--
-- Same tenant-isolation pattern as 013_enable_rls_policies.sql /
-- 017_enable_rls_leads.sql / 283_enable_rls_sales_conversion.sql, applied
-- to the `companies` table added in 302_create_companies.sql.

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;

CREATE POLICY companies_isolation ON companies
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS companies_isolation ON companies;
ALTER TABLE companies NO FORCE ROW LEVEL SECURITY;
ALTER TABLE companies DISABLE ROW LEVEL SECURITY;
