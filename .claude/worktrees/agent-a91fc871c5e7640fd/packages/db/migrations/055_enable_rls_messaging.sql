-- Up Migration
--
-- Same tenant-isolation pattern as 013_enable_rls_policies.sql /
-- 017_enable_rls_leads.sql / 022_enable_rls_campaigns.sql /
-- 034_enable_rls_scoring.sql, applied to the two tables added in
-- 052_create_message_drafts.sql and 053_create_message_draft_variants.sql.

ALTER TABLE message_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_drafts FORCE ROW LEVEL SECURITY;

CREATE POLICY message_drafts_isolation ON message_drafts
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE message_draft_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_draft_variants FORCE ROW LEVEL SECURITY;

CREATE POLICY message_draft_variants_isolation ON message_draft_variants
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS message_draft_variants_isolation ON message_draft_variants;
ALTER TABLE message_draft_variants NO FORCE ROW LEVEL SECURITY;
ALTER TABLE message_draft_variants DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS message_drafts_isolation ON message_drafts;
ALTER TABLE message_drafts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE message_drafts DISABLE ROW LEVEL SECURITY;
