-- Up Migration

-- icp_profiles: one or more Ideal Customer Profile / audience segments per
-- project (e.g. "working professionals re-skilling", "recent CS grads").
-- Tenant-owned.
CREATE TABLE icp_profiles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name            text NOT NULL,
  segment         text,
  description     text,
  pain_points     text[] NOT NULL DEFAULT ARRAY[]::text[],
  channels        text[] NOT NULL DEFAULT ARRAY[]::text[],
  firmographics   jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_primary      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_icp_profiles_set_updated_at
  BEFORE UPDATE ON icp_profiles
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_icp_profiles_tenant_id ON icp_profiles (tenant_id);
CREATE INDEX idx_icp_profiles_project_id ON icp_profiles (project_id);

-- Down Migration

DROP TABLE IF EXISTS icp_profiles;
