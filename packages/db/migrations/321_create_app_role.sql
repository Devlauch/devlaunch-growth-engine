-- Up Migration
--
-- Milestone 3, Phase 1 critical finding: every migration since
-- 013_enable_rls_policies.sql has carried a comment claiming
-- "FORCE ROW LEVEL SECURITY ... applies even to the table owner" as the
-- reason tenant isolation is safe at the database level. That claim was
-- never actually true for this deployment, because the application has
-- always connected as `devlaunch` — the Postgres Docker image's bootstrap
-- user, which is a REAL SUPERUSER with rolbypassrls=true. Postgres
-- unconditionally bypasses RLS for superusers, full stop, regardless of
-- FORCE ROW LEVEL SECURITY (FORCE only changes behavior for a non-superuser
-- table OWNER, which `devlaunch` also happens to be here — but superuser
-- status alone already defeats RLS before ownership is even considered).
-- Confirmed independently three times during Milestone 3 Phase 1 real-world
-- integration testing (see docs/SECURITY_REVIEW.md's "RLS bypass" entry
-- and docs/INTEGRATION_STATUS.md's cross-cutting tenant-isolation section)
-- via a direct `SELECT rolsuper, rolbypassrls FROM pg_roles` against the
-- running dev container.
--
-- This migration creates a dedicated, NON-superuser, NON-bypassrls login
-- role for the application (apps/api and apps/worker) to connect as
-- instead. `devlaunch` remains the migration-running/table-owning role
-- (superuser is genuinely needed to run arbitrary DDL across migrations,
-- and nothing about owning tables is itself a security problem) — only the
-- APPLICATION's own runtime connection changes, via docker-compose.yml's
-- api/worker service DATABASE_URL (see that file's own comment).
--
-- Because this new role is neither a superuser nor the table owner, it
-- is subject to RLS by default — FORCE ROW LEVEL SECURITY isn't even
-- strictly required for it, but every table already has it set from prior
-- migrations, which is harmless and correct belt-and-suspenders.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'devlaunch_app') THEN
    -- Password is a documented, overridable dev default (same convention as
    -- POSTGRES_PASSWORD's own `devlaunch` default in docker-compose.yml) —
    -- a real deployment overrides APP_DB_PASSWORD via its own env, exactly
    -- like POSTGRES_PASSWORD already is overridden today.
    CREATE ROLE devlaunch_app WITH LOGIN PASSWORD 'devlaunch_app_dev_only_change_me' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO devlaunch_app', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO devlaunch_app;

-- Covers every table created by every prior migration (260+ tables/views).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO devlaunch_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO devlaunch_app;

-- Covers every table/sequence any FUTURE migration creates, as long as it
-- keeps running as the `devlaunch` role (true for every migration so far
-- and for node-pg-migrate's own default connection) — so this migration
-- does not need to be repeated as the schema grows.
ALTER DEFAULT PRIVILEGES FOR ROLE devlaunch IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO devlaunch_app;
ALTER DEFAULT PRIVILEGES FOR ROLE devlaunch IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO devlaunch_app;

-- Down Migration

ALTER DEFAULT PRIVILEGES FOR ROLE devlaunch IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM devlaunch_app;
ALTER DEFAULT PRIVILEGES FOR ROLE devlaunch IN SCHEMA public
  REVOKE USAGE, SELECT ON SEQUENCES FROM devlaunch_app;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM devlaunch_app;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM devlaunch_app;
REVOKE USAGE ON SCHEMA public FROM devlaunch_app;
DO $$
BEGIN
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM devlaunch_app', current_database());
EXCEPTION WHEN undefined_object THEN NULL;
END
$$;
DROP ROLE IF EXISTS devlaunch_app;
