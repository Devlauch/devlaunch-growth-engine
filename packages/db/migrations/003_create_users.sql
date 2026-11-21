-- Up Migration

-- users is a global account table (a single person can belong to multiple
-- tenants). Tenant scoping for a user happens through the memberships
-- table, not directly on this table.
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  full_name       text,
  password_hash   text,
  avatar_url      text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'disabled')),
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email)
);

CREATE TRIGGER trg_users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_users_status ON users (status);

-- Down Migration

DROP TABLE IF EXISTS users;
