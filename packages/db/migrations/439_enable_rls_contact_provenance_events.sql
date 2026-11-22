-- Up Migration
--
-- Same tenant-isolation pattern as 013_enable_rls_policies.sql /
-- 025_enable_rls_integrations.sql / 029_enable_rls_discovery.sql, applied to
-- the table added in 438_create_contact_provenance_events.sql.

ALTER TABLE contact_provenance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_provenance_events FORCE ROW LEVEL SECURITY;

CREATE POLICY contact_provenance_events_isolation ON contact_provenance_events
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS contact_provenance_events_isolation ON contact_provenance_events;
ALTER TABLE contact_provenance_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE contact_provenance_events DISABLE ROW LEVEL SECURITY;
