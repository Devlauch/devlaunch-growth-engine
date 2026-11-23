-- Up Migration
--
-- Same tenant-isolation pattern as 433_enable_rls_growth_advisor_recommendations.sql,
-- applied to 513_create_custom_domain_certificates.sql.

ALTER TABLE custom_domain_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_domain_certificates FORCE ROW LEVEL SECURITY;

CREATE POLICY custom_domain_certificates_isolation ON custom_domain_certificates
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS custom_domain_certificates_isolation ON custom_domain_certificates;
ALTER TABLE custom_domain_certificates NO FORCE ROW LEVEL SECURITY;
ALTER TABLE custom_domain_certificates DISABLE ROW LEVEL SECURITY;
