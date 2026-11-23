-- Up Migration
--
-- Milestone 2 (P1): real first-party website analytics. `site_visitors` is
-- the anonymous-visitor side of the new tracking model — one row per
-- (tenant, project, client-generated visitor id), written by the new public
-- ingestion endpoint (apps/api/src/routes/publicAnalytics.ts) the first
-- time a given browser is ever seen, then upserted (last_seen_at bumped) on
-- every subsequent pageview/event.
--
-- `visitor_id` is a client-generated opaque token (random string persisted
-- in localStorage by packages/embed-widget/analytics.js), not a DB-assigned
-- id — same "trust the client only for an opaque correlation token, never
-- for anything else" posture as `leads.utm_source` etc. (see
-- apps/api/src/lib/leadIngestion.ts). No FK from site_sessions down to this
-- table's PK: a session row is written in the same request that upserts the
-- visitor row, so composite-FK plumbing would add ceremony without adding
-- real integrity (see 501_create_site_sessions.sql's own comment).
--
-- Deliberately minimal, per the task spec: no fingerprinting, no device/geo
-- enrichment, no cross-domain stitching. first_seen_at/last_seen_at are the
-- only two real timestamps this table needs.
CREATE TABLE site_visitors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id     uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  visitor_id     text NOT NULL,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_id, visitor_id)
);

CREATE INDEX idx_site_visitors_tenant_project ON site_visitors (tenant_id, project_id);

-- Down Migration

DROP TABLE IF EXISTS site_visitors;
