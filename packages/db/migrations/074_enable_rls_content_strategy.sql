-- Up Migration
--
-- Same tenant-isolation pattern as 013_enable_rls_policies.sql /
-- 022_enable_rls_campaigns.sql, applied to the three tables added in
-- 071_create_content_calendars.sql / 072_create_content_calendar_items.sql /
-- 073_create_content_drafts.sql.

ALTER TABLE content_calendars ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_calendars FORCE ROW LEVEL SECURITY;

CREATE POLICY content_calendars_isolation ON content_calendars
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE content_calendar_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_calendar_items FORCE ROW LEVEL SECURITY;

CREATE POLICY content_calendar_items_isolation ON content_calendar_items
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE content_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_drafts FORCE ROW LEVEL SECURITY;

CREATE POLICY content_drafts_isolation ON content_drafts
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS content_drafts_isolation ON content_drafts;
ALTER TABLE content_drafts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE content_drafts DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS content_calendar_items_isolation ON content_calendar_items;
ALTER TABLE content_calendar_items NO FORCE ROW LEVEL SECURITY;
ALTER TABLE content_calendar_items DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS content_calendars_isolation ON content_calendars;
ALTER TABLE content_calendars NO FORCE ROW LEVEL SECURITY;
ALTER TABLE content_calendars DISABLE ROW LEVEL SECURITY;
