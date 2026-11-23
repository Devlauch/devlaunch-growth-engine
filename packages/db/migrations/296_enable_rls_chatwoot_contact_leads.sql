-- Up Migration
--
-- Same tenant-isolation pattern as every other "_enable_rls_" migration
-- (e.g. 287_enable_rls_integration_webhook_events.sql), applied to
-- 295_create_chatwoot_contact_leads.sql.
ALTER TABLE chatwoot_contact_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatwoot_contact_leads FORCE ROW LEVEL SECURITY;

CREATE POLICY chatwoot_contact_leads_isolation ON chatwoot_contact_leads
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS chatwoot_contact_leads_isolation ON chatwoot_contact_leads;
ALTER TABLE chatwoot_contact_leads NO FORCE ROW LEVEL SECURITY;
ALTER TABLE chatwoot_contact_leads DISABLE ROW LEVEL SECURITY;
