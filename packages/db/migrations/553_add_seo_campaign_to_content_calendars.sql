-- Up Migration
--
-- Purely additive: tags an existing content_calendars row
-- (071_create_content_calendars.sql) against a seo_campaigns row
-- (551_create_seo_campaigns.sql), so a campaign's real content-publishing
-- progress can be computed by joining content_calendar_items through this
-- column — no second, parallel "campaign content" table.
ALTER TABLE content_calendars
  ADD COLUMN IF NOT EXISTS seo_campaign_id uuid REFERENCES seo_campaigns (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_content_calendars_seo_campaign_id ON content_calendars (seo_campaign_id);

-- Down Migration

DROP INDEX IF EXISTS idx_content_calendars_seo_campaign_id;
ALTER TABLE content_calendars
  DROP COLUMN IF EXISTS seo_campaign_id;
