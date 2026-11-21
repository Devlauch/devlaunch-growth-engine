-- Up Migration

-- project_profiles holds the business/config context for a project that
-- agents reason over (industry, offering, positioning, goals, etc).
-- One-to-one with projects. Tenant-owned.
CREATE TABLE project_profiles (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  company_name      text,
  industry          text,
  website_url       text,
  value_proposition text,
  target_markets    text[] NOT NULL DEFAULT ARRAY[]::text[],
  goals             jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_profiles_project_id_key UNIQUE (project_id)
);

CREATE TRIGGER trg_project_profiles_set_updated_at
  BEFORE UPDATE ON project_profiles
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_project_profiles_tenant_id ON project_profiles (tenant_id);
CREATE INDEX idx_project_profiles_project_id ON project_profiles (project_id);

-- Down Migration

DROP TABLE IF EXISTS project_profiles;
