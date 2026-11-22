-- Up Migration
--
-- Client onboarding + white-label branding: a tenant owner/admin records
-- their industry/goals (captured during onboarding) and a basic
-- white-label profile (logo, brand color, a *requested* subdomain) on
-- their own tenant row.
--
-- `tenants` already has a flexible `settings jsonb` column
-- (002_create_tenants.sql), but these are small, well-typed, individually
-- validated fields the API and dashboard both read/write directly, so they
-- get real typed columns instead of being buried in `settings` — easier to
-- CHECK-constrain (primary_color) and to SELECT/index later if needed.
-- `industry` already exists on this table (002_create_tenants.sql) and is
-- reused as-is; only the four new fields below are added here.
--
-- IMPORTANT — subdomain is NOT infrastructure. `subdomain` is a plain text
-- reference string the tenant requests ("acme" meaning "I would like
-- acme.devlaunchgrowth.example someday"). Nothing in this codebase
-- provisions DNS, TLS certificates, or any actual custom-domain routing for
-- it — that requires real infrastructure this environment doesn't have.
-- The API/UI are explicit that it is "requested, not yet provisioned" (see
-- apps/api/src/routes/tenants.ts and
-- apps/dashboard/src/pages/BrandingPage.tsx) and go live on a custom domain
-- is explicitly a "contact support" step, never a working automated flow.
ALTER TABLE tenants
  ADD COLUMN goals text,
  ADD COLUMN logo_url text,
  ADD COLUMN primary_color text,
  ADD COLUMN subdomain text,
  ADD CONSTRAINT tenants_primary_color_hex_check
    CHECK (primary_color IS NULL OR primary_color ~ '^#[0-9a-fA-F]{6}$'),
  ADD CONSTRAINT tenants_subdomain_format_check
    CHECK (subdomain IS NULL OR subdomain ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

COMMENT ON COLUMN tenants.subdomain IS
  'Requested subdomain reference string only. No DNS/TLS/custom-domain provisioning happens anywhere in this codebase for this value.';

-- Down Migration

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_subdomain_format_check,
  DROP CONSTRAINT IF EXISTS tenants_primary_color_hex_check,
  DROP COLUMN IF EXISTS subdomain,
  DROP COLUMN IF EXISTS primary_color,
  DROP COLUMN IF EXISTS logo_url,
  DROP COLUMN IF EXISTS goals;
