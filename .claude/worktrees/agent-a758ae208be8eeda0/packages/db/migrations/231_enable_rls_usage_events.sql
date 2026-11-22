-- Up Migration
--
-- Same tenant-isolation pattern as 022_enable_rls_campaigns.sql /
-- 034_enable_rls_scoring.sql / 059_enable_rls_lead_replies.sql, applied to
-- 230_create_usage_events.sql.

ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;

CREATE POLICY usage_events_isolation ON usage_events
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS usage_events_isolation ON usage_events;
ALTER TABLE usage_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_events DISABLE ROW LEVEL SECURITY;
