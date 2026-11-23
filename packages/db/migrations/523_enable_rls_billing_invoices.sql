-- Up Migration
--
-- Same tenant-isolation pattern as 521_enable_rls_billing_subscriptions.sql,
-- applied to 522_create_billing_invoices.sql.
ALTER TABLE billing_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_invoices FORCE ROW LEVEL SECURITY;

CREATE POLICY billing_invoices_isolation ON billing_invoices
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS billing_invoices_isolation ON billing_invoices;
ALTER TABLE billing_invoices NO FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_invoices DISABLE ROW LEVEL SECURITY;
