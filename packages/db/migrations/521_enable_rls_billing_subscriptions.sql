-- Up Migration
--
-- Same tenant-isolation pattern as every other "_enable_rls_" migration
-- (e.g. 287_enable_rls_integration_webhook_events.sql), applied to
-- 520_create_billing_subscriptions.sql.
ALTER TABLE billing_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_subscriptions FORCE ROW LEVEL SECURITY;

CREATE POLICY billing_subscriptions_isolation ON billing_subscriptions
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS billing_subscriptions_isolation ON billing_subscriptions;
ALTER TABLE billing_subscriptions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_subscriptions DISABLE ROW LEVEL SECURITY;
