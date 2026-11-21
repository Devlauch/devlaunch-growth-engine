-- Up Migration
--
-- Same tenant-isolation pattern as 022_enable_rls_campaigns.sql /
-- 034_enable_rls_scoring.sql, applied to 058_create_lead_replies.sql.

ALTER TABLE lead_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_replies FORCE ROW LEVEL SECURITY;

CREATE POLICY lead_replies_isolation ON lead_replies
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS lead_replies_isolation ON lead_replies;
ALTER TABLE lead_replies NO FORCE ROW LEVEL SECURITY;
ALTER TABLE lead_replies DISABLE ROW LEVEL SECURITY;
