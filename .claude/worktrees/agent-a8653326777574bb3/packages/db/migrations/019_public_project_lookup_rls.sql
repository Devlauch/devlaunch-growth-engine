-- Up Migration
--
-- Lets the public lead-capture endpoint
-- (POST /api/v1/public/projects/:projectPublicKey/leads) resolve which
-- project/tenant a public_api_key belongs to WITHOUT already knowing (or
-- trusting a client-supplied) tenant_id — mirroring, for an unauthenticated
-- caller armed only with a per-project public key, the same "verify first,
-- then set tenant context" shape used everywhere else.
--
-- The API sets a THIRD, narrowly-scoped session variable,
-- app.lookup_public_api_key, to the exact key the caller presented (see
-- apps/api/src/routes/publicLeads.ts). This policy only ever reveals the
-- single project row whose public_api_key equals that exact value, and
-- only when public_widget_enabled is true — it cannot be used to browse,
-- enumerate, or guess other projects, and it grants no write access
-- (WITH CHECK still requires the normal tenant_id match).
ALTER TABLE projects DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS projects_isolation ON projects;

CREATE POLICY projects_isolation ON projects
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)::uuid
    OR (
      public_widget_enabled = true
      AND public_api_key IS NOT NULL
      AND public_api_key = current_setting('app.lookup_public_api_key', true)
    )
  )
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;

-- Down Migration

ALTER TABLE projects DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS projects_isolation ON projects;

CREATE POLICY projects_isolation ON projects
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
