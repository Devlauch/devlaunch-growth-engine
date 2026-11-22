-- Up Migration
--
-- content_calendars is Phase 2 item 2 ("Content Strategy Agent"): a
-- generated 30-day content calendar for a project, optionally targeted at
-- one ICP profile (packages/db/migrations/007_create_icp_profiles.sql).
-- The calendar row itself is just the header (name/start date/ICP); the
-- generated posts/blogs/emails live in content_calendar_items
-- (072_create_content_calendar_items.sql), one row per generated piece.
CREATE TABLE content_calendars (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name            text NOT NULL,
  start_date      date NOT NULL,
  icp_profile_id  uuid REFERENCES icp_profiles (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_content_calendars_set_updated_at
  BEFORE UPDATE ON content_calendars
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_content_calendars_tenant_id ON content_calendars (tenant_id);
CREATE INDEX idx_content_calendars_project_id ON content_calendars (project_id);

-- Down Migration

DROP TABLE IF EXISTS content_calendars;
