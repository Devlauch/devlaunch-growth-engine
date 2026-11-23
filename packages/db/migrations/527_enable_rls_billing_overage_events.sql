-- Up Migration
--
-- Same tenant-isolation pattern as every other "_enable_rls_" migration,
-- applied to 526_create_billing_overage_events.sql.
ALTER TABLE billing_overage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_overage_events FORCE ROW LEVEL SECURITY;

CREATE POLICY billing_overage_events_isolation ON billing_overage_events
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS billing_overage_events_isolation ON billing_overage_events;
ALTER TABLE billing_overage_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_overage_events DISABLE ROW LEVEL SECURITY;
