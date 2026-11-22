-- Up Migration
--
-- Phase 2 item 3 ("Technical SEO Agent"): one row per website technical
-- audit run for a project's domain. Broken-link/metadata/sitemap checks
-- (sitemap_found, robots_found, pages_checked, broken_links_count,
-- missing_meta_count) are fully real, zero-external-account checks (see
-- apps/api/src/lib/siteAudit.ts). core_web_vitals is the genuinely
-- real, but optionally-configured, Google PageSpeed Insights result (see
-- apps/api/src/lib/coreWebVitals.ts) — null and
-- core_web_vitals_status = 'not_configured' whenever no
-- GOOGLE_PAGESPEED_API_KEY is set in this environment, same
-- graceful-degradation convention as sending_domains' spf/dkim/dmarc
-- status columns (060_create_sending_domains.sql).

CREATE TABLE seo_audits (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id              uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  domain                  text NOT NULL,
  audited_at              timestamptz NOT NULL DEFAULT now(),
  sitemap_found           boolean NOT NULL,
  robots_found            boolean NOT NULL,
  pages_checked           integer NOT NULL DEFAULT 0,
  broken_links_count      integer NOT NULL DEFAULT 0,
  missing_meta_count      integer NOT NULL DEFAULT 0,
  core_web_vitals         jsonb,
  core_web_vitals_status  text NOT NULL DEFAULT 'not_configured'
                          CHECK (core_web_vitals_status IN ('ok', 'not_configured', 'error')),
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_seo_audits_tenant_id ON seo_audits (tenant_id);
CREATE INDEX idx_seo_audits_project_id ON seo_audits (project_id);
CREATE INDEX idx_seo_audits_project_id_audited_at ON seo_audits (project_id, audited_at DESC);

-- Down Migration

DROP TABLE IF EXISTS seo_audits;
