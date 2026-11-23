-- Up Migration
--
-- Milestone 2 (P1): a real browsing session, one row per (tenant, project,
-- client-generated session id). The session-timeout scheme (30 min
-- inactivity, see packages/embed-widget/analytics.js) lives entirely
-- client-side; this table just stores what the client reports plus a
-- server-computed `is_bot` flag (see this migration's note on bot
-- filtering, and apps/api/src/lib/botDetection.ts).
--
-- `visitor_id`/`session_id` are the same client-generated opaque text
-- tokens as site_visitors.visitor_id (deliberately NOT a composite FK down
-- to site_visitors — see that table's doc comment; indexed instead for
-- cheap joins/filters).
--
-- UTM/referrer/landing_url are captured once, at session start, mirroring
-- (not duplicating) the shape `leads.utm_source`/etc. already use — see
-- apps/api/src/lib/leadIngestion.ts's `custom_fields`/UTM columns. This is
-- the GENERAL-PURPOSE session-level counterpart; a lead's own UTM columns
-- stay as the "what this specific lead reported" record, while this table
-- is "what every visitor's session reported," correlated back to a lead via
-- `leads.visitor_id`/`leads.session_id` (see 505_add_visitor_session_to_leads.sql).
--
-- is_bot: a simple, deterministic User-Agent pattern match (documented as
-- necessarily incomplete — see apps/api/src/lib/botDetection.ts). Bot
-- sessions are stored for transparency but excluded from the real traffic
-- aggregates in apps/api/src/lib/siteAnalytics.ts.
CREATE TABLE site_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id   uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  visitor_id   text NOT NULL,
  session_id   text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz,
  referrer     text,
  landing_url  text,
  utm_source   text,
  utm_medium   text,
  utm_campaign text,
  utm_term     text,
  utm_content  text,
  user_agent   text,
  is_bot       boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, project_id, session_id)
);

CREATE INDEX idx_site_sessions_tenant_project ON site_sessions (tenant_id, project_id);
CREATE INDEX idx_site_sessions_visitor ON site_sessions (tenant_id, project_id, visitor_id);
CREATE INDEX idx_site_sessions_started_at ON site_sessions (tenant_id, project_id, started_at);
CREATE INDEX idx_site_sessions_is_bot ON site_sessions (tenant_id, project_id, is_bot);

-- Down Migration

DROP TABLE IF EXISTS site_sessions;
