-- Up Migration
--
-- Adds a per-project public API key + origin allowlist so that an external
-- website can submit leads via POST /api/v1/public/projects/:projectPublicKey/leads
-- without ever being handed tenant/DB credentials. public_api_key is a
-- random opaque token, NOT a tenant id or database secret: it is safe to
-- embed client-side in a <script> tag, is independently rotatable, and is
-- rate-limited at the API layer (see apps/api/src/middleware/rateLimit.ts).
ALTER TABLE projects
  ADD COLUMN public_api_key text,
  ADD COLUMN allowed_origins text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN public_widget_enabled boolean NOT NULL DEFAULT false;

-- Backfill a key for any existing rows so the column can be made unique +
-- (optionally) NOT NULL later without breaking existing projects.
UPDATE projects
SET public_api_key = encode(gen_random_bytes(24), 'hex')
WHERE public_api_key IS NULL;

ALTER TABLE projects
  ADD CONSTRAINT projects_public_api_key_key UNIQUE (public_api_key);

CREATE INDEX idx_projects_public_api_key ON projects (public_api_key);

-- Down Migration

DROP INDEX IF EXISTS idx_projects_public_api_key;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_public_api_key_key;
ALTER TABLE projects
  DROP COLUMN IF EXISTS public_widget_enabled,
  DROP COLUMN IF EXISTS allowed_origins,
  DROP COLUMN IF EXISTS public_api_key;
