-- Up Migration

-- memberships links a user to a tenant with a role. This is the table the
-- API layer reads at request time to verify a user may act as a given
-- tenant_id before setting app.current_tenant_id (see 013_enable_rls_policies.sql).
CREATE TABLE memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'revoked')),
  invited_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memberships_tenant_user_key UNIQUE (tenant_id, user_id)
);

CREATE TRIGGER trg_memberships_set_updated_at
  BEFORE UPDATE ON memberships
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_memberships_tenant_id ON memberships (tenant_id);
CREATE INDEX idx_memberships_user_id ON memberships (user_id);

-- Down Migration

DROP TABLE IF EXISTS memberships;
