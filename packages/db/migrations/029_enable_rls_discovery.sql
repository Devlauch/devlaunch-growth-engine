-- Up Migration
--
-- Same tenant-isolation pattern as 013_enable_rls_policies.sql /
-- 017_enable_rls_leads.sql / 022_enable_rls_campaigns.sql, applied to the
-- three tables added in 026_create_discovery_sources.sql,
-- 027_create_discovered_organizations.sql and
-- 028_create_discovered_contacts.sql.

ALTER TABLE discovery_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovery_sources FORCE ROW LEVEL SECURITY;

CREATE POLICY discovery_sources_isolation ON discovery_sources
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE discovered_organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovered_organizations FORCE ROW LEVEL SECURITY;

CREATE POLICY discovered_organizations_isolation ON discovered_organizations
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE discovered_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE discovered_contacts FORCE ROW LEVEL SECURITY;

CREATE POLICY discovered_contacts_isolation ON discovered_contacts
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS discovered_contacts_isolation ON discovered_contacts;
ALTER TABLE discovered_contacts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE discovered_contacts DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS discovered_organizations_isolation ON discovered_organizations;
ALTER TABLE discovered_organizations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE discovered_organizations DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS discovery_sources_isolation ON discovery_sources;
ALTER TABLE discovery_sources NO FORCE ROW LEVEL SECURITY;
ALTER TABLE discovery_sources DISABLE ROW LEVEL SECURITY;
