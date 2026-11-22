-- Up Migration
--
-- Same tenant-isolation pattern as 013_enable_rls_policies.sql /
-- 099_enable_rls_competitors.sql, applied to the four tables added in
-- 263-266 for the "AI Landing Page & Lead Magnet Builder" feature.
--
-- No special public-lookup carve-out is needed here (unlike
-- 019_public_project_lookup_rls.sql for `projects`): the public routes in
-- apps/api/src/routes/publicLandingPages.ts first resolve+verify the
-- project via its existing public_api_key/allowed_origins lookup (which
-- already has that carve-out on `projects`), THEN set
-- app.current_tenant_id to that project's real tenant_id before querying
-- landing_pages/lead_magnets/landing_page_events — so the plain
-- tenant-isolation policy below is sufficient for every caller, public or
-- authenticated.
ALTER TABLE landing_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE landing_pages FORCE ROW LEVEL SECURITY;

CREATE POLICY landing_pages_isolation ON landing_pages
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE landing_page_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE landing_page_variants FORCE ROW LEVEL SECURITY;

CREATE POLICY landing_page_variants_isolation ON landing_page_variants
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE lead_magnets ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_magnets FORCE ROW LEVEL SECURITY;

CREATE POLICY lead_magnets_isolation ON lead_magnets
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE landing_page_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE landing_page_events FORCE ROW LEVEL SECURITY;

CREATE POLICY landing_page_events_isolation ON landing_page_events
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS landing_page_events_isolation ON landing_page_events;
ALTER TABLE landing_page_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE landing_page_events DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_magnets_isolation ON lead_magnets;
ALTER TABLE lead_magnets NO FORCE ROW LEVEL SECURITY;
ALTER TABLE lead_magnets DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS landing_page_variants_isolation ON landing_page_variants;
ALTER TABLE landing_page_variants NO FORCE ROW LEVEL SECURITY;
ALTER TABLE landing_page_variants DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS landing_pages_isolation ON landing_pages;
ALTER TABLE landing_pages NO FORCE ROW LEVEL SECURITY;
ALTER TABLE landing_pages DISABLE ROW LEVEL SECURITY;
