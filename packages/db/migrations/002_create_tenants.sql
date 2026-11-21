-- Up Migration

-- tenants is the root multi-tenancy table. Every other tenant-owned table
-- carries a tenant_id FK that (transitively) points back here.
CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL,
  name        text NOT NULL,
  industry    text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenants_slug_key UNIQUE (slug)
);

CREATE TRIGGER trg_tenants_set_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_tenants_status ON tenants (status);

-- Down Migration

DROP TABLE IF EXISTS tenants;
