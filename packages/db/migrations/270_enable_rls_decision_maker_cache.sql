-- Up Migration
--
-- Same tenant-isolation pattern as 022_enable_rls_campaigns.sql /
-- 034_enable_rls_scoring.sql / 231_enable_rls_usage_events.sql, applied to
-- 269_create_decision_maker_cache.sql.

ALTER TABLE decision_maker_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_maker_cache FORCE ROW LEVEL SECURITY;

CREATE POLICY decision_maker_cache_isolation ON decision_maker_cache
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS decision_maker_cache_isolation ON decision_maker_cache;
ALTER TABLE decision_maker_cache NO FORCE ROW LEVEL SECURITY;
ALTER TABLE decision_maker_cache DISABLE ROW LEVEL SECURITY;
