-- Up Migration
--
-- Same tenant-isolation pattern as 287_enable_rls_integration_webhook_events.sql,
-- applied to 524_create_billing_webhook_events.sql.
ALTER TABLE billing_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_webhook_events FORCE ROW LEVEL SECURITY;

CREATE POLICY billing_webhook_events_isolation ON billing_webhook_events
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS billing_webhook_events_isolation ON billing_webhook_events;
ALTER TABLE billing_webhook_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_webhook_events DISABLE ROW LEVEL SECURITY;
