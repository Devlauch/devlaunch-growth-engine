-- Up Migration
--
-- The original memberships_isolation policy (013_enable_rls_policies.sql)
-- only ever lets a connection see membership rows for the single tenant
-- currently set in app.current_tenant_id. That's correct for every
-- tenant-scoped request, but it makes one legitimate, narrow query
-- impossible under RLS: "list the tenants *I* (the authenticated user)
-- belong to" (used by GET /api/v1/auth/me and GET /api/v1/tenants), which
-- by definition needs to see membership rows across more than one tenant.
--
-- This migration extends the policy with an additional, equally narrow
-- OR-branch: a row is also visible if its user_id matches a second,
-- separately-set session variable, app.current_user_id. The API sets this
-- (via withUserContext in apps/api/src/db/pool.ts) ONLY for a request's own
-- authenticated user id — never a client-supplied value for "which user to
-- look up" — so this can only ever be used to look up one's own
-- memberships, never anyone else's, and never to bypass the existing
-- tenant_id check for rows belonging to a *different* user.
ALTER TABLE memberships DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memberships_isolation ON memberships;

CREATE POLICY memberships_isolation ON memberships
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    OR user_id = current_setting('app.current_user_id', true)::uuid
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
  );

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;

-- tenants needs the matching extension: GET /api/v1/auth/me and
-- GET /api/v1/tenants join memberships -> tenants to show tenant
-- name/slug, so a tenant row the user has a membership in (found via the
-- OR-branch above, which is itself restricted to the caller's own
-- app.current_user_id) must also be visible, even with no
-- app.current_tenant_id set yet.
ALTER TABLE tenants DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_isolation ON tenants;

CREATE POLICY tenants_isolation ON tenants
  USING (
    id = current_setting('app.current_tenant_id', true)::uuid
    OR id IN (
      SELECT tenant_id FROM memberships
      WHERE user_id = current_setting('app.current_user_id', true)::uuid
    )
  )
  WITH CHECK (id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

-- Down Migration

ALTER TABLE memberships DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memberships_isolation ON memberships;

CREATE POLICY memberships_isolation ON memberships
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;

ALTER TABLE tenants DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_isolation ON tenants;

CREATE POLICY tenants_isolation ON tenants
  USING (id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
