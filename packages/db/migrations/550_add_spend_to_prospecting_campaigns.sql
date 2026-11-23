-- Up Migration
--
-- Purely additive: one nullable column on the existing `prospecting_campaigns`
-- table (323_create_prospecting_campaigns.sql) so Phase 7 Revenue
-- Intelligence (apps/api/src/lib/revenueIntelligence.ts) can compute a real
-- per-campaign customer-acquisition-cost (campaign spend / customers won)
-- for DISCOVERY campaigns, exactly the same honest pattern
-- 282_add_campaign_spend_to_campaigns.sql already established for outbound
-- `campaigns`. There is no real ad-billing/spend-tracking integration
-- anywhere in this codebase (see apps/api/src/routes/integrations.ts's
-- not-connected registry) — `spend` is a manually-entered figure a tenant
-- records themselves (e.g. a discovery vendor/tooling cost for that
-- campaign's run), never fetched from a real provider.
--
-- NULL (the default for every existing row) means "no spend recorded for
-- this prospecting campaign", which revenueIntelligence.ts must treat as
-- missing data (CAC/ROI reported as "insufficient_data"), never as zero
-- spend. This mirrors the acquisition_costs table's own honesty convention
-- (425_create_acquisition_costs.sql) without duplicating that internal-
-- workspace-only table for client tenants — a single nullable numeric
-- column is all a per-campaign manual entry needs here, same as
-- `campaigns.spend`.
ALTER TABLE prospecting_campaigns
  ADD COLUMN IF NOT EXISTS spend numeric(12, 2);

-- Down Migration

ALTER TABLE prospecting_campaigns
  DROP COLUMN IF EXISTS spend;
