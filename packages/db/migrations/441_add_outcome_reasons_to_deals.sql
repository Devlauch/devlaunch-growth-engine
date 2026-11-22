-- Up Migration
--
-- Ported from the isolated milestone3-phase2 branch's
-- 292_add_outcome_reasons_to_deals.sql (renumbered here — 292 was never
-- applied to any shared/production database, it only ever existed in that
-- worktree). `deals.stage` already captures WHICH terminal state a deal
-- reached ('won'/'lost', 278_create_deals.sql), but nothing on master's
-- `deals` table captures WHY. Confirmed via a fresh grep of
-- packages/db/migrations for anything touching the `deals` table
-- (278_create_deals.sql, 283_enable_rls_sales_conversion.sql) that master
-- never added equivalent columns under a different name — this is a
-- genuine gap, not a rename problem. Additive, nullable text columns (no
-- new table — 1:1 facts about a single deal), same pattern as
-- icp_profiles' own additive columns in 284_add_icp_campaign_fields.sql.
ALTER TABLE deals
  ADD COLUMN lost_reason text,
  ADD COLUMN won_reason  text;

-- Down Migration

ALTER TABLE deals
  DROP COLUMN IF EXISTS lost_reason,
  DROP COLUMN IF EXISTS won_reason;
