-- Up Migration
--
-- Same tenant-isolation pattern as every other "_enable_rls_" migration
-- (e.g. 277_enable_rls_channel_execution.sql, 287_enable_rls_integration_webhook_events.sql),
-- applied to 317_create_postiz_organization_links.sql and
-- 318_create_postiz_social_posts.sql.
ALTER TABLE postiz_organization_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE postiz_organization_links FORCE ROW LEVEL SECURITY;

CREATE POLICY postiz_organization_links_isolation ON postiz_organization_links
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE postiz_social_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE postiz_social_posts FORCE ROW LEVEL SECURITY;

CREATE POLICY postiz_social_posts_isolation ON postiz_social_posts
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS postiz_social_posts_isolation ON postiz_social_posts;
ALTER TABLE postiz_social_posts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE postiz_social_posts DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS postiz_organization_links_isolation ON postiz_organization_links;
ALTER TABLE postiz_organization_links NO FORCE ROW LEVEL SECURITY;
ALTER TABLE postiz_organization_links DISABLE ROW LEVEL SECURITY;
