-- Up Migration

-- pgcrypto provides gen_random_uuid(), used for all primary keys in this schema.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- uuid-ossp kept available as a fallback/alternative UUID generator.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Shared trigger function: keeps updated_at current on every UPDATE.
-- Every table in this schema that has an updated_at column attaches this
-- trigger (see each table's own migration).
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Down Migration

DROP FUNCTION IF EXISTS set_updated_at();

DROP EXTENSION IF EXISTS "uuid-ossp";
DROP EXTENSION IF EXISTS pgcrypto;
