-- Up Migration
--
-- Subscription PLAN DATA MODEL (not real payment processing — there is no
-- Stripe/payment-provider integration anywhere in this codebase; see
-- apps/api/src/routes/planUsage.ts for the manual/admin-only plan-change
-- endpoint this column backs).
--
-- 014_seed_dev_tenant.sql seeded the dev tenant's `settings` jsonb with
-- '{"plan": "growth", "example": true}' as placeholder/example data. That
-- was never a real typed field — just unstructured jsonb — so this
-- promotes it to a real, constrained column and backfills any tenant that
-- already carries that example key.

ALTER TABLE tenants
  ADD COLUMN plan text NOT NULL DEFAULT 'free'
    CHECK (plan IN ('free', 'starter', 'growth', 'enterprise'));

-- Backfill from the example seed data in settings, where present and
-- valid, instead of silently defaulting every existing tenant to 'free'.
UPDATE tenants
SET plan = settings->>'plan'
WHERE settings ? 'plan'
  AND settings->>'plan' IN ('free', 'starter', 'growth', 'enterprise');

-- The new column is now the single source of truth for plan; drop the
-- redundant key from settings so the two representations can't drift.
UPDATE tenants
SET settings = settings - 'plan'
WHERE settings ? 'plan';

CREATE INDEX idx_tenants_plan ON tenants (plan);

-- Down Migration

DROP INDEX IF EXISTS idx_tenants_plan;
ALTER TABLE tenants DROP COLUMN IF EXISTS plan;
