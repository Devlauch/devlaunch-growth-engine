-- Up Migration
--
-- Same tenant-isolation pattern as every other "_enable_rls_" migration
-- (e.g. 059_enable_rls_lead_replies.sql, 277_enable_rls_channel_execution.sql),
-- applied to 286_create_integration_webhook_events.sql.
ALTER TABLE integration_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_webhook_events FORCE ROW LEVEL SECURITY;

CREATE POLICY integration_webhook_events_isolation ON integration_webhook_events
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS integration_webhook_events_isolation ON integration_webhook_events;
ALTER TABLE integration_webhook_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE integration_webhook_events DISABLE ROW LEVEL SECURITY;
