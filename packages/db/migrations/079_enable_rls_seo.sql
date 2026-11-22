-- Up Migration
--
-- Same tenant-isolation pattern as 022_enable_rls_campaigns.sql, applied
-- to the three tables added in 076/077/078 for the Technical SEO Agent.

ALTER TABLE seo_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE seo_audits FORCE ROW LEVEL SECURITY;

CREATE POLICY seo_audits_isolation ON seo_audits
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE seo_audit_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE seo_audit_issues FORCE ROW LEVEL SECURITY;

CREATE POLICY seo_audit_issues_isolation ON seo_audit_issues
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE keyword_rankings ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyword_rankings FORCE ROW LEVEL SECURITY;

CREATE POLICY keyword_rankings_isolation ON keyword_rankings
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS keyword_rankings_isolation ON keyword_rankings;
ALTER TABLE keyword_rankings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE keyword_rankings DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS seo_audit_issues_isolation ON seo_audit_issues;
ALTER TABLE seo_audit_issues NO FORCE ROW LEVEL SECURITY;
ALTER TABLE seo_audit_issues DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS seo_audits_isolation ON seo_audits;
ALTER TABLE seo_audits NO FORCE ROW LEVEL SECURITY;
ALTER TABLE seo_audits DISABLE ROW LEVEL SECURITY;
