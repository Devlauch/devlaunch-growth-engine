-- Up Migration
--
-- Same tenant-isolation pattern as every other "_enable_rls_" migration
-- (e.g. 277_enable_rls_channel_execution.sql, 287_enable_rls_integration_webhook_events.sql),
-- applied to 291_create_listmonk_mappings.sql's three tables.
ALTER TABLE listmonk_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE listmonk_lists FORCE ROW LEVEL SECURITY;
CREATE POLICY listmonk_lists_isolation ON listmonk_lists
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE listmonk_subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE listmonk_subscribers FORCE ROW LEVEL SECURITY;
CREATE POLICY listmonk_subscribers_isolation ON listmonk_subscribers
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE listmonk_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE listmonk_campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY listmonk_campaigns_isolation ON listmonk_campaigns
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS listmonk_campaigns_isolation ON listmonk_campaigns;
ALTER TABLE listmonk_campaigns NO FORCE ROW LEVEL SECURITY;
ALTER TABLE listmonk_campaigns DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS listmonk_subscribers_isolation ON listmonk_subscribers;
ALTER TABLE listmonk_subscribers NO FORCE ROW LEVEL SECURITY;
ALTER TABLE listmonk_subscribers DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS listmonk_lists_isolation ON listmonk_lists;
ALTER TABLE listmonk_lists NO FORCE ROW LEVEL SECURITY;
ALTER TABLE listmonk_lists DISABLE ROW LEVEL SECURITY;
