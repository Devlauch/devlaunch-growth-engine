-- Up Migration
--
-- DevLaunch's own internal customer-acquisition workspace.
--
-- Modeling decision (documented per task instructions): rather than add an
-- `is_internal`/`internal_tenant` boolean/enum column to `tenants` (a
-- structural change to a table every other tenant-owned table FKs into,
-- and one actively being touched by concurrent sessions per
-- docs/FEATURE_STATUS.md), this creates ONE real `tenants` row + ONE real
-- `projects` row under it, at fixed, well-known ids, and a designated env
-- var (DEVLAUNCH_INTERNAL_TENANT_ID / DEVLAUNCH_INTERNAL_PROJECT_ID — see
-- apps/api/src/config/env.ts, defaulted to these ids) is what the app code
-- (apps/api/src/lib/internalGrowthWorkspace.ts) treats as "the internal
-- workspace". This is the least-structural-change option that still keeps
-- this tenant fully, identically RLS-isolated — it is a ROW, not a
-- special-cased code path in the isolation mechanism itself. No RLS
-- policy, no query anywhere, treats this tenant_id any differently from a
-- client tenant's; the only thing that differs is which routes are
-- authorized to operate on it (see routes/internalGrowth.ts's tenant-id
-- guard) and which public, unauthenticated routes are allowed to write
-- into it at all (see routes/publicGrowth.ts).
--
-- This is NOT the same as the pre-existing dev-seed tenant from
-- 014_seed_dev_tenant.sql (id 00000000-0000-0000-0000-000000000001, slug
-- 'devlaunch') — that row is explicitly synthetic/example data for local
-- development ("DevPilot Academy", fake ICPs) and must never be conflated
-- with DevLaunch's real own acquisition workspace. This is a second,
-- distinct, real-for-real tenant row: DevLaunch-the-company acquiring its
-- own real customers through its own real product.
--
-- Same FORCE ROW LEVEL SECURITY tx-local set_config pattern as
-- 014_seed_dev_tenant.sql for the insert itself.

DO $$
DECLARE
  v_tenant_id   uuid := 'd3f6a1b0-0000-4000-8000-000000000001';
  v_project_id  uuid := 'd3f6a1b0-0000-4000-8000-000000000002';
BEGIN
  PERFORM set_config('app.current_tenant_id', v_tenant_id::text, true);

  INSERT INTO tenants (id, slug, name, industry, status, settings)
  VALUES (
    v_tenant_id,
    'devlaunch-growth-internal',
    'DevLaunch (Internal Growth Workspace)',
    'b2b_saas',
    'active',
    '{"internal_workspace": true}'::jsonb
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO projects (id, tenant_id, name, slug, description, status)
  VALUES (
    v_project_id,
    v_tenant_id,
    'Customer Acquisition',
    'customer-acquisition',
    'DevLaunch''s own real customer-acquisition workspace: public growth-audit/demo-request capture, trial tracking, CAC.',
    'active'
  )
  ON CONFLICT (id) DO NOTHING;
END $$;

-- Down Migration

DELETE FROM projects WHERE id = 'd3f6a1b0-0000-4000-8000-000000000002';
DELETE FROM tenants WHERE id = 'd3f6a1b0-0000-4000-8000-000000000001';
