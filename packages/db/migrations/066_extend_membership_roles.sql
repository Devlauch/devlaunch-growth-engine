-- Up Migration
--
-- The product spec's real role set is: owner, admin, marketer, sales,
-- analyst, viewer. The original CHECK constraint from
-- 004_create_memberships.sql only allowed ('owner', 'admin', 'member',
-- 'viewer') — 'member' was a generic placeholder, not a spec role, and
-- route logic never actually differentiated any of these beyond
-- owner/admin in a couple of places (see apps/api/src/routes/memberships.ts).
--
-- This migration widens the constraint to add 'marketer', 'sales',
-- 'analyst' so real role-based access control can be enforced
-- (apps/api/src/middleware/rbac.ts). 'member' is intentionally LEFT in the
-- allowed set (not dropped/renamed) because it is the column's existing
-- DEFAULT and already-seeded/pre-existing rows use it (see
-- 014_seed_dev_tenant.sql and any membership created before this change);
-- dropping it would require a backfill/data migration of existing rows,
-- which is out of scope here. New memberships should be created with one
-- of the real spec roles; 'member' is treated as equivalent to 'viewer'
-- (read-only) by the RBAC middleware.

ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;

ALTER TABLE memberships
  ADD CONSTRAINT memberships_role_check
  CHECK (role IN ('owner', 'admin', 'marketer', 'sales', 'analyst', 'member', 'viewer'));

-- Down Migration

ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;

ALTER TABLE memberships
  ADD CONSTRAINT memberships_role_check
  CHECK (role IN ('owner', 'admin', 'member', 'viewer'));
