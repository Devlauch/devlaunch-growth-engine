-- Up Migration
--
-- Purely additive: one nullable column on the existing `campaigns` table so
-- Growth/Revenue analytics (apps/api/src/lib/growthRevenueAnalytics.ts) can
-- compute a real customer-acquisition-cost (campaign spend / customers won)
-- instead of fabricating one. There is no real ad-billing/spend-tracking
-- integration anywhere in this codebase (see apps/api/src/routes/
-- integrations.ts's not-connected registry) — `spend` is a manually-entered
-- figure a tenant records themselves, exactly like integrations.ts's
-- placeholderLabel is manually entered rather than fetched from a real
-- provider. NULL (the default for every existing row) means "no spend
-- recorded for this campaign", which growthRevenueAnalytics.ts must treat
-- as missing data (CAC reported as `not_available`), never as zero spend.
--
-- Deliberately does NOT touch apps/api/src/routes/campaigns.ts itself
-- (that file is mid-edit by a parallel session) — this column is read
-- directly by growthRevenueAnalytics.ts's own queries.
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS spend numeric(12, 2);

-- Down Migration

ALTER TABLE campaigns
  DROP COLUMN IF EXISTS spend;
