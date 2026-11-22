-- Up Migration
--
-- Individual issues found by a seo_audits run (076_create_seo_audits.sql):
-- broken links, missing/too-long titles and meta descriptions, missing
-- sitemap/robots.txt. Each row is a real, independently-checkable finding
-- (see apps/api/src/lib/siteAudit.ts) — never a fabricated/placeholder
-- issue.

CREATE TABLE seo_audit_issues (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  audit_id    uuid NOT NULL REFERENCES seo_audits (id) ON DELETE CASCADE,
  issue_type  text NOT NULL CHECK (issue_type IN (
                'broken_link',
                'missing_title',
                'missing_meta_description',
                'title_too_long',
                'meta_description_too_long',
                'missing_sitemap',
                'missing_robots'
              )),
  url         text NOT NULL,
  detail      text NOT NULL,
  severity    text NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_seo_audit_issues_tenant_id ON seo_audit_issues (tenant_id);
CREATE INDEX idx_seo_audit_issues_audit_id ON seo_audit_issues (audit_id);
CREATE INDEX idx_seo_audit_issues_audit_id_severity ON seo_audit_issues (audit_id, severity);

-- Down Migration

DROP TABLE IF EXISTS seo_audit_issues;
