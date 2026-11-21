-- Up Migration
--
-- Same tenant-isolation pattern as 013_enable_rls_policies.sql /
-- 017_enable_rls_leads.sql / 022_enable_rls_campaigns.sql /
-- 038_enable_rls_compliance.sql, applied to the three tables added in
-- 060/061/062 for roadmap item 14 ("Sending setup per tenant").

ALTER TABLE sending_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE sending_domains FORCE ROW LEVEL SECURITY;

CREATE POLICY sending_domains_isolation ON sending_domains
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE warmup_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE warmup_configs FORCE ROW LEVEL SECURITY;

CREATE POLICY warmup_configs_isolation ON warmup_configs
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE send_health_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE send_health_stats FORCE ROW LEVEL SECURITY;

CREATE POLICY send_health_stats_isolation ON send_health_stats
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS send_health_stats_isolation ON send_health_stats;
ALTER TABLE send_health_stats NO FORCE ROW LEVEL SECURITY;
ALTER TABLE send_health_stats DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS warmup_configs_isolation ON warmup_configs;
ALTER TABLE warmup_configs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE warmup_configs DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sending_domains_isolation ON sending_domains;
ALTER TABLE sending_domains NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sending_domains DISABLE ROW LEVEL SECURITY;
