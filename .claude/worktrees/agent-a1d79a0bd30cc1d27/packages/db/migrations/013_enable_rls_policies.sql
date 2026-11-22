-- Up Migration
--
-- Tenant isolation strategy
-- -------------------------
-- Every tenant-owned table is protected by Postgres Row Level Security
-- (RLS). Policies compare each row's tenant_id to the session variable
-- `app.current_tenant_id`.
--
-- IMPORTANT: the API layer is responsible for setting this variable, once
-- per request (or per transaction), AFTER it has verified — via the
-- `memberships` table — that the authenticated user actually belongs to
-- the tenant being acted on. For example, inside the request's DB
-- transaction:
--
--   SELECT set_config('app.current_tenant_id', $1::text, true);  -- true = tx-local
--
-- or, using a parameterized statement:
--
--   SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
--
-- If the variable is never set, current_setting(..., true) returns NULL,
-- and every policy below evaluates to false — i.e. the connection sees no
-- rows. This is the fail-closed default (as opposed to failing open).
--
-- FORCE ROW LEVEL SECURITY is applied on every table so that RLS also
-- applies to the table owner. Connections used by the application should
-- NOT be superuser/BYPASSRLS roles, or these policies would be bypassed
-- entirely.

-- tenants: a tenant can only see its own row. (There is no tenant_id
-- column on tenants itself — it IS the tenant — so the policy compares
-- the row's own id.)
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

CREATE POLICY tenants_isolation ON tenants
  USING (id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (id = current_setting('app.current_tenant_id', true)::uuid);

-- memberships
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;

CREATE POLICY memberships_isolation ON memberships
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- projects
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;

CREATE POLICY projects_isolation ON projects
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- project_profiles
ALTER TABLE project_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_profiles FORCE ROW LEVEL SECURITY;

CREATE POLICY project_profiles_isolation ON project_profiles
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- icp_profiles
ALTER TABLE icp_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE icp_profiles FORCE ROW LEVEL SECURITY;

CREATE POLICY icp_profiles_isolation ON icp_profiles
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- agent_templates: tenant_id is nullable (NULL = global/system template,
-- visible to every tenant). A tenant may see global templates plus its own.
ALTER TABLE agent_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_templates FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_templates_isolation ON agent_templates
  USING (
    tenant_id IS NULL
    OR tenant_id = current_setting('app.current_tenant_id', true)::uuid
  )
  WITH CHECK (
    tenant_id IS NULL
    OR tenant_id = current_setting('app.current_tenant_id', true)::uuid
  );

-- agent_instances
ALTER TABLE agent_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_instances FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_instances_isolation ON agent_instances
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- agent_executions
ALTER TABLE agent_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_executions FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_executions_isolation ON agent_executions
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- approvals
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals FORCE ROW LEVEL SECURITY;

CREATE POLICY approvals_isolation ON approvals
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- audit_events
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_events_isolation ON audit_events
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Down Migration

DROP POLICY IF EXISTS audit_events_isolation ON audit_events;
ALTER TABLE audit_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS approvals_isolation ON approvals;
ALTER TABLE approvals NO FORCE ROW LEVEL SECURITY;
ALTER TABLE approvals DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_executions_isolation ON agent_executions;
ALTER TABLE agent_executions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_executions DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_instances_isolation ON agent_instances;
ALTER TABLE agent_instances NO FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_instances DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_templates_isolation ON agent_templates;
ALTER TABLE agent_templates NO FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_templates DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS icp_profiles_isolation ON icp_profiles;
ALTER TABLE icp_profiles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE icp_profiles DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS project_profiles_isolation ON project_profiles;
ALTER TABLE project_profiles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE project_profiles DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS projects_isolation ON projects;
ALTER TABLE projects NO FORCE ROW LEVEL SECURITY;
ALTER TABLE projects DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS memberships_isolation ON memberships;
ALTER TABLE memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolation ON tenants;
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
ALTER TABLE tenants DISABLE ROW LEVEL SECURITY;
