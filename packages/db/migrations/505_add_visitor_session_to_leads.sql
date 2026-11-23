-- Up Migration
--
-- Milestone 2 (P1): the visitor-to-lead correlation link. Purely additive,
-- nullable columns on the existing `leads` table — the exact same shape
-- convention as its existing `utm_source`/`referrer_url` columns (plain,
-- optional, client-reported text; see apps/api/src/lib/leadIngestion.ts),
-- not a join table, because this is a single "which visitor/session, if
-- any, submitted this lead" pointer per lead, not a many-to-many
-- relationship — a lead is submitted once, by one session.
--
-- Deliberately NOT a foreign key to site_visitors/site_sessions: those
-- tables' keys are client-generated opaque text tokens (see
-- 500_create_site_visitors.sql's comment), and a lead can legitimately be
-- captured with a visitor/session id that the analytics beacon never
-- actually reached the server with yet (e.g. a race between the pageview
-- beacon and a fast form submit, or a visitor with analytics consent
-- withheld who still submits a lead form) — a hard FK would make an
-- ordering/consent edge case fail the entire lead insert, which must never
-- happen. The correlation is therefore "best effort, nullable, looked up at
-- query time" (see apps/api/src/lib/siteAnalytics.ts's lead-correlation
-- helper), not database-enforced referential integrity.
--
-- leadIngestion.ts's own INSERT is intentionally left untouched this round
-- (see this feature's handback notes on why) — these columns are populated
-- by an additive UPDATE in the public route layer (publicLeads.ts /
-- publicLandingPages.ts), in the same transaction as the lead insert.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS visitor_id text,
  ADD COLUMN IF NOT EXISTS session_id text;

CREATE INDEX IF NOT EXISTS idx_leads_visitor_id ON leads (tenant_id, project_id, visitor_id) WHERE visitor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_session_id ON leads (tenant_id, project_id, session_id) WHERE session_id IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_leads_session_id;
DROP INDEX IF EXISTS idx_leads_visitor_id;

ALTER TABLE leads
  DROP COLUMN IF EXISTS session_id,
  DROP COLUMN IF EXISTS visitor_id;
