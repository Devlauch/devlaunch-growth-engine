-- Up Migration
--
-- content_calendar_items: one generated piece of content (LinkedIn post,
-- blog, or email) within a content_calendars row
-- (071_create_content_calendars.sql). day_offset is 0-29, matching the
-- 30-day calendar window; content_type/title/body are produced by
-- apps/api/src/lib/contentGeneration.ts's generateContentCalendar(), which
-- is real deterministic templating grounded in the project's brand-voice
-- profile and ICP pain points (see that file's doc comment) — never
-- LLM-generated or placeholder text. status lets a human mark a piece
-- reviewed ('approved') before it's used, mirroring the draft/approved
-- life cycle used elsewhere in this codebase (e.g. message_drafts) but
-- intentionally simpler here since content pieces don't need the full
-- approvals-table workflow.
CREATE TABLE content_calendar_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  calendar_id   uuid NOT NULL REFERENCES content_calendars (id) ON DELETE CASCADE,
  day_offset    integer NOT NULL CHECK (day_offset >= 0 AND day_offset < 30),
  content_type  text NOT NULL CHECK (content_type IN ('linkedin_post', 'blog', 'email')),
  title         text NOT NULL,
  body          text NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_content_calendar_items_set_updated_at
  BEFORE UPDATE ON content_calendar_items
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_content_calendar_items_tenant_id ON content_calendar_items (tenant_id);
CREATE INDEX idx_content_calendar_items_calendar_id ON content_calendar_items (calendar_id);
CREATE INDEX idx_content_calendar_items_calendar_day ON content_calendar_items (calendar_id, day_offset);

-- Down Migration

DROP TABLE IF EXISTS content_calendar_items;
