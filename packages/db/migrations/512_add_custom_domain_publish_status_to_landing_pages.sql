-- Up Migration
--
-- Milestone 3 — extends the landing-page status model (additively) so a
-- page can be tracked as ready to serve on its custom domain, separate
-- from the existing `status` column (draft/published, which governs the
-- headless JSON API — see routes/landingPages.ts). This is a DATA-MODEL /
-- status-tracking column only: this codebase has NO in-repo HTML renderer
-- for landing pages at all (confirmed in docs/BROADER_WORKSTREAM_AUDIT.md
-- section 6 — "headless/API-only feature by design"), so
-- 'live' here means "this platform's own data says this domain is DNS-
-- verified and (once real SSL exists) certificate-issued" — it does NOT
-- mean a visitor can actually load the page at that domain today, because
-- nothing in this repository serves one. Whoever eventually builds that
-- renderer/CDN layer is the actual consumer of this column.
--
-- Lifecycle (route layer's responsibility to advance, never auto-advanced
-- by a trigger): 'not_ready' -> 'dns_verified' (once
-- landing_pages.verification_status = 'verified') -> 'ssl_issued' (once a
-- real cert exists — blocked in this environment, see
-- apps/api/src/lib/acmeClient.ts's doc comment) -> 'live' (once a
-- CDN/renderer actually serves it — also not built here).
ALTER TABLE landing_pages
  ADD COLUMN custom_domain_publish_status text NOT NULL DEFAULT 'not_ready'
    CHECK (custom_domain_publish_status IN ('not_ready', 'dns_verified', 'ssl_issued', 'live'));

-- Down Migration

ALTER TABLE landing_pages
  DROP COLUMN IF EXISTS custom_domain_publish_status;
