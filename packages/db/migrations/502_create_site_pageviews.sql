-- Up Migration
--
-- Milestone 2 (P1): one real row per pageview beacon sent by
-- packages/embed-widget/analytics.js. `session_id` is the client-generated
-- opaque text token from site_sessions.session_id (see that table's doc
-- comment for why there's no composite FK). tenant_id/project_id are
-- denormalized here for RLS and cheap rollups, same convention as
-- landing_page_events denormalizing tenant_id/project_id from
-- landing_pages (266_create_landing_page_events.sql).
--
-- Relationship to landing_page_events: landing_page_events' own
-- `page_view` event type stays exactly as-is (a tenant's landing-page
-- stats/A-B-test math keeps reading it, unchanged) — this table is the
-- GENERAL-PURPOSE version, covering every page on a tracked site, not just
-- published landing pages. They are not merged into one table because
-- landing_page_events is keyed to a specific `landing_page_id` row and
-- feeds the existing experiment_results A/B pipeline; site_pageviews has no
-- such FK and is organized around (tenant, project, session) instead. A
-- landing page that also carries the general analytics.js snippet
-- naturally gets rows in both tables for the same visit — that's expected,
-- not double-counting of the SAME metric, since each table answers a
-- different question (site-wide traffic vs. this-page's conversion funnel).
CREATE TABLE site_pageviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id  uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  session_id  text NOT NULL,
  url         text NOT NULL,
  path        text NOT NULL,
  viewed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_site_pageviews_tenant_project ON site_pageviews (tenant_id, project_id);
CREATE INDEX idx_site_pageviews_session ON site_pageviews (tenant_id, project_id, session_id);
CREATE INDEX idx_site_pageviews_viewed_at ON site_pageviews (tenant_id, project_id, viewed_at);
CREATE INDEX idx_site_pageviews_path ON site_pageviews (tenant_id, project_id, path);

-- Down Migration

DROP TABLE IF EXISTS site_pageviews;
