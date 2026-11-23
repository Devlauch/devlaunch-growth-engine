-- Up Migration
--
-- Milestone 2 (P1): real custom client-side events (e.g. `form_submitted`,
-- or anything else a page fires via `window.devlaunchAnalytics.track(name,
-- props)` — see packages/embed-widget/analytics.js). `properties` is an
-- open jsonb bag, the same "optional, conservatively size-capped, never
-- parsed beyond JSON-validity" trust posture as `leads.custom_fields`
-- (apps/api/src/lib/leadIngestion.ts) — event names/props come from the
-- page embedding the snippet, not from an untrusted third party, but are
-- still never interpreted as anything but inert data server-side.
CREATE TABLE site_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id   uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  session_id   text NOT NULL,
  event_name   text NOT NULL,
  properties   jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_site_events_tenant_project ON site_events (tenant_id, project_id);
CREATE INDEX idx_site_events_session ON site_events (tenant_id, project_id, session_id);
CREATE INDEX idx_site_events_name ON site_events (tenant_id, project_id, event_name);
CREATE INDEX idx_site_events_occurred_at ON site_events (tenant_id, project_id, occurred_at);

-- Down Migration

DROP TABLE IF EXISTS site_events;
