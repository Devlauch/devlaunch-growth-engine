-- Up Migration

-- Product rule: a user may CREATE/OWN at most one organization (tenant),
-- but may still be INVITED into any number of other organizations as a
-- non-owner member — this index only restricts role = 'owner'. See
-- docs/DECISIONS.md for the full rationale.
--
-- This is enforced primarily here, at the database level, so it holds even
-- under concurrent requests (two simultaneous "create organization" calls
-- from the same user can only ever result in one surviving owner
-- membership row — the second INSERT hits this unique index and fails
-- with Postgres error code 23505, which apps/api/src/routes/tenants.ts
-- catches and maps to a 409 response). The application-layer pre-check in
-- that same route exists only to fail fast with a clean error message
-- before a redundant INSERT is attempted; it is NOT the source of truth.
--
-- Existing data note (do not delete/alter any existing rows): if this
-- database already has a user who owns more than one active tenant
-- (possible from before this rule existed), creating the index below
-- would fail outright because Postgres can't build a unique index over
-- data that violates it. Rather than fail the migration or silently drop
-- someone's existing organization, the block below checks for that case
-- first and skips creating the index if any violation already exists,
-- leaving enforcement to the application-layer pre-check only for that
-- environment until the duplicate data is manually reconciled. A fresh/
-- clean database (true for this project's own dev database, verified
-- before writing this migration) gets the real DB-level guarantee.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM memberships
    WHERE role = 'owner' AND status = 'active'
    GROUP BY user_id
    HAVING count(*) > 1
  ) THEN
    RAISE NOTICE 'one-owned-tenant-per-user: skipping unique index — existing data already has a user owning more than one tenant. Enforcement falls back to the application-layer check in routes/tenants.ts until this is reconciled.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS memberships_one_owned_tenant_per_user
      ON memberships (user_id)
      WHERE role = 'owner' AND status = 'active';
  END IF;
END $$;

-- Down Migration

DROP INDEX IF EXISTS memberships_one_owned_tenant_per_user;
