-- Up Migration
--
-- Roadmap item 6 ("Inbound lead capture"): widget UTM + source tracking,
-- plus the one qualifying question answer, captured per lead so a tenant
-- can tell which campaign/channel a lead actually came from. All columns
-- are nullable: existing rows (and every non-widget ingestion path, e.g.
-- 'internal'/'agent'/'import' sources in leads.source) are unaffected and
-- simply leave these null. Populated by apps/api/src/lib/leadIngestion.ts
-- (shared ingestion path) from fields submitted by
-- packages/embed-widget/embed.js.
ALTER TABLE leads
  ADD COLUMN utm_source text,
  ADD COLUMN utm_medium text,
  ADD COLUMN utm_campaign text,
  ADD COLUMN utm_term text,
  ADD COLUMN utm_content text,
  ADD COLUMN referrer_url text,
  ADD COLUMN qualifying_answer text;

-- Down Migration

ALTER TABLE leads
  DROP COLUMN IF EXISTS qualifying_answer,
  DROP COLUMN IF EXISTS referrer_url,
  DROP COLUMN IF EXISTS utm_content,
  DROP COLUMN IF EXISTS utm_term,
  DROP COLUMN IF EXISTS utm_campaign,
  DROP COLUMN IF EXISTS utm_medium,
  DROP COLUMN IF EXISTS utm_source;
