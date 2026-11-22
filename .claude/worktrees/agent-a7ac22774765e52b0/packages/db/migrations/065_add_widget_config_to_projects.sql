-- Up Migration
--
-- Roadmap item 6 ("Inbound lead capture"): per-project widget config so a
-- tenant admin can set the embeddable widget's one qualifying question, its
-- post-submit booking link, and its thank-you copy, without any code
-- change. All nullable:
--   - widget_qualifying_question IS NULL  -> widget shows no qualifying
--     question (today's exact behavior).
--   - widget_booking_link_url IS NULL     -> no booking link shown, just a
--     generic thank-you.
--   - widget_thank_you_message IS NULL    -> apps/api and the widget fall
--     back to a sane default copy.
-- Read by the public, origin-checked
-- GET /api/v1/public/projects/:projectPublicKey/config endpoint (see
-- apps/api/src/routes/publicLeads.ts) and written via the existing tenant
-- PATCH /api/v1/tenants/:tenantId/projects/:projectId endpoint (see
-- apps/api/src/routes/projects.ts). No new RLS policy is needed: these are
-- just new columns on `projects`, already covered by the tenant-isolation
-- + public-lookup-by-key policy from 019_public_project_lookup_rls.sql.
ALTER TABLE projects
  ADD COLUMN widget_qualifying_question text,
  ADD COLUMN widget_booking_link_url text,
  ADD COLUMN widget_thank_you_message text;

-- Down Migration

ALTER TABLE projects
  DROP COLUMN IF EXISTS widget_thank_you_message,
  DROP COLUMN IF EXISTS widget_booking_link_url,
  DROP COLUMN IF EXISTS widget_qualifying_question;
