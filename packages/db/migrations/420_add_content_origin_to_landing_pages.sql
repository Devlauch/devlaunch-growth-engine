-- Up Migration
--
-- Purely additive: two nullable, mutually-exclusive FK columns on the
-- existing `landing_pages` table so a landing page can be explicitly
-- tagged, at creation time, as having been built FROM a specific piece of
-- content (apps/api/src/lib/contentAttribution.ts, GET /content-attribution).
--
-- Before this column existed there was NO real shared identifier between
-- content_calendar_items/content_drafts (071/072/073_create_content_*.sql)
-- and landing_pages/landing_page_events/leads at all — confirmed by a prior
-- audit before this task was created. leads.custom_fields->>'landingPageId'
-- (set by apps/api/src/routes/publicLandingPages.ts's ingestLead() call) IS
-- a real, already-existing link from a lead back to the landing page it
-- came from, so the only missing link in the chain
-- content item -> landing page -> lead was content item -> landing page.
-- This column closes exactly that gap, additively, without inventing any
-- new tracking mechanism beyond "a human/agent picks which content item a
-- landing page was built from when they create it."
--
-- Deliberately placed on `landing_pages` (one row per page) rather than on
-- `landing_page_events` (one row per page_view/form_submit/download): the
-- "built from this content" relationship belongs to the page itself, not to
-- any individual visit/submission event, and putting it on landing_pages
-- means every event/lead for that page is attributable without having to
-- stamp the content id onto every single event row.
--
-- The CHECK keeps the tagging unambiguous (a page points at at most one
-- origin content item) without forcing a choice — both NULL is the default,
-- honest "not tagged" state for every existing row and for any new page a
-- user doesn't explicitly tag.
ALTER TABLE landing_pages
  ADD COLUMN IF NOT EXISTS content_calendar_item_id uuid REFERENCES content_calendar_items (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS content_draft_id uuid REFERENCES content_drafts (id) ON DELETE SET NULL;

ALTER TABLE landing_pages
  ADD CONSTRAINT landing_pages_single_content_origin
  CHECK (content_calendar_item_id IS NULL OR content_draft_id IS NULL);

CREATE INDEX IF NOT EXISTS idx_landing_pages_content_calendar_item_id ON landing_pages (content_calendar_item_id);
CREATE INDEX IF NOT EXISTS idx_landing_pages_content_draft_id ON landing_pages (content_draft_id);

-- Down Migration

DROP INDEX IF EXISTS idx_landing_pages_content_draft_id;
DROP INDEX IF EXISTS idx_landing_pages_content_calendar_item_id;

ALTER TABLE landing_pages
  DROP CONSTRAINT IF EXISTS landing_pages_single_content_origin;

ALTER TABLE landing_pages
  DROP COLUMN IF EXISTS content_draft_id,
  DROP COLUMN IF EXISTS content_calendar_item_id;
