-- Up Migration
--
-- Same tenant-isolation pattern as 267_enable_rls_landing_pages.sql,
-- applied to the four tables added in 500-503 for Milestone 2 (real
-- website analytics). No special public-lookup carve-out is needed here
-- either, for the identical reason 267's comment gives: the public route
-- (apps/api/src/routes/publicAnalytics.ts) first resolves+verifies the
-- project via its existing public_api_key/allowed_origins lookup (the
-- 019_public_project_lookup_rls.sql carve-out on `projects`), THEN sets
-- app.current_tenant_id to that project's real tenant_id before touching
-- any of these four tables — so the plain tenant-isolation policy below is
-- sufficient for every caller, public or authenticated.
ALTER TABLE site_visitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_visitors FORCE ROW LEVEL SECURITY;

CREATE POLICY site_visitors_isolation ON site_visitors
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE site_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY site_sessions_isolation ON site_sessions
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE site_pageviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_pageviews FORCE ROW LEVEL SECURITY;

CREATE POLICY site_pageviews_isolation ON site_pageviews
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE site_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_events FORCE ROW LEVEL SECURITY;

CREATE POLICY site_events_isolation ON site_events
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS site_events_isolation ON site_events;
ALTER TABLE site_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE site_events DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS site_pageviews_isolation ON site_pageviews;
ALTER TABLE site_pageviews NO FORCE ROW LEVEL SECURITY;
ALTER TABLE site_pageviews DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS site_sessions_isolation ON site_sessions;
ALTER TABLE site_sessions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE site_sessions DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS site_visitors_isolation ON site_visitors;
ALTER TABLE site_visitors NO FORCE ROW LEVEL SECURITY;
ALTER TABLE site_visitors DISABLE ROW LEVEL SECURITY;
