-- Up Migration
--
-- Same tenant-isolation pattern as 013_enable_rls_policies.sql /
-- 017_enable_rls_leads.sql / 283_enable_rls_sales_conversion.sql /
-- 304_enable_rls_companies.sql, applied to the `contacts` table added in
-- 307_create_contacts.sql.

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;

CREATE POLICY contacts_isolation ON contacts
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS contacts_isolation ON contacts;
ALTER TABLE contacts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE contacts DISABLE ROW LEVEL SECURITY;
