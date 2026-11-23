-- Up Migration
--
-- Closes the real remaining gap in Milestone 3's custom-domain work: DNS
-- ownership verification (customDomainVerification.ts) and ACME
-- challenge-planning (acmeClient.ts) were both real, but NOTHING resolved
-- an incoming request's `Host:` header to the right tenant/landing page —
-- 512_add_custom_domain_publish_status_to_landing_pages.sql's own comment
-- flagged this as not built. This migration adds the RLS carve-out that
-- apps/api/src/routes/publicLandingPages.ts's new host-based routes need,
-- mirroring 019_public_project_lookup_rls.sql's exact shape for
-- `projects.public_api_key`: a narrowly-scoped session variable
-- (`app.lookup_custom_domain`) lets an unauthenticated caller look up
-- EXACTLY ONE landing_pages row by its verified custom_domain, and only
-- when verification_status = 'verified' AND status = 'published' — it can
-- never be used to browse/enumerate other tenants' pages, and grants no
-- write access (WITH CHECK is unchanged).
--
-- Also adds a partial unique index on custom_domain so two tenants can
-- never both resolve as "the" live page for the same domain once serving
-- actually depends on this column for routing (a second tenant setting the
-- same custom_domain can still save it, but can never reach
-- verification_status = 'verified' for it while another tenant already
-- holds that unique slot — enforced at verification time by the route,
-- this index is the hard backstop).
CREATE UNIQUE INDEX idx_landing_pages_custom_domain_verified
  ON landing_pages (custom_domain)
  WHERE verification_status = 'verified' AND custom_domain IS NOT NULL;

DROP POLICY IF EXISTS landing_pages_isolation ON landing_pages;

CREATE POLICY landing_pages_isolation ON landing_pages
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    OR (
      status = 'published'
      AND verification_status = 'verified'
      AND custom_domain IS NOT NULL
      AND custom_domain = current_setting('app.lookup_custom_domain', true)
    )
  )
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS landing_pages_isolation ON landing_pages;

CREATE POLICY landing_pages_isolation ON landing_pages
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

DROP INDEX IF EXISTS idx_landing_pages_custom_domain_verified;
